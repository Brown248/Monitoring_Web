import {
  buildSecurityAlertEmail,
  createMailTransport,
  effectiveFrom,
  isSmtpConfigured,
  sendMail,
  smtpErrorMessage,
} from "@app/core/server";
import { mergeRecipients } from "@app/core";
import { eq, securityAlerts, sql } from "@app/db";
import type { WorkerContext } from "../context";

/**
 * ส่งครั้งที่ n ได้เมื่อผ่านไป RETRY_AT_MIN[n] นาทีนับจากเกิด alert (backoff แบบสะสม — ไม่ต้องมีคอลัมน์เวลาเพิ่ม)
 * SMTP ล่มไม่กี่นาทีไม่ทำให้ใช้ครบทุกครั้งแล้วเลิกส่ง (เดิม 6 ครั้งติดกันทุก 30 วินาที = 3 นาที)
 */
const RETRY_AT_MIN = [0, 1, 3, 7, 15, 30, 60, 120, 240, 480, 960, 1440];
const MAX_ATTEMPTS = RETRY_AT_MIN.length;
const NO_RECIPIENT =
  "ยังไม่มีผู้รับ — ตั้งผู้รับในหน้าตั้งค่า > ความปลอดภัย (จะส่งให้อัตโนมัติเมื่อมีผู้รับภายใน 2 วัน)";

function detailRows(type: string, d: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (type === "VISUAL_CHANGE")
    rows.push(["ต่างจากต้นแบบ", `${String(d.diffPct)}% (เกณฑ์ ${String(d.thresholdPct)}%)`]);
  if (type === "DEFACE_KEYWORD" && Array.isArray(d.keywords)) rows.push(["คำที่พบ", d.keywords.join(", ")]);
  if (typeof d.pageTitle === "string" && d.pageTitle) rows.push(["หัวข้อหน้า", d.pageTitle]);
  if (type === "LOOKALIKE_DOMAIN") {
    rows.push(["โดเมน", String(d.domain)]);
    rows.push(["ลักษณะ", d.similarity === "typo" ? "สะกดคล้าย (typosquatting)" : "มีชื่อแบรนด์อยู่ในโดเมน"]);
    if (d.issuer) rows.push(["ออกใบรับรองโดย", String(d.issuer)]);
  }
  if (type === "SITE_CHANGE") {
    rows.push(["ค่าเดิม", String(d.oldValue ?? "—")]);
    rows.push(["ค่าใหม่", String(d.newValue ?? "—")]);
  }
  if ((type === "ANOMALY_SLOW" || type === "ANOMALY_UNSTABLE" || type === "JOURNEY_FAILED") && d.detail)
    rows.push(["รายละเอียด", String(d.detail)]);
  if (type === "SECURITY_FINDING") {
    if (d.detail) rows.push(["รายละเอียด", String(d.detail)]);
    if (d.fix) rows.push(["วิธีแก้", String(d.fix)]);
  }
  return rows;
}

/** ส่งอีเมลแจ้งเตือนด้านความปลอดภัยที่ยังไม่ได้ส่ง (ผู้รับของเว็บ + ผู้รับด้านความปลอดภัย) */
export async function dispatchSecurityAlerts(ctx: WorkerContext): Promise<void> {
  const settings = await ctx.settings();
  if (!isSmtpConfigured(settings.smtp)) return;
  const globalList = mergeRecipients(settings.security.alertEmails, settings.smtp.alertEmails);
  const globalRecipients = globalList.length > 0;
  // ไม่มีผู้รับ: ไม่ปิด alert ถาวร (เดิมตั้ง notified_at) — แค่บอกเหตุผล แล้วส่งเมื่อเพิ่มผู้รับ
  if (!globalRecipients)
    await ctx.db.execute(sql`
      UPDATE security_alerts a SET notify_error = ${NO_RECIPIENT}
      FROM websites w
      WHERE w.id = a.website_id AND a.notified_at IS NULL AND a.notify_error IS NULL
        AND coalesce(cardinality(w.alert_emails), 0) = 0
    `);
  const retryAt = sql.raw(`ARRAY[${RETRY_AT_MIN.join(",")}]`);
  const due = await ctx.db.execute<{
    id: number;
    type: string;
    severity: string;
    title: string;
    detail: Record<string, unknown> | null;
    created_at: Date;
    notify_attempts: number;
    name: string | null;
    url: string | null;
    alert_emails: string[] | null;
    website_id: number | null;
  }>(sql`
    SELECT a.id, a.website_id, a.type, a.severity, a.title, a.detail, a.created_at, a.notify_attempts, w.name, w.url, w.alert_emails
    FROM security_alerts a LEFT JOIN websites w ON w.id = a.website_id
    WHERE a.notified_at IS NULL AND a.acknowledged_at IS NULL AND a.notify_attempts < ${MAX_ATTEMPTS}
      AND a.created_at > now() - interval '2 days'
      AND now() >= a.created_at + make_interval(mins => (${retryAt})[a.notify_attempts + 1])
      -- เว็บที่เก็บเข้าคลัง/ปิดการตรวจแล้ว ไม่ต้องแจ้ง
      AND (a.website_id IS NULL OR (w.archived_at IS NULL AND w.enabled))
      AND (${globalRecipients} OR coalesce(cardinality(w.alert_emails), 0) > 0)
    ORDER BY a.created_at LIMIT 10
  `);
  if (due.rows.length === 0) return;
  const transport = createMailTransport(settings.smtp, ctx.env.SMTP_PASSWORD, {
    allowedHosts: ctx.env.SMTP_ALLOWED_HOST,
  });
  try {
    for (const a of due.rows) {
      const recipients = mergeRecipients(a.alert_emails, globalList);
      if (recipients.length === 0) continue; // กรองใน SQL แล้ว — กันไว้อีกชั้น
      const mail = buildSecurityAlertEmail({
        alertId: Number(a.id),
        type: a.type,
        severity: a.severity,
        title: a.title,
        websiteName: a.name,
        url: a.url,
        createdAt: new Date(a.created_at),
        details: detailRows(a.type, a.detail ?? {}),
        appBaseUrl: ctx.env.APP_BASE_URL,
        timeZone: ctx.env.APP_TIMEZONE,
        websiteId: a.website_id === null ? null : Number(a.website_id),
      });
      try {
        await sendMail(transport, effectiveFrom(settings.smtp), { ...mail, to: recipients.join(", ") });
        await ctx.db
          .update(securityAlerts)
          .set({ notifiedAt: new Date(), notifyError: null, notifyAttempts: Number(a.notify_attempts) + 1 })
          .where(eq(securityAlerts.id, Number(a.id)));
      } catch (err) {
        await ctx.db
          .update(securityAlerts)
          .set({ notifyAttempts: Number(a.notify_attempts) + 1, notifyError: smtpErrorMessage(err) })
          .where(eq(securityAlerts.id, Number(a.id)));
      }
    }
  } finally {
    transport.close();
  }
}
