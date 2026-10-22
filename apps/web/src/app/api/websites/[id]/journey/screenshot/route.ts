import { sql } from "@app/db";
import { HttpError, parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * ภาพหน้าจอตอนที่ทดสอบใช้งานจริงไม่ผ่าน (JPEG ที่ worker ถ่ายเอง)
 * เฉพาะ Admin — ภาพอาจเห็นข้อมูลหลัง login ของบัญชีทดสอบ (เหมือนการแก้ขั้นตอนที่ต้องเป็น Admin)
 */
export const GET = route<Ctx>(async (req, ctx) => {
  await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const run = Number(new URL(req.url).searchParams.get("run"));
  if (!Number.isSafeInteger(run) || run <= 0) throw new HttpError(400, "run ไม่ถูกต้อง");
  const r = await getDb().execute<{ screenshot: Buffer | null }>(
    sql`SELECT screenshot FROM journey_runs WHERE id = ${run} AND website_id = ${id}`,
  );
  const shot = r.rows[0]?.screenshot;
  if (!shot) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(shot), {
    headers: {
      "content-type": "image/jpeg",
      // อาจเห็นข้อมูลหลัง login ของบัญชีทดสอบ — ไม่เก็บในแคชเบราว์เซอร์ (logout/ถูกลดสิทธิ์แล้วยังเปิดดูได้)
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
