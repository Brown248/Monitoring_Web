import { causeLabel, formatDate, formatTime } from "@app/core";
import { sql } from "@app/db";
import { buildChecksFilterSql, checksFilterSchema, CHECKS_EXPORT_LIMIT } from "@app/db/queries";
import { HttpError, requireApi, route, zodFields } from "@/lib/api";
import { getDb } from "@/lib/db";
import { tz } from "@/lib/env";

const csvCell = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // กัน CSV/formula injection เมื่อเปิดใน Excel/Sheets
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** ส่งออกผลตรวจตามตัวกรองเป็น CSV (UTF-8 BOM ให้ Excel อ่านภาษาไทยได้) */
export const GET = route(async (req) => {
  await requireApi(req);
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = checksFilterSchema.safeParse(params);
  if (!parsed.success) throw new HttpError(400, "ตัวกรองไม่ถูกต้อง", zodFields(parsed.error));
  const zone = tz();
  const res = await getDb().execute<{
    checked_at: Date;
    name: string;
    url: string;
    status: string;
    degraded: boolean;
    http_status: number | null;
    response_time_ms: number | null;
    retries: number;
    error_code: string | null;
    error_message: string | null;
  }>(sql`
    SELECT c.checked_at, w.name, w.url, c.status, c.degraded, c.http_status, c.response_time_ms, c.retries, c.error_code, c.error_message
    FROM check_results c JOIN websites w ON w.id = c.website_id
    WHERE ${buildChecksFilterSql(parsed.data, new Date())}
    ORDER BY c.checked_at DESC LIMIT ${CHECKS_EXPORT_LIMIT}
  `);
  const header = [
    "วันที่",
    "เวลา",
    "เว็บไซต์",
    "URL",
    "ผล",
    "HTTP",
    "Response (ms)",
    "Retry",
    "Error",
    "รายละเอียด",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of res.rows) {
    const at = new Date(r.checked_at);
    lines.push(
      [
        formatDate(at, zone),
        formatTime(at, zone),
        r.name,
        r.url,
        r.degraded ? "DEGRADED" : r.status,
        r.http_status,
        r.response_time_ms,
        r.retries,
        r.error_code ? causeLabel(r.error_code, r.http_status) : "",
        r.error_message,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return new Response("﻿" + lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="check-history-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
});
