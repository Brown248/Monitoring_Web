import "server-only";
import { dayKey } from "@app/core";
import { sql } from "@app/db";
import { getDb } from "../db";

export interface UptimeDay {
  day: string;
  /** null = ไม่มีผลตรวจวันนั้น (เช่น Worker ไม่ได้ทำงาน) */
  uptime: number | null;
  downtimeSeconds: number;
  incidents: number;
  checks: number;
  /** สัดส่วนผลตรวจที่ UP แต่ช้ากว่าเกณฑ์ (DEGRADED) */
  slowRatio: number;
}

export interface UptimeHistory {
  /** ครบ N วันเสมอ (เก่า → ใหม่) — วันที่ยังไม่มีผลตรวจ uptime = null */
  days: UptimeDay[];
  /** uptime รวมทั้งช่วง (UP / (UP + DOWN)) */
  overall: number | null;
}

type Agg = { up: number; down: number; slow: number; total: number; downtime: number; inc: number };

/**
 * uptime รายวันย้อนหลังสูงสุด N วันของหลายเว็บในครั้งเดียว
 * - นับ UP/DOWN/ช้า จากผลตรวจจริง (check_results) ในช่วงที่ยังเก็บไว้ · เก่ากว่านั้นใช้ daily_summaries
 * - เวลาล่ม/จำนวน incident: วันก่อนหน้าจาก daily_summaries, วันนี้คำนวณสดจาก incidents
 */
export async function uptimeHistory(
  ids: number[],
  tz: string,
  nDays = 90,
): Promise<Map<number, UptimeHistory>> {
  const out = new Map<number, UptimeHistory>();
  if (ids.length === 0) return out;
  const db = getDb();
  const idList = sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  );
  const today = dayKey(new Date(), tz);
  const start = sql`((${today}::date - ${nDays - 1}::int)::timestamp AT TIME ZONE ${tz})`;

  const [checks, past, live] = await Promise.all([
    db.execute<{
      website_id: number;
      day: string;
      up: string;
      down: string;
      slow: string;
      total: string;
    }>(sql`
      SELECT website_id, (checked_at AT TIME ZONE ${tz})::date::text AS day,
             count(*) FILTER (WHERE status = 'UP')::text AS up,
             count(*) FILTER (WHERE status = 'DOWN')::text AS down,
             count(*) FILTER (WHERE status = 'UP' AND degraded)::text AS slow,
             count(*)::text AS total
      FROM check_results
      WHERE website_id IN (${idList}) AND checked_at >= ${start}
      GROUP BY 1, 2
    `),
    db.execute<{
      website_id: number;
      day: string;
      up: number;
      down: number;
      total: number;
      downtime: number;
      inc: number;
    }>(sql`
      SELECT website_id, day::text AS day, up_checks AS up, down_checks AS down, total_checks AS total,
             downtime_seconds AS downtime, incident_count AS inc
      FROM daily_summaries
      WHERE website_id IN (${idList}) AND day >= (${today}::date - ${nDays - 1}::int) AND day < ${today}::date
    `),
    db.execute<{ id: number; secs: string; inc: string }>(sql`
      WITH b AS (SELECT (${today}::date::timestamp AT TIME ZONE ${tz}) AS d_start)
      SELECT w.id,
        coalesce((SELECT sum(extract(epoch FROM (coalesce(i.recovered_at, now()) - greatest(i.started_at, b.d_start))))
                  FROM incidents i WHERE i.website_id = w.id AND coalesce(i.recovered_at, now()) > b.d_start), 0)::text AS secs,
        (SELECT count(*) FROM incidents i WHERE i.website_id = w.id AND i.started_at >= b.d_start)::text AS inc
      FROM websites w CROSS JOIN b WHERE w.id IN (${idList})
    `),
  ]);

  const data = new Map<string, Agg>();
  const key = (id: number, day: string) => `${id}:${day}`;
  for (const r of past.rows) {
    data.set(key(Number(r.website_id), r.day), {
      up: Number(r.up),
      down: Number(r.down),
      slow: 0,
      total: Number(r.total),
      downtime: Number(r.downtime),
      inc: Number(r.inc),
    });
  }
  // ผลตรวจจริงละเอียดกว่า → ใช้แทนจำนวนจาก summary (คงเวลาล่ม/incident จาก summary ไว้)
  // ยกเว้นวันที่ผลตรวจถูกลบไปบางส่วนแล้ว (retention เก็บไว้แค่ผลตรวจที่ Incident อ้างถึง) — เหลือน้อยกว่า
  // ใน summary = ไม่ครบ ใช้ไม่ได้ (เช่น เหลือ 3 แถว DOWN/DOWN/UP → uptime 33% แทน 99%)
  for (const r of checks.rows) {
    const k = key(Number(r.website_id), r.day);
    const prev = data.get(k);
    if (prev && Number(r.total) < prev.total) continue;
    data.set(k, {
      up: Number(r.up),
      down: Number(r.down),
      slow: Number(r.slow),
      total: Number(r.total),
      downtime: prev?.downtime ?? 0,
      inc: prev?.inc ?? 0,
    });
  }
  for (const r of live.rows) {
    const k = key(Number(r.id), today);
    const prev = data.get(k) ?? { up: 0, down: 0, slow: 0, total: 0, downtime: 0, inc: 0 };
    data.set(k, { ...prev, downtime: Math.round(Number(r.secs)), inc: Number(r.inc) });
  }

  const keys: string[] = [];
  for (let i = nDays - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86_400_000), tz));
  const hasData = (a: Agg | undefined) => Boolean(a && (a.total > 0 || a.downtime > 0));

  for (const id of ids) {
    let up = 0;
    let down = 0;
    const days = keys.map((day): UptimeDay => {
      const a = data.get(key(id, day));
      if (!a || !hasData(a))
        return { day, uptime: null, downtimeSeconds: 0, incidents: 0, checks: 0, slowRatio: 0 };
      up += a.up;
      down += a.down;
      return {
        day,
        uptime: a.up + a.down > 0 ? a.up / (a.up + a.down) : null,
        downtimeSeconds: a.downtime,
        incidents: a.inc,
        checks: a.total,
        slowRatio: a.up > 0 ? a.slow / a.up : 0,
      };
    });
    out.set(id, { days, overall: up + down > 0 ? up / (up + down) : null });
  }
  return out;
}
