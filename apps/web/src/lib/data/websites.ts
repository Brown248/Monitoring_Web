import "server-only";
import { eq, sql, websites, type Website } from "@app/db";
import { getDb } from "../db";

export type StatusFilter = "all" | "UP" | "DOWN" | "UNKNOWN" | "PENDING" | "disabled";
/** สถานะที่แสดง: PENDING = เพิ่มแล้วแต่ Worker ยังไม่เคยตรวจ (คำนวณ ไม่ได้เก็บใน DB) */
export type DisplayStatus = "UP" | "DOWN" | "UNKNOWN" | "PENDING";
const DISPLAY_STATUS = sql`(CASE WHEN s.last_checked_at IS NULL THEN 'PENDING' ELSE s.status::text END)`;

export interface WebsiteRow {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  checkIntervalSeconds: number;
  status: DisplayStatus;
  lastCheckedAt: Date | null;
  lastHttpStatus: number | null;
  lastResponseMs: number | null;
  lastErrorCode: string | null;
  lastResultStatus: string | null;
  lastDegraded: boolean;
  /** ผลตรวจล่าสุดล้มเหลว แต่ยังไม่ครบเกณฑ์ยืนยัน DOWN */
  failing: boolean;
  uptime24h: number | null;
  /** response เฉลี่ยรายชั่วโมง 24 ช่อง (เก่า → ใหม่), null = ไม่มีผล UP ในชั่วโมงนั้น */
  spark: Array<number | null>;
}

export async function websiteCounts() {
  const res = await getDb().execute<{
    total: string;
    enabled: string;
    disabled: string;
    up: string;
    down: string;
    unknown: string;
    pending: string;
    failing: string;
  }>(sql`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE w.enabled)::text AS enabled,
           count(*) FILTER (WHERE NOT w.enabled)::text AS disabled,
           count(*) FILTER (WHERE w.enabled AND ${DISPLAY_STATUS} = 'UP')::text AS up,
           count(*) FILTER (WHERE w.enabled AND ${DISPLAY_STATUS} = 'DOWN')::text AS down,
           count(*) FILTER (WHERE w.enabled AND ${DISPLAY_STATUS} = 'UNKNOWN')::text AS unknown,
           count(*) FILTER (WHERE w.enabled AND ${DISPLAY_STATUS} = 'PENDING')::text AS pending,
           count(*) FILTER (WHERE w.enabled AND s.status = 'UP' AND s.consecutive_failures > 0)::text AS failing
    FROM websites w JOIN website_state s ON s.website_id = w.id
    WHERE w.archived_at IS NULL
  `);
  const r = res.rows[0]!;
  return {
    total: Number(r.total),
    enabled: Number(r.enabled),
    disabled: Number(r.disabled),
    up: Number(r.up),
    down: Number(r.down),
    unknown: Number(r.unknown),
    pending: Number(r.pending),
    /** ล้มเหลวอยู่แต่ยังไม่ครบเกณฑ์ยืนยัน DOWN */
    failing: Number(r.failing),
  };
}

export async function listWebsites(opts: {
  q?: string;
  status: StatusFilter;
  page: number;
  pageSize: number;
}) {
  const db = getDb();
  const where = [sql`w.archived_at IS NULL`];
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(w.name ILIKE ${like} OR w.url ILIKE ${like})`);
  }
  if (opts.status === "disabled") where.push(sql`NOT w.enabled`);
  else if (opts.status !== "all") where.push(sql`w.enabled AND ${DISPLAY_STATUS} = ${opts.status}`);
  const whereSql = sql.join(where, sql` AND `);

  const totalRes = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM websites w JOIN website_state s ON s.website_id = w.id WHERE ${whereSql}
  `);
  const total = Number(totalRes.rows[0]?.n ?? 0);

  const rows = await db.execute<{
    id: number;
    name: string;
    url: string;
    enabled: boolean;
    check_interval_seconds: number;
    status: DisplayStatus;
    last_checked_at: Date | null;
    http_status: number | null;
    response_time_ms: number | null;
    error_code: string | null;
    result_status: string | null;
    degraded: boolean | null;
    up24: string;
    down24: string;
    failing: boolean;
  }>(sql`
    SELECT w.id, w.name, w.url, w.enabled, w.check_interval_seconds, ${DISPLAY_STATUS} AS status, s.last_checked_at,
           (s.status = 'UP' AND s.consecutive_failures > 0) AS failing,
           c.http_status, c.response_time_ms, c.error_code, c.status AS result_status, c.degraded,
           (SELECT count(*) FROM check_results x WHERE x.website_id = w.id AND x.checked_at >= now() - interval '24 hours' AND x.status = 'UP')::text AS up24,
           (SELECT count(*) FROM check_results x WHERE x.website_id = w.id AND x.checked_at >= now() - interval '24 hours' AND x.status = 'DOWN')::text AS down24
    FROM websites w
    JOIN website_state s ON s.website_id = w.id
    LEFT JOIN check_results c ON c.id = s.last_result_id
    WHERE ${whereSql}
    ORDER BY (CASE WHEN NOT w.enabled THEN 5 WHEN s.status = 'DOWN' THEN 0 WHEN s.status = 'UP' AND s.consecutive_failures > 0 THEN 1 WHEN s.last_checked_at IS NULL THEN 4 WHEN s.status = 'UNKNOWN' THEN 3 ELSE 2 END), w.name, w.id
    LIMIT ${opts.pageSize} OFFSET ${(opts.page - 1) * opts.pageSize}
  `);

  const ids = rows.rows.map((r) => Number(r.id));
  const sparks = new Map<number, Array<number | null>>();
  if (ids.length > 0) {
    const idList = sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    );
    const hourly = await db.execute<{ website_id: number; h: number; avg: string | null }>(sql`
      SELECT website_id, floor(extract(epoch FROM (now() - checked_at)) / 3600)::int AS h,
             avg(response_time_ms) FILTER (WHERE status = 'UP')::text AS avg
      FROM check_results
      WHERE website_id IN (${idList}) AND checked_at >= now() - interval '24 hours'
      GROUP BY 1, 2
    `);
    for (const id of ids) sparks.set(id, new Array(24).fill(null));
    for (const r of hourly.rows) {
      const arr = sparks.get(Number(r.website_id));
      const idx = 23 - Number(r.h);
      if (arr && idx >= 0 && idx < 24) arr[idx] = r.avg ? Math.round(Number(r.avg)) : null;
    }
  }

  const items: WebsiteRow[] = rows.rows.map((r) => {
    const up = Number(r.up24);
    const down = Number(r.down24);
    return {
      id: Number(r.id),
      name: r.name,
      url: r.url,
      enabled: r.enabled,
      checkIntervalSeconds: r.check_interval_seconds,
      status: r.status,
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at) : null,
      lastHttpStatus: r.http_status,
      lastResponseMs: r.response_time_ms,
      lastErrorCode: r.error_code,
      lastResultStatus: r.result_status,
      lastDegraded: Boolean(r.degraded),
      failing: Boolean(r.failing),
      uptime24h: up + down > 0 ? up / (up + down) : null,
      spark: sparks.get(Number(r.id)) ?? new Array(24).fill(null),
    };
  });
  return { items, total };
}

export interface SiteStatusItem {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  status: DisplayStatus;
  responseMs: number | null;
  failing: boolean;
}

/** รายชื่อเว็บทั้งหมดแบบเบา ๆ (เรียงตามความรุนแรง) — ใช้ใน hero, uptime 90 วัน และ Ctrl+K */
export async function siteStatusList(): Promise<SiteStatusItem[]> {
  const res = await getDb().execute<{
    id: number;
    name: string;
    url: string;
    enabled: boolean;
    status: DisplayStatus;
    ms: number | null;
    failing: boolean;
  }>(sql`
    SELECT w.id, w.name, w.url, w.enabled, ${DISPLAY_STATUS} AS status, c.response_time_ms AS ms,
           (s.status = 'UP' AND s.consecutive_failures > 0) AS failing
    FROM websites w
    JOIN website_state s ON s.website_id = w.id
    LEFT JOIN check_results c ON c.id = s.last_result_id
    WHERE w.archived_at IS NULL
    ORDER BY (CASE WHEN NOT w.enabled THEN 5 WHEN s.status = 'DOWN' THEN 0 WHEN s.status = 'UP' AND s.consecutive_failures > 0 THEN 1 WHEN s.last_checked_at IS NULL THEN 4 WHEN s.status = 'UNKNOWN' THEN 3 ELSE 2 END), w.name, w.id
    LIMIT 500
  `);
  return res.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    url: r.url,
    enabled: r.enabled,
    status: r.status,
    responseMs: r.ms,
    failing: Boolean(r.failing),
  }));
}

export async function getWebsite(id: number): Promise<Website | null> {
  const [w] = await getDb().select().from(websites).where(eq(websites.id, id));
  return w ?? null;
}

export async function websiteOptions() {
  return getDb()
    .select({ id: websites.id, name: websites.name })
    .from(websites)
    .where(sql`${websites.archivedAt} IS NULL`)
    .orderBy(websites.name);
}

export async function websiteDetail(id: number) {
  const db = getDb();
  const site = await getWebsite(id);
  if (!site) return null;
  const stateRows = await db
    .execute<{
      status: "UP" | "DOWN" | "UNKNOWN";
      next_check_at: Date;
      last_checked_at: Date | null;
      consecutive_failures: number;
    }>(
      sql`SELECT status, next_check_at, last_checked_at, consecutive_failures FROM website_state WHERE website_id = ${id}`,
    )
    .then((r) => r.rows);

  const stats = await db.execute<{
    up24: string;
    down24: string;
    up7: string;
    down7: string;
    up30: string;
    down30: string;
    avg24: string | null;
    p95_24: string | null;
    downtime24: string;
    inc7: string;
    inc30: string;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'UP' AND checked_at >= now() - interval '24 hours')::text AS up24,
      count(*) FILTER (WHERE status = 'DOWN' AND checked_at >= now() - interval '24 hours')::text AS down24,
      count(*) FILTER (WHERE status = 'UP' AND checked_at >= now() - interval '7 days')::text AS up7,
      count(*) FILTER (WHERE status = 'DOWN' AND checked_at >= now() - interval '7 days')::text AS down7,
      count(*) FILTER (WHERE status = 'UP')::text AS up30,
      count(*) FILTER (WHERE status = 'DOWN')::text AS down30,
      (avg(response_time_ms) FILTER (WHERE status = 'UP' AND checked_at >= now() - interval '24 hours'))::text AS avg24,
      (percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE status = 'UP' AND checked_at >= now() - interval '24 hours'))::text AS p95_24,
      (SELECT coalesce(sum(extract(epoch FROM (least(coalesce(recovered_at, now()), now()) - greatest(started_at, now() - interval '24 hours')))), 0)
         FROM incidents WHERE website_id = ${id} AND coalesce(recovered_at, now()) > now() - interval '24 hours')::text AS downtime24,
      (SELECT count(*) FROM incidents WHERE website_id = ${id} AND started_at >= now() - interval '7 days')::text AS inc7,
      (SELECT count(*) FROM incidents WHERE website_id = ${id} AND started_at >= now() - interval '30 days')::text AS inc30
    FROM check_results WHERE website_id = ${id} AND checked_at >= now() - interval '30 days'
  `);
  const s = stats.rows[0]!;
  const ratio = (u: string, d: string) =>
    Number(u) + Number(d) > 0 ? Number(u) / (Number(u) + Number(d)) : null;

  const openIncident = await db.execute<{
    id: number;
    started_at: Date;
    cause: string;
    failed_check_count: number;
    emailed: string;
  }>(sql`
    SELECT i.id, i.started_at, i.cause, i.failed_check_count,
           (SELECT count(*) FROM notification_events n WHERE n.incident_id = i.id AND n.event_type = 'DOWN' AND n.status = 'SENT')::text AS emailed
    FROM incidents i WHERE i.website_id = ${id} AND i.recovered_at IS NULL
  `);
  const recentChecks = await db.execute<CheckRowRaw>(sql`
    SELECT id, checked_at, status, degraded, http_status, first_http_status, response_time_ms, retries, error_code, error_message, redirect_count
    FROM check_results WHERE website_id = ${id} ORDER BY checked_at DESC LIMIT 8
  `);
  const incidentsRes = await db.execute<{
    id: number;
    started_at: Date;
    recovered_at: Date | null;
    cause: string;
  }>(sql`
    SELECT id, started_at, recovered_at, cause FROM incidents WHERE website_id = ${id} ORDER BY started_at DESC LIMIT 5
  `);

  const st = stateRows[0];
  return {
    site,
    state: st
      ? {
          status: st.status,
          nextCheckAt: new Date(st.next_check_at),
          lastCheckedAt: st.last_checked_at ? new Date(st.last_checked_at) : null,
          consecutiveFailures: st.consecutive_failures,
        }
      : null,
    uptime24h: ratio(s.up24, s.down24),
    uptime7d: ratio(s.up7, s.down7),
    uptime30d: ratio(s.up30, s.down30),
    avg24: s.avg24 ? Math.round(Number(s.avg24)) : null,
    p95_24: s.p95_24 ? Math.round(Number(s.p95_24)) : null,
    downtime24Seconds: Math.round(Number(s.downtime24)),
    incidents7d: Number(s.inc7),
    incidents30d: Number(s.inc30),
    openIncident: openIncident.rows[0]
      ? {
          id: Number(openIncident.rows[0].id),
          startedAt: new Date(openIncident.rows[0].started_at),
          cause: openIncident.rows[0].cause,
          failedCheckCount: openIncident.rows[0].failed_check_count,
          emailed: Number(openIncident.rows[0].emailed) > 0,
        }
      : null,
    recentChecks: recentChecks.rows.map(mapCheckRow),
    incidents: incidentsRes.rows.map((r) => ({
      id: Number(r.id),
      startedAt: new Date(r.started_at),
      recoveredAt: r.recovered_at ? new Date(r.recovered_at) : null,
      cause: r.cause,
    })),
  };
}

export const CHART_RANGES = {
  "6h": { hours: 6, bucketMin: 0 },
  "24h": { hours: 24, bucketMin: 15 },
  "7d": { hours: 168, bucketMin: 120 },
} as const;
export type ChartRange = keyof typeof CHART_RANGES;

/** จุดของกราฟ response time: 6 ชม. = ทุกผลตรวจ, ช่วงยาวขึ้นรวมเป็นช่อง (เฉลี่ย, แดงถ้ามีล้มเหลว) */
export async function responseSeries(id: number, range: ChartRange) {
  const { hours, bucketMin } = CHART_RANGES[range];
  const db = getDb();
  if (bucketMin === 0) {
    const res = await db.execute<{ t: Date; ms: number | null; status: string }>(sql`
      SELECT checked_at AS t, response_time_ms AS ms, status FROM check_results
      WHERE website_id = ${id} AND checked_at >= now() - make_interval(hours => ${hours}) ORDER BY checked_at
    `);
    return res.rows.map((r) => ({
      t: new Date(r.t),
      ms: r.ms,
      failed: r.status === "DOWN",
      unknown: r.status === "UNKNOWN",
    }));
  }
  const res = await db.execute<{ t: Date; ms: string | null; failed: boolean; unknown: boolean }>(sql`
    SELECT to_timestamp(floor(extract(epoch FROM checked_at) / ${bucketMin * 60}) * ${bucketMin * 60}) AS t,
           avg(response_time_ms) FILTER (WHERE status = 'UP')::text AS ms,
           bool_or(status = 'DOWN') AS failed,
           bool_and(status = 'UNKNOWN') AS unknown
    FROM check_results
    WHERE website_id = ${id} AND checked_at >= now() - make_interval(hours => ${hours})
    GROUP BY 1 ORDER BY 1
  `);
  return res.rows.map((r) => ({
    t: new Date(r.t),
    ms: r.ms ? Math.round(Number(r.ms)) : null,
    failed: r.failed,
    unknown: r.unknown,
  }));
}

export type CheckRowRaw = {
  id: number;
  checked_at: Date;
  status: "UP" | "DOWN" | "UNKNOWN";
  degraded: boolean;
  http_status: number | null;
  first_http_status: number | null;
  response_time_ms: number | null;
  retries: number;
  error_code: string | null;
  error_message: string | null;
  redirect_count: number;
};

export function mapCheckRow(r: CheckRowRaw) {
  return {
    id: Number(r.id),
    checkedAt: new Date(r.checked_at),
    status: r.status,
    degraded: r.degraded,
    httpStatus: r.http_status,
    firstHttpStatus: r.first_http_status,
    responseTimeMs: r.response_time_ms,
    retries: Number(r.retries),
    errorCode: r.error_code,
    errorMessage: r.error_message,
    redirectCount: Number(r.redirect_count),
  };
}
export type CheckRow = ReturnType<typeof mapCheckRow>;
