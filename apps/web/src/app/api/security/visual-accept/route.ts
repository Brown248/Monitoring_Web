import { and, eq, inArray, logEvent, securityAlerts, sql, visualSnapshots } from "@app/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

const schema = z.object({ websiteId: z.number().int().positive().max(2_147_483_647) });

/** ยอมรับหน้าเว็บปัจจุบันเป็นภาพต้นแบบใหม่ (เช่น หลังปรับดีไซน์เว็บ) และปิด alert ที่เกี่ยวข้อง */
export const POST = route(async (req) => {
  const user = await requireApi(req, "ADMIN");
  const { websiteId } = await readJson(req, schema);
  const db = getDb();
  const done = await db.transaction(async (tx) => {
    const [site] = (
      await tx.execute<{ ok: number }>(
        sql`SELECT 1 AS ok FROM websites WHERE id = ${websiteId} AND archived_at IS NULL`,
      )
    ).rows;
    if (!site) throw new HttpError(404, "ไม่พบเว็บไซต์");
    const [latest] = await tx
      .select()
      .from(visualSnapshots)
      .where(and(eq(visualSnapshots.websiteId, websiteId), eq(visualSnapshots.kind, "latest")));
    if (!latest?.image) return false;
    const row = {
      websiteId,
      kind: "baseline",
      image: latest.image,
      keywords: latest.keywords,
      pageTitle: latest.pageTitle,
      capturedAt: latest.capturedAt,
      diffRatio: 0,
      error: null,
    };
    await tx
      .insert(visualSnapshots)
      .values(row)
      .onConflictDoUpdate({ target: [visualSnapshots.websiteId, visualSnapshots.kind], set: row });
    await tx
      .update(visualSnapshots)
      .set({ diffRatio: 0 })
      .where(and(eq(visualSnapshots.websiteId, websiteId), eq(visualSnapshots.kind, "latest")));
    await tx
      .delete(visualSnapshots)
      .where(and(eq(visualSnapshots.websiteId, websiteId), eq(visualSnapshots.kind, "diff")));
    await tx
      .update(securityAlerts)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: user.id })
      .where(
        and(
          eq(securityAlerts.websiteId, websiteId),
          inArray(securityAlerts.type, ["VISUAL_CHANGE", "DEFACE_KEYWORD"]),
          sql`${securityAlerts.acknowledgedAt} IS NULL`,
        ),
      );
    await logEvent(tx, {
      type: "VISUAL_BASELINE",
      websiteId,
      message: `ตั้งภาพหน้าเว็บปัจจุบันเป็นต้นแบบใหม่ (โดย ${user.username})`,
    });
    return true;
  });
  if (!done) throw new HttpError(409, "ยังไม่มีภาพล่าสุดของเว็บนี้");
  return NextResponse.json({ ok: true, message: "ตั้งเป็นภาพต้นแบบแล้ว" });
});
