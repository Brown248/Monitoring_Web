import { isAiReady } from "@app/core/server";
import { aiAnalyses, eq, getSettings, incidents, logEvent } from "@app/db";
import { NextResponse } from "next/server";
import { HttpError, parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

type Ctx = { params: Promise<{ id: string }> };

/** สั่งวิเคราะห์ (หรือวิเคราะห์ใหม่) — worker หยิบจากคิวภายในไม่กี่วินาที */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const db = getDb();
  const env = getEnv();
  const ai = await getSettings(db, "ai");
  if (!isAiReady(ai, { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL })) {
    throw new HttpError(409, "ยังไม่ได้ตั้งค่า AI (provider / model / AI_API_KEY) — ดูหน้าตั้งค่า");
  }
  const [inc] = await db
    .select({ id: incidents.id, websiteId: incidents.websiteId })
    .from(incidents)
    .where(eq(incidents.id, id));
  if (!inc) throw new HttpError(404, "ไม่พบ Incident");
  const [existing] = await db
    .select({ status: aiAnalyses.status })
    .from(aiAnalyses)
    .where(eq(aiAnalyses.incidentId, id));
  if (existing && (existing.status === "PENDING" || existing.status === "RUNNING")) {
    throw new HttpError(409, "กำลังวิเคราะห์อยู่แล้ว");
  }
  await db
    .insert(aiAnalyses)
    .values({ incidentId: id })
    .onConflictDoUpdate({
      target: aiAnalyses.incidentId,
      set: { status: "PENDING", attempts: 0, error: null, requestedAt: new Date(), completedAt: null },
    });
  await logEvent(db, {
    type: "AI_REQUESTED",
    incidentId: id,
    websiteId: inc.websiteId,
    message: `สั่งวิเคราะห์ด้วย AI (โดย ${user.username})`,
  });
  return NextResponse.json({ ok: true, message: "ส่งเข้าคิววิเคราะห์แล้ว" });
});
