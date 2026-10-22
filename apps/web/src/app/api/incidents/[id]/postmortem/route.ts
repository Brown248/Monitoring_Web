import { isAiReady } from "@app/core/server";
import { eq, getSettings, incidents, postmortems } from "@app/db";
import { NextResponse } from "next/server";
import { HttpError, parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

type Ctx = { params: Promise<{ id: string }> };

/** สั่งให้ AI ร่าง (หรือร่างใหม่) รายงานสรุปเหตุ */
export const POST = route<Ctx>(async (req, ctx) => {
  await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const db = getDb();
  const env = getEnv();
  const ai = await getSettings(db, "ai");
  if (!isAiReady(ai, { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL }))
    throw new HttpError(409, "ยังไม่ได้ตั้งค่า AI (provider / model / AI_API_KEY) — ดูหน้าตั้งค่า");
  const [inc] = await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.id, id));
  if (!inc) throw new HttpError(404, "ไม่พบ Incident");
  const [existing] = await db
    .select({ status: postmortems.status })
    .from(postmortems)
    .where(eq(postmortems.incidentId, id));
  if (existing && (existing.status === "PENDING" || existing.status === "RUNNING"))
    throw new HttpError(409, "กำลังร่างรายงานอยู่แล้ว");
  await db
    .insert(postmortems)
    .values({ incidentId: id })
    .onConflictDoUpdate({
      target: postmortems.incidentId,
      set: { status: "PENDING", attempts: 0, error: null, requestedAt: new Date(), completedAt: null },
    });
  return NextResponse.json({ ok: true, message: "ส่งให้ AI ร่างรายงานแล้ว" });
});
