import "server-only";
import { sql } from "@app/db";
import { getDb } from "../db";

export type BeatStatus = "up" | "slow" | "down" | "unknown";

export interface Beat {
  id: number;
  at: Date;
  status: BeatStatus;
  ms: number | null;
  http: number | null;
  error: string | null;
}

export interface Heartbeats {
  /** เก่า → ใหม่ (ผลตรวจล่าสุดอยู่ขวาสุด) */
  beats: Beat[];
  /** UP / (UP + DOWN) ของผลตรวจในชุดนี้ */
  uptime: number | null;
  /** สัดส่วนผลตรวจที่ UP แต่ช้ากว่าเกณฑ์ */
  slowRatio: number;
  avgMs: number | null;
  /** เกณฑ์ "ช้า" ที่ใช้กับเว็บนี้ (ms) */
  slowMs: number;
}

/**
 * ผลตรวจล่าสุด N ครั้งของหลายเว็บ (แถบเรียลไทม์แบบ heartbeat — 1 เส้น = ตรวจ 1 ครั้ง)
 * "ช้า" = UP แต่ตอบช้ากว่าเกณฑ์ DEGRADED ของเว็บ (ถ้าตั้งไว้) หรือเกณฑ์เริ่มต้นจากหน้าตั้งค่า
 */
export async function recentHeartbeats(
  ids: number[],
  defaultSlowMs: number,
  limit = 90,
): Promise<Map<number, Heartbeats>> {
  const out = new Map<number, Heartbeats>();
  if (ids.length === 0) return out;
  const idList = sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  );
  const res = await getDb().execute<{
    website_id: number;
    slow_ms: number;
    id: number;
    checked_at: Date;
    status: "UP" | "DOWN" | "UNKNOWN";
    degraded: boolean;
    response_time_ms: number | null;
    http_status: number | null;
    error_code: string | null;
  }>(sql`
    SELECT w.id AS website_id, coalesce(w.degraded_threshold_ms, ${defaultSlowMs})::int AS slow_ms,
           c.id, c.checked_at, c.status, c.degraded, c.response_time_ms, c.http_status, c.error_code
    FROM websites w
    CROSS JOIN LATERAL (
      SELECT id, checked_at, status, degraded, response_time_ms, http_status, error_code
      FROM check_results WHERE website_id = w.id ORDER BY checked_at DESC LIMIT ${limit}
    ) c
    WHERE w.id IN (${idList})
  `);
  const byId = new Map<number, { slowMs: number; rows: typeof res.rows }>();
  for (const r of res.rows) {
    const id = Number(r.website_id);
    const e = byId.get(id) ?? { slowMs: Number(r.slow_ms), rows: [] };
    e.rows.push(r);
    byId.set(id, e);
  }
  for (const id of ids) {
    const e = byId.get(id);
    const slowMs = e?.slowMs ?? defaultSlowMs;
    const beats: Beat[] = (e?.rows ?? [])
      .map((r) => ({
        id: Number(r.id),
        at: new Date(r.checked_at),
        status: (r.status === "DOWN"
          ? "down"
          : r.status === "UNKNOWN"
            ? "unknown"
            : r.degraded || (r.response_time_ms ?? 0) > slowMs
              ? "slow"
              : "up") as BeatStatus,
        ms: r.response_time_ms,
        http: r.http_status,
        error: r.error_code,
      }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const up = beats.filter((b) => b.status === "up" || b.status === "slow").length;
    const down = beats.filter((b) => b.status === "down").length;
    const slow = beats.filter((b) => b.status === "slow").length;
    const ms = beats.filter((b) => b.status !== "down" && b.ms !== null).map((b) => b.ms!);
    out.set(id, {
      beats,
      uptime: up + down > 0 ? up / (up + down) : null,
      slowRatio: up > 0 ? slow / up : 0,
      avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      slowMs,
    });
  }
  return out;
}
