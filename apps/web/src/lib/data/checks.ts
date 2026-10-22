import "server-only";
import { sql } from "@app/db";
import { buildChecksFilterSql, type ChecksFilter } from "@app/db/queries";
import { getDb } from "../db";
import { mapCheckRow, type CheckRowRaw } from "./websites";

export async function checkHistory(f: ChecksFilter, page: number, pageSize: number) {
  const db = getDb();
  const now = new Date();
  const where = buildChecksFilterSql(f, now);
  // ตัวเลขสรุปตามผลตรวจ — ใช้ตัวกรองอื่นทั้งหมดยกเว้น "ผลตรวจ"
  const whereNoResult = buildChecksFilterSql({ ...f, result: undefined }, now);
  const [counts, total, rows] = await Promise.all([
    db.execute<{ up: string; down: string; unknown: string; degraded: string }>(sql`
      SELECT count(*) FILTER (WHERE c.status = 'UP')::text AS up, count(*) FILTER (WHERE c.status = 'DOWN')::text AS down,
             count(*) FILTER (WHERE c.status = 'UNKNOWN')::text AS unknown, count(*) FILTER (WHERE c.degraded)::text AS degraded
      FROM check_results c WHERE ${whereNoResult}
    `),
    db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM check_results c WHERE ${where}`),
    db.execute<CheckRowRaw & { website_id: number; name: string }>(sql`
      SELECT c.id, c.checked_at, c.status, c.degraded, c.http_status, c.first_http_status, c.response_time_ms, c.retries,
             c.error_code, c.error_message, c.redirect_count, c.website_id, w.name
      FROM check_results c JOIN websites w ON w.id = c.website_id
      WHERE ${where}
      ORDER BY c.checked_at DESC, c.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
  ]);
  const c = counts.rows[0]!;
  return {
    counts: {
      up: Number(c.up),
      down: Number(c.down),
      unknown: Number(c.unknown),
      degraded: Number(c.degraded),
    },
    total: Number(total.rows[0]?.n ?? 0),
    items: rows.rows.map((r) => ({
      ...mapCheckRow(r),
      websiteId: Number(r.website_id),
      websiteName: r.name,
    })),
  };
}

export async function errorCodesInUse(): Promise<string[]> {
  const res = await getDb().execute<{ error_code: string }>(sql`
    SELECT DISTINCT error_code FROM check_results WHERE error_code IS NOT NULL AND checked_at >= now() - interval '90 days' ORDER BY 1
  `);
  return res.rows.map((r) => r.error_code);
}
