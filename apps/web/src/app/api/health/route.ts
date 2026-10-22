import { sql } from "@app/db";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * สำหรับ Docker healthcheck / ตรวจหลังติดตั้ง: 200 = เว็บและฐานข้อมูลพร้อม · 503 = ต่อฐานข้อมูลไม่ได้
 * (เดิมตอบ 200 เสมอ → รหัสผ่านฐานข้อมูลผิด container ก็ยังขึ้น healthy ขณะที่ทุกหน้า error)
 */
export async function GET() {
  let database: "ok" | "error" = "ok";
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    database = "error";
  }
  return Response.json(
    { status: database === "ok" ? "ok" : "degraded", database, time: new Date().toISOString() },
    { status: database === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
