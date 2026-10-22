import { z } from "zod";
import type { OutageInput } from "@app/core";
import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "./helpers";

export const CHECK_RANGES = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720, "90d": 2160 } as const;
export type CheckRange = keyof typeof CHECK_RANGES;
export const CHECKS_EXPORT_LIMIT = 50_000;

export const checksFilterSchema = z.object({
  websiteId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  result: z.enum(["UP", "DOWN", "UNKNOWN", "DEGRADED"]).optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z_]{2,40}$/)
    .optional(),
  range: z.enum(Object.keys(CHECK_RANGES) as [CheckRange, ...CheckRange[]]).default("24h"),
});
export type ChecksFilter = z.infer<typeof checksFilterSchema>;

/** WHERE ของ check_results (alias c) ตามตัวกรองในหน้าประวัติการตรวจ — ใช้ร่วมกันทั้งหน้าเว็บ, CSV และ Sheets */
export function buildChecksFilterSql(f: Partial<ChecksFilter>, now: Date): SQL {
  const hours = CHECK_RANGES[f.range ?? "24h"] ?? 24;
  const parts: SQL[] = [sql`c.checked_at >= ${new Date(now.getTime() - hours * 3_600_000)}`];
  if (f.websiteId) parts.push(sql`c.website_id = ${f.websiteId}`);
  if (f.result === "DEGRADED") parts.push(sql`c.status = 'UP' AND c.degraded`);
  else if (f.result) parts.push(sql`c.status = ${f.result}`);
  if (f.errorCode) parts.push(sql`c.error_code = ${f.errorCode}`);
  return sql.join(parts, sql` AND `);
}

/**
 * Incident ในช่วงเวลา พร้อม IP ปลายทางล่าสุดที่เคยต่อได้ก่อนล่ม — ใช้หาต้นเหตุร่วม (correlateOutages)
 * open = เฉพาะที่ยังเปิดอยู่, หรือกำหนดช่วงเวลา started_at
 */
export async function loadOutages(
  db: DbOrTx,
  range: { openOnly: true } | { from: Date; to: Date },
): Promise<OutageInput[]> {
  const where =
    "openOnly" in range
      ? sql`i.recovered_at IS NULL`
      : sql`i.started_at >= ${range.from} AND i.started_at <= ${range.to}`;
  const res = await db.execute<{
    id: number;
    website_id: number;
    name: string;
    url: string;
    started_at: Date;
    recovered_at: Date | null;
    error_code: string | null;
    remote_ip: string | null;
  }>(sql`
    SELECT i.id, i.website_id, w.name, w.url, i.started_at, i.recovered_at, i.error_code,
           (SELECT c.remote_ip FROM check_results c
             WHERE c.website_id = i.website_id AND c.remote_ip IS NOT NULL AND c.checked_at <= i.started_at + interval '1 minute'
             ORDER BY c.checked_at DESC LIMIT 1) AS remote_ip
    FROM incidents i JOIN websites w ON w.id = i.website_id
    WHERE ${where}
    ORDER BY i.started_at
    LIMIT 500
  `);
  return res.rows.map((r) => ({
    incidentId: Number(r.id),
    websiteId: Number(r.website_id),
    name: r.name,
    url: r.url,
    startedAt: new Date(r.started_at),
    recoveredAt: r.recovered_at ? new Date(r.recovered_at) : null,
    errorCode: r.error_code,
    remoteIp: r.remote_ip,
  }));
}
