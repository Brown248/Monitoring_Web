import { sql } from "@app/db";
import { NextResponse } from "next/server";
import { requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

/** id ของเว็บที่มีโลโก้ (+ เวลาที่ดึง ใช้เป็น version ของรูป) — หน้าเว็บจะขอรูปเฉพาะเว็บเหล่านี้ ไม่ยิงคำขอที่รู้ว่า 404 */
export const GET = route(async (req) => {
  await requireApi(req);
  const res = await getDb().execute<{ website_id: number; v: string }>(sql`
    SELECT i.website_id, extract(epoch FROM i.fetched_at)::bigint::text AS v
    FROM website_icons i JOIN websites w ON w.id = i.website_id AND w.archived_at IS NULL
    WHERE i.ok AND i.content IS NOT NULL
    ORDER BY i.website_id
  `);
  return NextResponse.json(
    { icons: Object.fromEntries(res.rows.map((r) => [Number(r.website_id), r.v])) },
    { headers: { "cache-control": "private, max-age=60" } },
  );
});
