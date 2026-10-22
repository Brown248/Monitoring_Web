import { dayKey } from "@app/core";
import { getState, logEvent, setState, sql } from "@app/db";
import type { WorkerContext } from "../context";

const RUN_AT_HOUR = 3;
const RUN_AT_MINUTE = 30;

function localHm(tz: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  return {
    h: Number(parts.find((p) => p.type === "hour")?.value),
    m: Number(parts.find((p) => p.type === "minute")?.value),
  };
}

/** ลบเป็น batch เพื่อไม่ล็อกตารางนาน */
async function deleteInBatches(
  ctx: WorkerContext,
  table: string,
  where: ReturnType<typeof sql>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const res = await ctx.db.execute(
      sql`DELETE FROM ${sql.raw(table)} WHERE ctid IN (SELECT ctid FROM ${sql.raw(table)} WHERE ${where} LIMIT 10000)`,
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < 10000) break;
  }
  return total;
}

export async function runRetention(ctx: WorkerContext): Promise<Record<string, number>> {
  const { retention } = await ctx.settings();
  const removed: Record<string, number> = {};
  // ประวัติสแกนความปลอดภัยเก็บ 180 วัน (ผลล่าสุดของแต่ละเว็บไม่ลบ) · alert ที่รับทราบแล้วเก็บ 1 ปี
  removed.security_scans = await deleteInBatches(
    ctx,
    "security_scans",
    sql`scanned_at < now() - interval '180 days'
        AND id NOT IN (SELECT DISTINCT ON (website_id) id FROM security_scans ORDER BY website_id, scanned_at DESC)`,
  );
  removed.security_alerts = await deleteInBatches(
    ctx,
    "security_alerts",
    sql`acknowledged_at IS NOT NULL AND created_at < now() - interval '365 days'`,
  );
  // ไทม์ไลน์การเปลี่ยนแปลงเก็บ 1 ปี · ผลวินิจฉัย/ผลทดสอบใช้งานจริงเก็บ 90 วัน (ภาพหน้าจอใหญ่ → 14 วัน)
  removed.site_changes = await deleteInBatches(ctx, "site_changes", sql`at < now() - interval '365 days'`);
  removed.diagnoses = await deleteInBatches(ctx, "diagnoses", sql`created_at < now() - interval '90 days'`);
  removed.journey_runs = await deleteInBatches(
    ctx,
    "journey_runs",
    sql`started_at < now() - interval '90 days'`,
  );
  await ctx.db.execute(
    sql`UPDATE journey_runs SET screenshot = NULL WHERE screenshot IS NOT NULL AND started_at < now() - interval '14 days'`,
  );
  removed.check_results = await deleteInBatches(
    ctx,
    "check_results",
    sql`checked_at < now() - make_interval(days => ${retention.checksDays})
        AND id NOT IN (
          SELECT x FROM incidents i, unnest(array[i.first_failure_check_id, i.confirm_check_id, i.recovery_check_id]) AS x
          WHERE x IS NOT NULL
        )
        AND id NOT IN (SELECT last_result_id FROM website_state WHERE last_result_id IS NOT NULL)
        -- ผลตรวจแรกของ streak ที่ยังค้าง จะถูกอ้างตอนเปิด Incident (FK) — ห้ามลบ
        AND id NOT IN (SELECT failure_streak_first_check_id FROM website_state WHERE failure_streak_first_check_id IS NOT NULL)`,
  );
  if (retention.dailySummaryDays > 0) {
    removed.daily_summaries = await deleteInBatches(
      ctx,
      "daily_summaries",
      sql`day < current_date - ${retention.dailySummaryDays}::int`,
    );
  }
  if (retention.incidentDays > 0) {
    removed.incidents = await deleteInBatches(
      ctx,
      "incidents",
      sql`recovered_at IS NOT NULL AND recovered_at < now() - make_interval(days => ${retention.incidentDays})`,
    );
  }
  removed.events = await deleteInBatches(
    ctx,
    "events",
    sql`incident_id IS NULL AND at < now() - make_interval(days => ${retention.checksDays})`,
  );
  removed.canary_results = await deleteInBatches(ctx, "canary_results", sql`at < now() - interval '7 days'`);
  removed.heartbeat_slots = await deleteInBatches(
    ctx,
    "heartbeat_slots",
    sql`slot < now() - interval '7 days'`,
  );
  removed.sessions = await deleteInBatches(ctx, "sessions", sql`expires_at < now()`);
  removed.job_requests = await deleteInBatches(
    ctx,
    "job_requests",
    sql`created_at < now() - interval '30 days' AND status <> 'PENDING'`,
  );
  removed.integration_sync_logs = await deleteInBatches(
    ctx,
    "integration_sync_logs",
    sql`started_at < now() - interval '90 days'`,
  );
  removed.ai_calls = await deleteInBatches(ctx, "ai_calls", sql`at < now() - interval '400 days'`);
  // Worker ที่หยุดไปแล้ว (container ใหม่ = workerId ใหม่) — ไม่ให้แถวสะสมไปเรื่อย ๆ
  removed.worker_heartbeats = await deleteInBatches(
    ctx,
    "worker_heartbeats",
    sql`last_seen_at < now() - interval '7 days'`,
  );
  return removed;
}

/** รันวันละครั้งเวลา 03:30 ตาม APP_TIMEZONE */
export async function maybeRunRetention(ctx: WorkerContext): Promise<void> {
  const tz = ctx.env.APP_TIMEZONE;
  const { h, m } = localHm(tz);
  if (h < RUN_AT_HOUR || (h === RUN_AT_HOUR && m < RUN_AT_MINUTE)) return;
  const today = dayKey(new Date(), tz);
  const last = await getState<{ day?: string; failedDay?: string; failures?: number }>(ctx.db, "retention");
  if (last?.day === today) return;
  // ล้มกลางทาง → ลองใหม่รอบถัดไป (ทุกนาที) ได้อีก 3 ครั้ง แทนที่จะข้ามไปถึงพรุ่งนี้ (เดิมบันทึกว่าทำแล้วตั้งแต่ก่อนเริ่ม)
  const failures = last?.failedDay === today ? (last.failures ?? 0) : 0;
  if (failures >= 3) return;
  let removed: Record<string, number>;
  try {
    removed = await runRetention(ctx);
  } catch (err) {
    await setState(ctx.db, "retention", { ...last, failedDay: today, failures: failures + 1 });
    throw err;
  }
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  await setState(ctx.db, "retention", { day: today, finishedAt: new Date().toISOString(), removed });
  await logEvent(ctx.db, {
    type: "RETENTION",
    message: `ล้างข้อมูลเก่าตามนโยบาย Retention ${total.toLocaleString("en-US")} แถว`,
    detail:
      Object.entries(removed)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}: ${n}`)
        .join(", ") || "ไม่มีข้อมูลที่ต้องลบ",
  });
  ctx.log.info("retention done", removed);
}
