import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** session ยังใช้ได้หรือไม่ (AutoRefresh ตรวจก่อนรีเฟรชหน้า — ไม่ให้เด้งไปหน้า login ระหว่างกรอกข้อมูล) */
export async function GET() {
  const user = await getCurrentUser();
  return Response.json(
    { ok: Boolean(user) },
    { status: user ? 200 : 401, headers: { "cache-control": "no-store" } },
  );
}
