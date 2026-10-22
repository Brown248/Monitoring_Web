import { journeySchema } from "@app/core";
import { journeys, logEvent, sql } from "@app/db";
import { NextResponse } from "next/server";
import { assertVersion, HttpError, parseId, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

async function siteName(id: number): Promise<string> {
  const r = await getDb().execute<{ name: string }>(
    sql`SELECT name FROM websites WHERE id = ${id} AND archived_at IS NULL`,
  );
  if (!r.rows[0]) throw new HttpError(404, "ไม่พบเว็บไซต์");
  return r.rows[0].name;
}

/** บันทึกขั้นตอนทดสอบใช้งานจริง (ค่า secret:ชื่อ เก็บแค่ชื่อ — ค่าจริงอยู่ใน .env ของ Worker) */
export const PUT = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const body = await readJson(req, journeySchema);
  const name = await siteName(id);
  const version = await getDb().transaction(async (tx) => {
    // กันผู้ดูแล 2 คนแก้ขั้นตอนพร้อมกันแล้วของคนแรกหายเงียบ ๆ
    const [cur] = (
      await tx.execute<{ updated_at: Date }>(
        sql`SELECT updated_at FROM journeys WHERE website_id = ${id} FOR UPDATE`,
      )
    ).rows;
    assertVersion(req, cur ? new Date(cur.updated_at) : null);
    const now = new Date();
    await tx
      .insert(journeys)
      .values({ websiteId: id, ...body, updatedAt: now })
      .onConflictDoUpdate({
        target: journeys.websiteId,
        set: {
          enabled: body.enabled,
          intervalMinutes: body.intervalMinutes,
          steps: body.steps,
          updatedAt: now,
        },
      });
    // ปิดการทดสอบ → ปิดการแจ้งเตือนที่ค้างอยู่ด้วย (ไม่มีอะไรมาปิดให้อัตโนมัติแล้ว)
    if (!body.enabled)
      await tx.execute(sql`
        UPDATE security_alerts SET acknowledged_at = now()
        WHERE website_id = ${id} AND type = 'JOURNEY_FAILED' AND acknowledged_at IS NULL
      `);
    await logEvent(tx, {
      type: "JOURNEY_UPDATED",
      websiteId: id,
      message: `แก้ไขการทดสอบใช้งานจริงของ ${name} (โดย ${user.username})`,
      detail: `${body.steps.length} ขั้นตอน · ทุก ${body.intervalMinutes} นาที · ${body.enabled ? "เปิด" : "ปิด"}`,
    });
    return now.toISOString();
  });
  return NextResponse.json({ ok: true, message: "บันทึกการทดสอบแล้ว", version });
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const name = await siteName(id);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM journeys WHERE website_id = ${id}`);
    // ไม่มีการทดสอบแล้ว → ปิดการแจ้งเตือนที่ค้างอยู่
    await tx.execute(sql`
      UPDATE security_alerts SET acknowledged_at = now()
      WHERE website_id = ${id} AND type = 'JOURNEY_FAILED' AND acknowledged_at IS NULL
    `);
    await logEvent(tx, {
      type: "JOURNEY_UPDATED",
      websiteId: id,
      message: `ลบการทดสอบใช้งานจริงของ ${name} (โดย ${user.username})`,
    });
  });
  return NextResponse.json({ ok: true, message: "ลบการทดสอบแล้ว" });
});
