import "server-only";
import { sql } from "@app/db";
import { getDb } from "../db";

export async function overallUptime24h(): Promise<number | null> {
  const res = await getDb().execute<{ up: string; down: string }>(sql`
    SELECT count(*) FILTER (WHERE c.status = 'UP')::text AS up, count(*) FILTER (WHERE c.status = 'DOWN')::text AS down
    FROM check_results c JOIN websites w ON w.id = c.website_id
    WHERE c.checked_at >= now() - interval '24 hours' AND w.archived_at IS NULL AND w.enabled
  `);
  const up = Number(res.rows[0]?.up ?? 0);
  const down = Number(res.rows[0]?.down ?? 0);
  return up + down > 0 ? up / (up + down) : null;
}

export async function lastCheckAt(): Promise<Date | null> {
  const res = await getDb().execute<{ t: Date | null }>(
    sql`SELECT max(last_checked_at) AS t FROM website_state`,
  );
  return res.rows[0]?.t ? new Date(res.rows[0].t) : null;
}

/** เว็บที่ผลล่าสุดช้ากว่าค่าเฉลี่ย 24 ชม. ของตัวเองเกิน 50% */
export async function slowResponders(limit = 5) {
  const res = await getDb().execute<{
    id: number;
    name: string;
    url: string;
    latest: number;
    avg: string;
  }>(sql`
    SELECT w.id, w.name, w.url, c.response_time_ms AS latest,
           (SELECT avg(x.response_time_ms) FROM check_results x WHERE x.website_id = w.id AND x.status = 'UP' AND x.checked_at >= now() - interval '24 hours')::text AS avg
    FROM websites w
    JOIN website_state s ON s.website_id = w.id
    JOIN check_results c ON c.id = s.last_result_id
    WHERE w.enabled AND w.archived_at IS NULL AND c.status = 'UP' AND c.response_time_ms IS NOT NULL
  `);
  return res.rows
    .map((r) => ({
      id: Number(r.id),
      name: r.name,
      url: r.url,
      latest: Number(r.latest),
      avg: r.avg ? Math.round(Number(r.avg)) : null,
    }))
    .filter((r) => r.avg !== null && r.avg > 0 && r.latest > r.avg * 1.5 && r.latest >= 300)
    .map((r) => ({ ...r, diff: (r.latest - r.avg!) / r.avg! }))
    .sort((a, b) => b.diff - a.diff)
    .slice(0, limit);
}

export const TREND_RANGES = {
  "24h": { hours: 24, bucketMin: 30, label: "24 ชม." },
  "7d": { hours: 168, bucketMin: 180, label: "7 วัน" },
} as const;
export type TrendRange = keyof typeof TREND_RANGES;

export interface TrendBucket {
  /** เวลาเริ่มช่วง (ISO) */
  t: string;
  avg: number | null;
  p95: number | null;
  total: number;
  down: number;
  slow: number;
  /** ชื่อเว็บที่ล้มเหลวในช่วงนี้ */
  downSites: string[];
}

/** เวลาตอบสนองรวมทั้งระบบเป็นช่วง ๆ (เก่า → ใหม่) — ช่วงที่ไม่มีผลตรวจได้ total = 0 */
export async function systemTrend(range: TrendRange, slowMs: number) {
  const { hours, bucketMin } = TREND_RANGES[range];
  const bucketMs = bucketMin * 60_000;
  const count = Math.ceil((hours * 60) / bucketMin);
  // จัดช่วงให้ตรงกับนาฬิกา (เช่น :00, :30) แล้วนับย้อนจากช่วงปัจจุบัน
  const lastStart = Math.floor(Date.now() / bucketMs) * bucketMs;
  const from = new Date(lastStart - (count - 1) * bucketMs);
  const res = await getDb().execute<{
    b: Date;
    avg: string | null;
    p95: string | null;
    total: string;
    down: string;
    slow: string;
    down_sites: string[] | null;
  }>(sql`
    SELECT date_bin(make_interval(mins => ${bucketMin}), c.checked_at, timestamptz '2000-01-01 00:00:00+00') AS b,
           avg(c.response_time_ms) FILTER (WHERE c.status = 'UP')::text AS avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY c.response_time_ms) FILTER (WHERE c.status = 'UP')::text AS p95,
           count(*)::text AS total,
           count(*) FILTER (WHERE c.status = 'DOWN')::text AS down,
           count(*) FILTER (WHERE c.status = 'UP' AND c.response_time_ms > ${slowMs})::text AS slow,
           array_agg(DISTINCT w.name) FILTER (WHERE c.status = 'DOWN') AS down_sites
    FROM check_results c JOIN websites w ON w.id = c.website_id
    WHERE c.checked_at >= ${from} AND w.archived_at IS NULL AND c.status IN ('UP', 'DOWN')
    GROUP BY 1
  `);
  const byStart = new Map(res.rows.map((r) => [new Date(r.b).getTime(), r]));
  const buckets: TrendBucket[] = [];
  for (let i = 0; i < count; i++) {
    const start = from.getTime() + i * bucketMs;
    const r = byStart.get(start);
    buckets.push({
      t: new Date(start).toISOString(),
      avg: r?.avg ? Math.round(Number(r.avg)) : null,
      p95: r?.p95 ? Math.round(Number(r.p95)) : null,
      total: Number(r?.total ?? 0),
      down: Number(r?.down ?? 0),
      slow: Number(r?.slow ?? 0),
      downSites: r?.down_sites ?? [],
    });
  }
  return { buckets, bucketMin };
}

/** เหตุการณ์ที่เป็นงานระบบ/การตั้งค่า — ซ่อนในมุมมอง "สำคัญ" (ยังดูได้ใน "ทั้งหมด") */
export const ROUTINE_EVENT_TYPES = [
  "WEBSITE_CREATED",
  "WEBSITE_UPDATED",
  "WEBSITE_ARCHIVED",
  "WEBSITE_ENABLED",
  "WEBSITE_DISABLED",
  "SETTINGS_UPDATED",
  "USER_CREATED",
  "USER_UPDATED",
  "JOURNEY_UPDATED",
  "DEPENDENCIES_UPDATED",
  "RETENTION",
  "SHEETS_SYNC",
  "SHEETS_EXPORT",
  "OUTBOX_CREATED",
  "EMAIL_SENT",
  "AI_REQUESTED",
  "VISUAL_BASELINE",
];

export interface EventRow {
  id: number;
  at: Date;
  type: string;
  level: string;
  message: string;
  incidentId: number | null;
  websiteId: number | null;
  websiteName: string | null;
}

export async function recentEvents(
  opts: { limit?: number; importantOnly?: boolean } = {},
): Promise<EventRow[]> {
  const res = await getDb().execute<{
    id: number;
    at: Date;
    type: string;
    level: string;
    message: string;
    incident_id: number | null;
    website_id: number | null;
    name: string | null;
  }>(sql`
    SELECT e.id, e.at, e.type, e.level, e.message, e.incident_id, e.website_id, w.name
    FROM events e LEFT JOIN websites w ON w.id = e.website_id AND w.archived_at IS NULL
    ${
      opts.importantOnly
        ? sql`WHERE e.type NOT IN (${sql.join(
            ROUTINE_EVENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )})`
        : sql``
    }
    ORDER BY e.at DESC, e.id DESC LIMIT ${opts.limit ?? 10}
  `);
  return res.rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at),
    type: r.type,
    level: r.level,
    message: r.message,
    incidentId: r.incident_id === null ? null : Number(r.incident_id),
    websiteId: r.website_id === null || r.name === null ? null : Number(r.website_id),
    websiteName: r.name,
  }));
}
