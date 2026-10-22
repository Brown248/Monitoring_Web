import { jobRequests, sql } from "@app/db";
import { checksFilterSchema } from "@app/db/queries";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

const websiteId = z.number().int().positive().max(2_147_483_647);

const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SHEETS_SYNC"), payload: z.unknown().optional() }),
  z.object({ type: z.literal("SHEETS_EXPORT_CHECKS"), payload: checksFilterSchema }),
  z.object({ type: z.literal("SECURITY_SCAN"), payload: z.object({ websiteId }) }),
  z.object({ type: z.literal("VISUAL_CAPTURE"), payload: z.object({ websiteId }) }),
  z.object({ type: z.literal("LOOKALIKE_SCAN"), payload: z.unknown().optional() }),
  z.object({ type: z.literal("DIAGNOSE"), payload: z.object({ websiteId }) }),
  z.object({ type: z.literal("JOURNEY_RUN"), payload: z.object({ websiteId }) }),
]);

/** งานที่แค่ตรวจ/อ่าน ไม่เปลี่ยนอะไร → ผู้ใช้ทั่วไปสั่งได้ */
const VIEWER_JOBS = new Set(["DIAGNOSE"]);
/** งานค้าง (รอ/กำลังทำ) ต่อผู้ใช้ — กดรัว ๆ ไม่ทำให้คิวท่วมจนงานของคนอื่นต้องรอนาน */
const MAX_PENDING_PER_USER = 10;

/** สร้างงานให้ worker (Sheets, สแกนความปลอดภัย, ถ่ายภาพหน้าเว็บ, ค้นโดเมนเลียนแบบ, วินิจฉัย) */
export const POST = route(async (req) => {
  const user = await requireApi(req);
  const body = await readJson(req, schema);
  if (!VIEWER_JOBS.has(body.type) && user.role !== "ADMIN")
    throw new HttpError(403, "ต้องเป็นผู้ดูแลระบบ (Admin)");
  const payload = body.type === "SHEETS_SYNC" || body.type === "LOOKALIKE_SCAN" ? null : body.payload;
  const siteId =
    payload && typeof payload === "object" && "websiteId" in payload
      ? (payload.websiteId as number | undefined)
      : undefined;
  const db = getDb();

  const id = await db.transaction(async (tx) => {
    // กันสองคำขอพร้อมกันสร้างงานซ้ำ
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('job_requests:create'))`);
    if (siteId !== undefined) {
      const [site] = (
        await tx.execute<{ ok: number }>(
          sql`SELECT 1 AS ok FROM websites WHERE id = ${siteId} AND archived_at IS NULL`,
        )
      ).rows;
      if (!site) throw new HttpError(404, "ไม่พบเว็บไซต์");
    }
    // งานเดียวกัน (ประเภท + ข้อมูลเดียวกัน) ที่ยังรอ/กำลังทำ → ใช้งานเดิม ปุ่มรอผลของงานนั้นได้เลย
    const [same] = (
      await tx.execute<{ id: number }>(sql`
        SELECT id FROM job_requests
        WHERE type = ${body.type} AND status IN ('PENDING', 'RUNNING')
          AND payload IS NOT DISTINCT FROM ${payload === null ? null : JSON.stringify(payload)}::jsonb
        ORDER BY id DESC LIMIT 1
      `)
    ).rows;
    if (same) return Number(same.id);
    const [{ n }] = (
      await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM job_requests
        WHERE requested_by = ${user.id} AND status IN ('PENDING', 'RUNNING')
      `)
    ).rows as [{ n: number }];
    if (Number(n) >= MAX_PENDING_PER_USER)
      throw new HttpError(429, `มีงานค้างอยู่ ${n} งานแล้ว — รอให้เสร็จก่อนแล้วค่อยสั่งเพิ่ม`);
    const [job] = await tx
      .insert(jobRequests)
      .values({ type: body.type, payload: payload as Record<string, unknown> | null, requestedBy: user.id })
      .returning({ id: jobRequests.id });
    return job!.id;
  });
  return NextResponse.json({ id }, { status: 202 });
});
