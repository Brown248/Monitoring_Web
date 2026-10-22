import "server-only";
import { statfs } from "node:fs/promises";
import type { SettingsMap } from "@app/core";
import { effectiveModel, isAiReady, isSmtpConfigured, parseServiceAccount } from "@app/core/server";
import { getAllSettings, sql } from "@app/db";
import { getDb } from "../db";
import { getEnv } from "../env";

export type Health = "ok" | "warn" | "error" | "off";

export interface WorkerHealth {
  health: Health;
  lastSeenAt: Date | null;
  startedAt: Date | null;
  lastCycleChecks: number | null;
  lastCycleMs: number | null;
  checksLast5m: number;
}

const HEARTBEAT_STALE_MS = 90_000;

export async function workerHealth(): Promise<WorkerHealth> {
  const res = await getDb().execute<{
    last_seen_at: Date | null;
    started_at: Date | null;
    last_cycle_checks: number | null;
    last_cycle_ms: number | null;
    checks_5m: string;
    age_ms: string | null;
  }>(sql`
    SELECT h.last_seen_at, h.started_at, h.last_cycle_checks, h.last_cycle_ms,
           -- อายุของ heartbeat วัดด้วยนาฬิกาของฐานข้อมูล (Worker เขียน now() ของ DB) — นาฬิกาเครื่องเว็บเพี้ยนก็ไม่ดูเหมือน Worker ตาย
           (extract(epoch FROM now() - h.last_seen_at) * 1000)::bigint::text AS age_ms,
           (SELECT count(*) FROM check_results WHERE checked_at >= now() - interval '5 minutes')::text AS checks_5m
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1) h ON true
  `);
  const r = res.rows[0];
  const lastSeenAt = r?.last_seen_at ? new Date(r.last_seen_at) : null;
  const fresh = lastSeenAt !== null && Number(r?.age_ms ?? Infinity) < HEARTBEAT_STALE_MS;
  return {
    health: lastSeenAt === null ? "off" : fresh ? "ok" : "error",
    lastSeenAt,
    startedAt: r?.started_at ? new Date(r.started_at) : null,
    lastCycleChecks: r?.last_cycle_checks ?? null,
    lastCycleMs: r?.last_cycle_ms ?? null,
    checksLast5m: Number(r?.checks_5m ?? 0),
  };
}

export async function dbLatencyMs(): Promise<number> {
  const t0 = performance.now();
  await getDb().execute(sql`select 1`);
  return Math.round(performance.now() - t0);
}

export interface CanaryHealth {
  health: Health;
  targets: Array<{ target: string; ok: boolean; at: Date }>;
  lastFailureAt: Date | null;
  lastFailureError: string | null;
}

export async function canaryHealth(): Promise<CanaryHealth> {
  const db = getDb();
  const latest = await db.execute<{ target: string; ok: boolean; at: Date }>(sql`
    SELECT DISTINCT ON (target) target, ok, at FROM canary_results
    WHERE at >= now() - interval '10 minutes' ORDER BY target, at DESC
  `);
  const fail = await db.execute<{ at: Date; error: string | null }>(sql`
    SELECT at, error FROM canary_results WHERE NOT ok ORDER BY at DESC LIMIT 1
  `);
  const targets = latest.rows.map((r) => ({ target: r.target, ok: r.ok, at: new Date(r.at) }));
  const okCount = targets.filter((t) => t.ok).length;
  return {
    health:
      targets.length === 0 ? "off" : okCount === targets.length ? "ok" : okCount === 0 ? "error" : "warn",
    targets,
    lastFailureAt: fail.rows[0] ? new Date(fail.rows[0].at) : null,
    lastFailureError: fail.rows[0]?.error ?? null,
  };
}

export interface OutboxHealth {
  health: Health;
  smtpConfigured: boolean;
  passwordSet: boolean;
  pending: number;
  failed: number;
  dead: number;
  nextRetryAt: Date | null;
  sent24h: number;
}

export async function outboxHealth(settings: SettingsMap): Promise<OutboxHealth> {
  const res = await getDb().execute<{
    pending: string;
    failed: string;
    dead: string;
    next_retry: Date | null;
    sent_24h: string;
  }>(sql`
    SELECT count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
           count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
           count(*) FILTER (WHERE status = 'DEAD')::text AS dead,
           min(next_attempt_at) FILTER (WHERE status IN ('PENDING', 'FAILED')) AS next_retry,
           count(*) FILTER (WHERE status = 'SENT' AND sent_at >= now() - interval '24 hours')::text AS sent_24h
    FROM notification_events
  `);
  const r = res.rows[0]!;
  const configured = isSmtpConfigured(settings.smtp);
  const pending = Number(r.pending);
  const failed = Number(r.failed);
  const dead = Number(r.dead);
  return {
    health: !configured ? "off" : dead > 0 || failed > 0 ? "warn" : pending > 0 ? "warn" : "ok",
    smtpConfigured: configured,
    passwordSet: Boolean(getEnv().SMTP_PASSWORD),
    pending,
    failed,
    dead,
    nextRetryAt: r.next_retry ? new Date(r.next_retry) : null,
    sent24h: Number(r.sent_24h),
  };
}

export interface AiHealth {
  health: Health;
  provider: string;
  model: string;
  keySet: boolean;
  callsThisMonth: number;
  monthlyLimit: number;
  lastFailureAt: Date | null;
  lastFailureError: string | null;
  running: number;
}

export async function aiHealth(settings: SettingsMap): Promise<AiHealth> {
  const env = getEnv();
  const res = await getDb().execute<{
    calls: string;
    fail_at: Date | null;
    fail_error: string | null;
    running: string;
  }>(sql`
    SELECT (SELECT count(*) FROM ai_calls WHERE at >= date_trunc('month', now()))::text AS calls,
           (SELECT at FROM ai_calls WHERE NOT success ORDER BY at DESC LIMIT 1) AS fail_at,
           (SELECT error FROM ai_calls WHERE NOT success ORDER BY at DESC LIMIT 1) AS fail_error,
           (SELECT count(*) FROM ai_analyses WHERE status IN ('PENDING', 'RUNNING'))::text AS running
  `);
  const r = res.rows[0]!;
  const ready = isAiReady(settings.ai, { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL });
  const calls = Number(r.calls);
  const overLimit = settings.ai.monthlyLimit > 0 && calls >= settings.ai.monthlyLimit;
  return {
    health: settings.ai.provider === "none" ? "off" : !ready ? "warn" : overLimit ? "warn" : "ok",
    provider: settings.ai.provider,
    model: effectiveModel(settings.ai),
    keySet: Boolean(env.AI_API_KEY),
    callsThisMonth: calls,
    monthlyLimit: settings.ai.monthlyLimit,
    lastFailureAt: r.fail_at ? new Date(r.fail_at) : null,
    lastFailureError: r.fail_error,
    running: Number(r.running),
  };
}

export interface SheetsHealth {
  health: Health;
  configured: boolean;
  serviceAccountEmail: string | null;
  lastSyncAt: Date | null;
  lastStatus: "SUCCESS" | "FAILED" | null;
  nextSyncAt: Date | null;
  pendingRows: number;
}

export async function sheetsHealth(settings: SettingsMap): Promise<SheetsHealth> {
  const sa = parseServiceAccount(getEnv().GOOGLE_SERVICE_ACCOUNT_JSON);
  const configured = Boolean(sa && settings.sheets.spreadsheetId);
  const res = await getDb().execute<{
    started_at: Date | null;
    status: "SUCCESS" | "FAILED" | null;
    pending: string;
  }>(sql`
    SELECT l.started_at, l.status,
           -- cursor = "เวลาปิด#id" (แบบเก่าเป็นเวลาอย่างเดียว) — เทียบแบบเดียวกับ worker (jobs/sheets.ts)
           (SELECT count(*) FROM incidents i
            WHERE i.recovered_at IS NOT NULL
              AND (date_trunc('milliseconds', i.recovered_at), i.id) > (
                coalesce(split_part(c.cursor, '#', 1)::timestamptz, '1970-01-01'::timestamptz),
                CASE WHEN c.cursor IS NULL THEN 0
                     WHEN position('#' IN c.cursor) = 0 THEN 9007199254740991
                     ELSE split_part(c.cursor, '#', 2)::bigint END
              ))::text AS pending
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT cursor FROM integration_sync_logs
      WHERE integration = 'google_sheets' AND entity_type = 'incidents' AND status = 'SUCCESS'
      ORDER BY started_at DESC LIMIT 1
    ) c ON true
    LEFT JOIN LATERAL (SELECT started_at, status FROM integration_sync_logs WHERE integration = 'google_sheets' ORDER BY started_at DESC LIMIT 1) l ON true
  `);
  const r = res.rows[0]!;
  const lastSyncAt = r.started_at ? new Date(r.started_at) : null;
  const period =
    settings.sheets.interval === "hourly"
      ? 3_600_000
      : settings.sheets.interval === "daily"
        ? 86_400_000
        : null;
  return {
    health: !configured ? "off" : r.status === "FAILED" ? "warn" : "ok",
    configured,
    serviceAccountEmail: sa?.client_email ?? null,
    lastSyncAt,
    lastStatus: r.status,
    nextSyncAt:
      configured && period
        ? new Date((lastSyncAt?.getTime() ?? Date.now()) + (lastSyncAt ? period : 60_000))
        : null,
    pendingRows: settings.sheets.sendIncidents ? Number(r.pending) : 0,
  };
}

export interface BackupHealth {
  health: Health;
  /** ผลครั้งล่าสุด (สำเร็จหรือไม่ก็ตาม) */
  last: {
    at: Date;
    ok: boolean;
    sizeBytes: number | null;
    destination: string | null;
    message: string | null;
  } | null;
  lastOkAt: Date | null;
  /** backup สำเร็จล่าสุดเก่าเกินกำหนด (หรือไม่เคยสำเร็จ) */
  stale: boolean;
  detail: string;
}

/** backup รันทุกคืน — เกิน 36 ชม. แปลว่าพลาดไปอย่างน้อย 1 คืน */
export const BACKUP_STALE_HOURS = 36;

export async function backupHealth(): Promise<BackupHealth> {
  const res = await getDb().execute<{
    started_at: Date | null;
    ok: boolean | null;
    size_bytes: string | null;
    destination: string | null;
    message: string | null;
    last_ok_at: Date | null;
  }>(sql`
    SELECT l.started_at, l.ok, l.size_bytes::text AS size_bytes, l.destination, l.message,
           (SELECT max(started_at) FROM backup_runs WHERE ok) AS last_ok_at
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT started_at, ok, size_bytes, destination, message FROM backup_runs ORDER BY started_at DESC LIMIT 1
    ) l ON true
  `);
  const r = res.rows[0]!;
  const last = r.started_at
    ? {
        at: new Date(r.started_at),
        ok: Boolean(r.ok),
        sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
        destination: r.destination,
        message: r.message,
      }
    : null;
  const lastOkAt = r.last_ok_at ? new Date(r.last_ok_at) : null;
  const stale = !lastOkAt || Date.now() - lastOkAt.getTime() > BACKUP_STALE_HOURS * 3_600_000;
  const health: Health = !last ? "warn" : !last.ok ? "error" : stale ? "warn" : "ok";
  const detail = !last
    ? "ยังไม่เคย backup — ตั้ง cron ให้รัน scripts/backup-db.sh"
    : !last.ok
      ? `backup ล่าสุดล้มเหลว${last.message ? `: ${last.message}` : ""}`
      : stale
        ? `ไม่มี backup ใหม่เกิน ${BACKUP_STALE_HOURS} ชม. — ตรวจ cron / backups/backup.log`
        : "ปกติ";
  return { health, last, lastOkAt, stale, detail };
}

export async function loadSettings(): Promise<SettingsMap> {
  return getAllSettings(getDb());
}

export async function diskUsage(): Promise<{ usedBytes: number; totalBytes: number } | null> {
  try {
    const s = await statfs(process.platform === "win32" ? process.cwd().slice(0, 3) : "/");
    const total = s.blocks * s.bsize;
    return { totalBytes: total, usedBytes: total - s.bavail * s.bsize };
  } catch {
    return null;
  }
}
