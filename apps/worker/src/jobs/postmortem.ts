import { causeLabel, correlateOutages, formatDateTime, urlForAi } from "@app/core";
import {
  AiError,
  buildPostmortemPrompt,
  effectiveModel,
  generatePostmortem,
  isAiReady,
} from "@app/core/server";
import { eq, finishAiCall, logEvent, postmortems, reserveAiCall, sql } from "@app/db";
import { loadOutages } from "@app/db/queries";
import type { WorkerContext } from "../context";
import { monthlyAiCalls } from "./ai";

const MAX_ATTEMPTS = 3;

/** อีเมลผู้รับเป็นข้อมูลส่วนบุคคล — ไม่ส่งให้ผู้ให้บริการ AI (สรุปเป็นจำนวนในส่วน notifications แทน) */
export function redactEmails(text: string): string {
  return text.replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi, "<อีเมล>");
}

/** Incident ที่เพิ่งปิด (ภายใน 24 ชม.) และล่มนานพอ → เข้าคิวร่าง postmortem อัตโนมัติ */
export async function enqueuePostmortems(ctx: WorkerContext): Promise<void> {
  const { ai } = await ctx.settings();
  if (!ai.autoPostmortem || !isAiReady(ai, { apiKey: ctx.env.AI_API_KEY, baseUrl: ctx.env.AI_BASE_URL }))
    return;
  await ctx.db.execute(sql`
    INSERT INTO postmortems (incident_id)
    SELECT i.id FROM incidents i
    WHERE i.recovered_at IS NOT NULL AND i.recovered_at > now() - interval '24 hours'
      AND i.recovered_at - i.started_at >= make_interval(mins => ${ai.postmortemMinMinutes})
      AND NOT EXISTS (SELECT 1 FROM postmortems p WHERE p.incident_id = i.id)
    ON CONFLICT DO NOTHING
  `);
}

export async function processPostmortems(ctx: WorkerContext): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE postmortems SET status = 'PENDING' WHERE status = 'RUNNING' AND requested_at < now() - interval '10 minutes'`,
  );
  const claimed = await ctx.db.execute<{ incident_id: number; attempts: number }>(sql`
    WITH next AS (
      SELECT incident_id FROM postmortems WHERE status = 'PENDING' AND requested_at <= now()
      ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE postmortems p SET status = 'RUNNING', attempts = p.attempts + 1, requested_at = now()
    FROM next WHERE p.incident_id = next.incident_id
    RETURNING p.incident_id, p.attempts
  `);
  const job = claimed.rows[0];
  if (!job) return;
  const incidentId = Number(job.incident_id);
  const attempt = Number(job.attempts);
  const settings = await ctx.settings();
  const aiEnv = { apiKey: ctx.env.AI_API_KEY, baseUrl: ctx.env.AI_BASE_URL };
  const tz = ctx.env.APP_TIMEZONE;

  const fail = async (message: string, retry: boolean) => {
    const again = retry && attempt < MAX_ATTEMPTS;
    await ctx.db
      .update(postmortems)
      .set(
        again
          ? { status: "PENDING", error: message, requestedAt: new Date(Date.now() + 3 * 60_000 * attempt) }
          : { status: "FAILED", error: message, completedAt: new Date() },
      )
      .where(eq(postmortems.incidentId, incidentId));
  };

  if (!isAiReady(settings.ai, aiEnv))
    return fail("ยังไม่ได้ตั้งค่า AI (provider / model / AI_API_KEY)", false);
  if (settings.ai.monthlyLimit > 0 && (await monthlyAiCalls(ctx)) >= settings.ai.monthlyLimit)
    return fail(`ใช้ครบโควตาเดือนนี้แล้ว (${settings.ai.monthlyLimit} ครั้ง)`, false);

  const inc = (
    await ctx.db.execute<{
      id: number;
      website_id: number;
      name: string;
      url: string;
      cause: string;
      started_at: Date;
      confirmed_at: Date;
      recovered_at: Date | null;
      failed_check_count: number;
      summary: string | null;
      possible_causes: string[] | null;
      sent: string;
      failed: string;
    }>(sql`
      SELECT i.id, i.website_id, w.name, w.url, i.cause, i.started_at, i.confirmed_at, i.recovered_at, i.failed_check_count,
             a.summary, a.possible_causes,
             (SELECT count(*) FROM notification_events n WHERE n.incident_id = i.id AND n.status = 'SENT')::text AS sent,
             (SELECT count(*) FROM notification_events n WHERE n.incident_id = i.id AND n.status IN ('FAILED','DEAD'))::text AS failed
      FROM incidents i JOIN websites w ON w.id = i.website_id
      LEFT JOIN ai_analyses a ON a.incident_id = i.id AND a.status = 'DONE'
      WHERE i.id = ${incidentId}
    `)
  ).rows[0];
  if (!inc) return fail("ไม่พบ Incident", false);
  const started = new Date(inc.started_at);
  const recovered = inc.recovered_at ? new Date(inc.recovered_at) : null;
  const until = recovered ?? new Date();

  const [events, checks, around] = await Promise.all([
    // เหตุการณ์ช่วงต้น 30 + ช่วงท้าย 15 (ไม่ตัด "กลับมาแล้ว" ทิ้งเมื่อเหตุการณ์เยอะ) · ไม่รวมการส่งอีเมลรายผู้รับ
    ctx.db.execute<{ at: Date; type: string; message: string }>(sql`
      WITH ev AS (
        SELECT id, at, type, message FROM events
        WHERE incident_id = ${incidentId} AND type NOT IN ('EMAIL_SENT', 'EMAIL_FAILED')
      )
      SELECT at, type, message FROM (
        (SELECT * FROM ev ORDER BY at, id LIMIT 30)
        UNION
        (SELECT * FROM ev ORDER BY at DESC, id DESC LIMIT 15)
      ) x ORDER BY at, id
    `),
    ctx.db.execute<{
      checked_at: Date;
      status: string;
      http_status: number | null;
      response_time_ms: number | null;
      error_code: string | null;
      remote_ip: string | null;
    }>(sql`
      -- ผลตรวจช่วงเริ่มล่ม 12 + ช่วงกลับมา 12 (เดิมเอาแค่ 20 ล่าสุด → incident ยาวไม่เห็นตอนเริ่ม)
      WITH c AS (
        SELECT id, checked_at, status, http_status, response_time_ms, error_code, remote_ip FROM check_results
        WHERE website_id = ${inc.website_id} AND checked_at >= ${new Date(started.getTime() - 15 * 60_000)} AND checked_at <= ${new Date(until.getTime() + 5 * 60_000)}
      )
      SELECT checked_at, status, http_status, response_time_ms, error_code, remote_ip FROM (
        (SELECT * FROM c ORDER BY checked_at, id LIMIT 12)
        UNION
        (SELECT * FROM c ORDER BY checked_at DESC, id DESC LIMIT 12)
      ) x ORDER BY checked_at DESC, id DESC
    `),
    loadOutages(ctx.db, {
      from: new Date(started.getTime() - 15 * 60_000),
      to: new Date(started.getTime() + 15 * 60_000),
    }),
  ]);
  const group = correlateOutages(around).find((g) => g.members.some((m) => m.incidentId === incidentId));

  const prompt = buildPostmortemPrompt(
    {
      website: { name: inc.name, url: urlForAi(inc.url) },
      incident: {
        id: incidentId,
        cause: inc.cause,
        startedAt: formatDateTime(started, tz),
        confirmedAt: formatDateTime(new Date(inc.confirmed_at), tz),
        recoveredAt: recovered ? formatDateTime(recovered, tz) : null,
        durationMinutes: Math.round((until.getTime() - started.getTime()) / 60_000),
        failedChecks: inc.failed_check_count,
      },
      timezone: tz,
      events: events.rows.map((e) => ({
        at: formatDateTime(new Date(e.at), tz),
        type: e.type,
        message: redactEmails(e.message),
      })),
      checksNewestFirst: checks.rows.map((c) => ({
        at: formatDateTime(new Date(c.checked_at), tz),
        status: c.status,
        httpStatus: c.http_status,
        responseTimeMs: c.response_time_ms,
        errorCode: c.error_code ? causeLabel(c.error_code, c.http_status) : null,
        remoteIp: c.remote_ip,
      })),
      aiAnalysis: inc.summary ? { summary: inc.summary, possibleCauses: inc.possible_causes ?? [] } : null,
      relatedOutages: group
        ? group.members
            .filter((m) => m.incidentId !== incidentId)
            .map((m) => ({
              website: m.name,
              startedAt: formatDateTime(m.startedAt, tz),
              sharedFactor: group.title,
            }))
        : [],
      notifications: { sent: Number(inc.sent), failed: Number(inc.failed) },
    },
    settings.ai.thai,
  );

  const model = effectiveModel(settings.ai);
  const callId = await reserveAiCall(ctx.db, {
    provider: settings.ai.provider,
    model: model || null,
    monthlyLimit: settings.ai.monthlyLimit,
  });
  if (callId === null) return fail(`ใช้ครบโควตาเดือนนี้แล้ว (${settings.ai.monthlyLimit} ครั้ง)`, false);
  let content: Awaited<ReturnType<typeof generatePostmortem>>;
  try {
    content = await generatePostmortem(settings.ai, aiEnv, prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishAiCall(ctx.db, callId, { success: false, error: message });
    ctx.log.warn("postmortem failed", { incidentId, attempt, error: message });
    return fail(message, err instanceof AiError ? err.retryable : true);
  }
  await finishAiCall(ctx.db, callId, { success: true });
  try {
    await ctx.db
      .update(postmortems)
      .set({
        status: "DONE",
        content,
        provider: settings.ai.provider,
        model,
        error: null,
        completedAt: new Date(),
      })
      .where(eq(postmortems.incidentId, incidentId));
    await logEvent(ctx.db, {
      type: "POSTMORTEM_DONE",
      level: "INFO",
      incidentId,
      websiteId: Number(inc.website_id),
      message: "AI ร่างรายงานสรุปเหตุ (Postmortem) แล้ว",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.warn("postmortem save failed", { incidentId, attempt, error: message });
    await fail(`บันทึกรายงานไม่สำเร็จ: ${message}`, false);
  }
}
