import { dayKey } from "@app/core";
import { sql, type DbOrTx } from "@app/db";

/** สรุปรายวันของวันที่ระบุ (ตาม timezone) — เรียกซ้ำได้ (upsert) */
export async function rollupDays(db: DbOrTx, days: string[], tz: string): Promise<void> {
  for (const day of days) {
    await db.execute(sql`
      WITH bounds AS (
        SELECT (${day}::date::timestamp AT TIME ZONE ${tz}) AS d_start,
               ((${day}::date + 1)::timestamp AT TIME ZONE ${tz}) AS d_end
      ),
      agg AS (
        SELECT w.id AS website_id,
               count(c.id) AS total,
               count(c.id) FILTER (WHERE c.status = 'UP') AS up,
               count(c.id) FILTER (WHERE c.status = 'DOWN') AS down,
               count(c.id) FILTER (WHERE c.status = 'UNKNOWN') AS unknown,
               avg(c.response_time_ms) FILTER (WHERE c.status = 'UP') AS avg_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY c.response_time_ms) FILTER (WHERE c.status = 'UP') AS p95_ms
        FROM websites w
        CROSS JOIN bounds b
        LEFT JOIN check_results c ON c.website_id = w.id AND c.checked_at >= b.d_start AND c.checked_at < b.d_end
        WHERE w.created_at < b.d_end
        GROUP BY w.id
      ),
      inc AS (
        SELECT i.website_id,
               sum(extract(epoch FROM (least(coalesce(i.recovered_at, now()), b.d_end) - greatest(i.started_at, b.d_start))))::int AS downtime,
               count(*) FILTER (WHERE i.started_at >= b.d_start AND i.started_at < b.d_end) AS started
        FROM incidents i CROSS JOIN bounds b
        WHERE i.started_at < b.d_end AND coalesce(i.recovered_at, now()) > b.d_start
        GROUP BY i.website_id
      )
      INSERT INTO daily_summaries (website_id, day, total_checks, up_checks, down_checks, unknown_checks,
                                   avg_response_ms, p95_response_ms, downtime_seconds, incident_count, updated_at)
      SELECT a.website_id, ${day}::date, a.total, a.up, a.down, a.unknown, a.avg_ms, a.p95_ms,
             greatest(coalesce(inc.downtime, 0), 0), coalesce(inc.started, 0), now()
      FROM agg a LEFT JOIN inc ON inc.website_id = a.website_id
      WHERE a.total > 0 OR inc.website_id IS NOT NULL
      ON CONFLICT (website_id, day) DO UPDATE SET
        total_checks = EXCLUDED.total_checks, up_checks = EXCLUDED.up_checks, down_checks = EXCLUDED.down_checks,
        unknown_checks = EXCLUDED.unknown_checks, avg_response_ms = EXCLUDED.avg_response_ms,
        p95_response_ms = EXCLUDED.p95_response_ms, downtime_seconds = EXCLUDED.downtime_seconds,
        incident_count = EXCLUDED.incident_count, updated_at = now()
    `);
  }
}

/**
 * วันนี้และเมื่อวาน (เมื่อวานจะถูกปิดยอดหลังเที่ยงคืน)
 * + วันก่อนหน้าที่ยังสรุปไม่ครบ (สรุปไว้ก่อนวันนั้นจบ — เช่น Worker ดับข้ามวันนานกว่า 1 วัน)
 * ย้อนไม่เกิน 14 วัน: ผลตรวจละเอียดเก็บอย่างน้อย 30 วัน จึงยังครบทุกแถว ไม่ทำให้สรุปผิด
 */
export async function rollupRecent(
  db: DbOrTx,
  tz: string,
  opts: { forceStaleScan?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const recent = [dayKey(new Date(now.getTime() - 86_400_000), tz), dayKey(now, tz)];
  const days = [...new Set([...(await staleDays(db, tz, opts.forceStaleScan ?? false)), ...recent])].sort();
  await rollupDays(db, days, tz);
}

/**
 * วันเก่าที่ยังสรุปไม่ครบเกิดได้แค่ตอน Worker ดับข้ามวัน — สแกนผลตรวจ 14 วันเพื่อหาวันพวกนี้
 * ทุก 10 นาทีเปลืองเกินจำเป็น: ตรวจตอน Worker เริ่ม แล้วทุก 1 ชั่วโมง
 */
let lastStaleScan = 0;
const STALE_SCAN_EVERY_MS = 3_600_000;

async function staleDays(db: DbOrTx, tz: string, force: boolean): Promise<string[]> {
  if (!force && Date.now() - lastStaleScan < STALE_SCAN_EVERY_MS) return [];
  // ขอบเขตเวลาเป็นค่าคงที่ (ไม่คำนวณต่อแถว) ให้ใช้ index ของ checked_at ได้ แล้วจัดกลุ่มเว็บ/วันก่อน
  // ค่อยเทียบกับ daily_summaries (เดิมเทียบทุกแถวของผลตรวจ — หลายล้านครั้ง)
  const res = await db.execute<{ day: string }>(sql`
    WITH bounds AS (
      SELECT now() - interval '14 days' AS lo,
             (((now() AT TIME ZONE ${tz})::date - 1)::timestamp AT TIME ZONE ${tz}) AS hi
    ),
    site_days AS (
      SELECT c.website_id, (c.checked_at AT TIME ZONE ${tz})::date AS day
      FROM check_results c, bounds b
      WHERE c.checked_at >= b.lo AND c.checked_at < b.hi
      GROUP BY 1, 2
      UNION
      -- วันที่ Incident คร่อมอยู่แต่ไม่มีผลตรวจเลย (Worker ดับข้ามวัน) — ต้องนับเวลาล่มของวันนั้นด้วย
      SELECT i.website_id, gs::date AS day
      FROM incidents i, bounds b,
        generate_series(
          (greatest(i.started_at, b.lo) AT TIME ZONE ${tz})::date,
          (least(coalesce(i.recovered_at, now()), b.hi - interval '1 microsecond') AT TIME ZONE ${tz})::date,
          interval '1 day'
        ) gs
      WHERE i.started_at < b.hi AND coalesce(i.recovered_at, now()) > b.lo
    )
    SELECT DISTINCT d.day::text AS day
    FROM site_days d
    WHERE NOT EXISTS (
      SELECT 1 FROM daily_summaries s
      WHERE s.website_id = d.website_id AND s.day = d.day
        AND s.updated_at >= ((d.day + 1)::timestamp AT TIME ZONE ${tz})
    )
  `);
  lastStaleScan = Date.now();
  return res.rows.map((r) => r.day);
}
