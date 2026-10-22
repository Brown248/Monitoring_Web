import { wouldCreateCycle, type Edge } from "@app/core";
import { logEvent, recheckRootCauses, sql } from "@app/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, parseId, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ dependsOn: z.array(z.number().int().positive()).max(50) });

/** ตั้งรายการระบบที่เว็บนี้พึ่งพา (แทนที่ทั้งชุด) — กันการพึ่งพาวนกลับมาหาตัวเอง */
export const PUT = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const { dependsOn } = await readJson(req, schema);
  const wanted = [...new Set(dependsOn)].filter((x) => x !== id);
  const message = await getDb().transaction(async (tx) => {
    // ล็อกสั้น ๆ กันสองคนแก้พร้อมกันแล้วเกิดวงวน
    await tx.execute(sql`LOCK TABLE website_dependencies IN SHARE ROW EXCLUSIVE MODE`);
    const sites = await tx.execute<{ id: number; name: string }>(
      sql`SELECT id, name FROM websites WHERE archived_at IS NULL`,
    );
    const names = new Map(sites.rows.map((s) => [Number(s.id), s.name]));
    if (!names.has(id)) throw new HttpError(404, "ไม่พบเว็บไซต์");
    if (wanted.some((x) => !names.has(x))) throw new HttpError(400, "มีเว็บไซต์ที่ไม่พบในรายการ");
    const all = await tx.execute<{ website_id: number; depends_on_id: number }>(
      sql`SELECT website_id, depends_on_id FROM website_dependencies`,
    );
    // ชุดเดิมที่ผู้ใช้เห็นตอนเปิดฟอร์ม ≠ ชุดปัจจุบัน → มีคนแก้ไปก่อน (ไม่มี updated_at จึงเทียบที่เนื้อหา)
    const base = req.headers.get("x-base-version");
    if (base !== null) {
      const current = all.rows
        .filter((r) => Number(r.website_id) === id)
        .map((r) => Number(r.depends_on_id))
        .sort((a, b) => a - b)
        .join(",");
      if (current !== base)
        throw new HttpError(
          409,
          "มีผู้ดูแลคนอื่นแก้รายการนี้ไปก่อนแล้ว — โหลดหน้าใหม่เพื่อดูค่าล่าสุดแล้วแก้อีกครั้ง",
        );
    }
    const others = { rows: all.rows.filter((r) => Number(r.website_id) !== id) };
    const edges: Edge[] = others.rows.map((r) => [Number(r.website_id), Number(r.depends_on_id)] as const);
    for (const dep of wanted) {
      if (wouldCreateCycle(edges, id, dep))
        throw new HttpError(
          400,
          `${names.get(dep)} พึ่งพา ${names.get(id)} อยู่แล้ว (ทางตรงหรือทางอ้อม) — ตั้งให้พึ่งพากันวนไม่ได้`,
        );
      edges.push([id, dep]);
    }
    await tx.execute(sql`DELETE FROM website_dependencies WHERE website_id = ${id}`);
    if (wanted.length)
      await tx.execute(
        sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES ${sql.join(
          wanted.map((d) => sql`(${id}, ${d})`),
          sql`, `,
        )}`,
      );
    // เลิกพึ่งพาระบบที่กำลังล่มอยู่ → Incident ของเว็บนี้ไม่ใช่ "ล่มตามกัน" แล้ว ต้องแจ้งเตือนเอง (และกลับกัน)
    await recheckRootCauses(tx, [id]);
    await logEvent(tx, {
      type: "DEPENDENCIES_UPDATED",
      websiteId: id,
      message: `ตั้งระบบที่ ${names.get(id)} พึ่งพา (โดย ${user.username})`,
      detail: wanted.length ? wanted.map((d) => names.get(d)).join(", ") : "ไม่พึ่งพาระบบใด",
    });
    return wanted.length ? `บันทึกแล้ว — พึ่งพา ${wanted.length} ระบบ` : "บันทึกแล้ว — ไม่พึ่งพาระบบใด";
  });
  return NextResponse.json({ ok: true, message });
});
