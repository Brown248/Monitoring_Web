import {
  buildDownEmail,
  buildRecoveryEmail,
  createMailTransport,
  effectiveFrom,
  isSmtpConfigured,
  sendMail,
  smtpErrorMessage,
} from "@app/core/server";
import { eq, incidents, logEvent, notificationEvents, sql, websites } from "@app/db";
import type { WorkerContext } from "../context";

export const MAX_EMAIL_ATTEMPTS = 12;
/** backoff เป็นนาทีหลังล้มเหลวครั้งที่ 1..11 — รวมราว 16 ชม. (SMTP ล่มข้ามคืนก็ยังส่งได้เมื่อกลับมา) */
const BACKOFF_MIN = [1, 2, 4, 8, 15, 30, 60, 120, 180, 240, 300];
/** ส่งทีละไม่กี่ฉบับ + lease นาน — ส่งช้าสุด ~40 วินาที/ฉบับ จึงไม่เกิน lease (กัน Worker อีกตัวหยิบไปส่งซ้ำ) */
const BATCH = 5;
const LEASE = "10 minutes";

/**
 * อีเมลค้างที่ไม่ควรส่งแล้ว (เช่น เพิ่งตั้ง SMTP หลังติดตั้งไปหลายสัปดาห์ → อีเมลเก่านับร้อยฉบับออกพร้อมกัน)
 * - ยังไม่เคยพยายามส่งและค้างเกิน 24 ชม.
 * - แจ้ง "ล่ม" ที่ค้างเกิน 1 ชม. แต่ Incident ปิดไปแล้ว (เว็บกลับมานานแล้ว)
 * - แจ้ง "กลับมาแล้ว" ที่แจ้ง "ล่ม" ของผู้รับเดียวกันถูกยกเลิกไป (ไม่ส่งข่าวกลับมาของเรื่องที่ไม่เคยแจ้ง)
 * เปลี่ยนเป็น DEAD พร้อมเหตุผล (ยังเห็นในหน้าสถานะระบบ และกดส่งใหม่เองได้)
 */
export async function expireStaleEmails(ctx: WorkerContext): Promise<number> {
  const res = await ctx.db.execute<{ id: number }>(sql`
    WITH stale AS (
      SELECT n.id,
        CASE
          WHEN n.event_type = 'DOWN' AND n.created_at < now() - interval '1 hour'
               AND EXISTS (SELECT 1 FROM incidents i WHERE i.id = n.incident_id AND i.recovered_at IS NOT NULL)
            THEN 'ไม่ส่งแล้ว — Incident ปิดไปแล้วก่อนส่งได้'
          ELSE 'ไม่ส่งแล้ว — ค้างในคิวเกิน 24 ชม. (เช่น เพิ่งตั้งค่า SMTP)'
        END AS reason
      FROM notification_events n
      WHERE n.status IN ('PENDING', 'FAILED') AND n.attempts = 0
        AND (
          n.created_at < now() - interval '24 hours'
          OR (n.event_type = 'DOWN' AND n.created_at < now() - interval '1 hour'
              AND EXISTS (SELECT 1 FROM incidents i WHERE i.id = n.incident_id AND i.recovered_at IS NOT NULL))
        )
      FOR UPDATE OF n SKIP LOCKED
    )
    UPDATE notification_events n SET status = 'DEAD', last_error = stale.reason
    FROM stale WHERE n.id = stale.id
    RETURNING n.id
  `);
  const orphanRecovery = await ctx.db.execute<{ id: number }>(sql`
    UPDATE notification_events n SET status = 'DEAD', last_error = 'ไม่ส่งแล้ว — ไม่ได้แจ้งว่าล่มกับผู้รับนี้'
    WHERE n.status IN ('PENDING', 'FAILED') AND n.event_type = 'RECOVERY' AND n.attempts = 0
      AND EXISTS (
        SELECT 1 FROM notification_events d
        WHERE d.incident_id = n.incident_id AND d.recipient = n.recipient AND d.event_type = 'DOWN'
          AND d.status = 'DEAD' AND d.sent_at IS NULL
      )
    RETURNING n.id
  `);
  const total = res.rows.length + orphanRecovery.rows.length;
  if (total > 0)
    await logEvent(ctx.db, {
      type: "EMAIL_EXPIRED",
      level: "WARN",
      message: `ยกเลิกอีเมลค้างเก่า ${total} ฉบับ (ไม่ส่งข่าวที่ล้าสมัยแล้ว)`,
      detail: "ดูรายการและกดส่งใหม่ได้ที่หน้าสถานะระบบ",
    });
  return total;
}

/**
 * กำลังปิด Worker — ส่งฉบับที่กำลังส่งให้จบ แล้วคืนฉบับที่ claim ไว้แต่ยังไม่ได้ส่งกลับเข้าคิวทันที
 * (เดิมต้องรอ lease 10 นาที และถ้าถูก kill กลางชุด ฉบับที่ส่งไปแล้วแต่ยังไม่บันทึกจะถูกส่งซ้ำ)
 */
let stopping = false;
export function stopDispatching(): void {
  stopping = true;
}

/** งานฐานข้อมูลที่ต้องสำเร็จ (เช่น บันทึกว่าส่งอีเมลแล้ว) — ลองซ้ำ 3 ครั้ง เว้น 1, 2 วินาที */
async function retryDb(fn: () => Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await fn();
      return true;
    } catch {
      if (i < 2) await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
    }
  }
  return false;
}

interface DueRow extends Record<string, unknown> {
  id: number;
  incident_id: number;
  event_type: "DOWN" | "RECOVERY";
  recipient: string;
  attempts: number;
}

/**
 * claim งานที่ถึงเวลา (SKIP LOCKED) และเลื่อนเวลาออกไปเป็น lease กันส่งซ้ำระหว่างกำลังส่ง
 * RECOVERY รอจนกว่า DOWN ของผู้รับคนเดียวกันจะส่งแล้ว/เลิกส่ง — ไม่ให้ "กลับมาแล้ว" มาถึงก่อน "ล่ม"
 */
async function claimDue(ctx: WorkerContext, limit: number): Promise<DueRow[]> {
  const res = await ctx.db.execute<DueRow>(sql`
    WITH due AS (
      SELECT x.id FROM notification_events x
      WHERE x.status IN ('PENDING', 'FAILED') AND x.next_attempt_at <= now()
        AND NOT (
          x.event_type = 'RECOVERY' AND EXISTS (
            SELECT 1 FROM notification_events d
            WHERE d.incident_id = x.incident_id AND d.recipient = x.recipient
              AND d.event_type = 'DOWN' AND d.status IN ('PENDING', 'FAILED')
          )
        )
      ORDER BY x.next_attempt_at
      LIMIT ${limit}
      FOR UPDATE OF x SKIP LOCKED
    )
    UPDATE notification_events n
    SET next_attempt_at = now() + ${LEASE}::interval
    FROM due WHERE n.id = due.id
    RETURNING n.id, n.incident_id, n.event_type, n.recipient, n.attempts
  `);
  return res.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    incident_id: Number(r.incident_id),
    attempts: Number(r.attempts),
  }));
}

export async function dispatchNotifications(ctx: WorkerContext): Promise<number> {
  const settings = await ctx.settings();
  const smtp = settings.smtp;
  // ยังไม่ได้ตั้งค่า SMTP → เก็บอีเมลไว้ในคิว ไม่นับเป็นการส่งล้มเหลว (ไม่งั้นครบจำนวนครั้งแล้วอีเมลหายไปเลย)
  if (!isSmtpConfigured(smtp)) return 0;
  await expireStaleEmails(ctx);
  const due = await claimDue(ctx, BATCH);
  if (due.length === 0) return 0;

  const transport = createMailTransport(smtp, ctx.env.SMTP_PASSWORD, {
    allowedHosts: ctx.env.SMTP_ALLOWED_HOST,
  });
  let sent = 0;

  const done = new Set<number>();
  try {
    for (const n of due) {
      if (stopping) break;
      done.add(n.id);
      const [info] = await ctx.db
        .select({
          incidentId: incidents.id,
          websiteId: websites.id,
          websiteName: websites.name,
          url: websites.url,
          cause: incidents.cause,
          startedAt: incidents.startedAt,
          confirmedAt: incidents.confirmedAt,
          recoveredAt: incidents.recoveredAt,
        })
        .from(incidents)
        .innerJoin(websites, eq(websites.id, incidents.websiteId))
        .where(eq(incidents.id, n.incident_id));
      if (!info) continue;

      const attempt = n.attempts + 1;
      let res: Awaited<ReturnType<typeof sendMail>>;
      try {
        const data = { ...info, appBaseUrl: ctx.env.APP_BASE_URL, timeZone: ctx.env.APP_TIMEZONE };
        const msg = n.event_type === "DOWN" ? buildDownEmail(data) : buildRecoveryEmail(data);
        res = await sendMail(transport, effectiveFrom(smtp), { ...msg, to: n.recipient });
      } catch (err) {
        const message = smtpErrorMessage(err);
        const dead = attempt >= MAX_EMAIL_ATTEMPTS;
        const delayMin = BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)]!;
        await ctx.db
          .update(notificationEvents)
          .set({
            status: dead ? "DEAD" : "FAILED",
            attempts: attempt,
            lastError: message,
            nextAttemptAt: new Date(Date.now() + delayMin * 60_000),
          })
          .where(eq(notificationEvents.id, n.id));
        await logEvent(ctx.db, {
          type: "EMAIL_FAILED",
          level: "ERROR",
          incidentId: n.incident_id,
          websiteId: info.websiteId,
          message: `ส่งอีเมล ${n.event_type} ถึง ${n.recipient} ไม่สำเร็จ (ครั้งที่ ${attempt})`,
          detail: dead
            ? `${message} · ครบ ${MAX_EMAIL_ATTEMPTS} ครั้ง เลิกส่งอัตโนมัติ`
            : `${message} · retry ใน ${delayMin} นาที`,
        });
        ctx.log.warn("email failed", { notificationId: n.id, attempt, error: message });
        continue;
      }
      // ส่งออกไปแล้ว — บันทึก SENT ให้ได้ (ลองซ้ำเมื่อฐานข้อมูลสะดุด) ห้ามตีเป็น "ส่งไม่สำเร็จ" แล้วส่งซ้ำ
      sent++;
      const recorded = await retryDb(() =>
        ctx.db
          .update(notificationEvents)
          .set({
            status: "SENT",
            attempts: attempt,
            sentAt: new Date(),
            smtpResponse: res.response,
            lastError: null,
          })
          .where(eq(notificationEvents.id, n.id)),
      );
      if (!recorded) {
        ctx.log.error("email sent but could not be marked SENT (may be resent after the lease)", {
          notificationId: n.id,
        });
        continue;
      }
      await logEvent(ctx.db, {
        type: "EMAIL_SENT",
        level: "SUCCESS",
        incidentId: n.incident_id,
        websiteId: info.websiteId,
        message: `ส่งอีเมล ${n.event_type} ถึง ${n.recipient}`,
        detail: res.response || "SMTP OK",
      }).catch(() => undefined);
    }
  } finally {
    transport.close();
    const left = due.filter((n) => !done.has(n.id)).map((n) => n.id);
    if (left.length > 0)
      await ctx.db
        .execute(
          sql`UPDATE notification_events SET next_attempt_at = now() WHERE id IN (${sql.join(
            left.map((id) => sql`${id}`),
            sql`, `,
          )}) AND status IN ('PENDING', 'FAILED')`,
        )
        .catch(() => undefined);
  }
  return sent;
}
