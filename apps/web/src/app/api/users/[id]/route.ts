import { updateUserSchema } from "@app/core";
import { and, count, eq, logEvent, ne, sql, users } from "@app/db";
import { NextResponse } from "next/server";
import { HttpError, parseId, readJson, requireApi, route } from "@/lib/api";
import { hashPassword, revokeUserSessions } from "@/lib/auth";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const actor = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  if (id === actor.id) throw new HttpError(400, "แก้สิทธิ์ของตัวเองไม่ได้ — ใช้ปุ่มเปลี่ยนรหัสผ่านแทน");
  const body = await readJson(req, updateUserSchema);
  const db = getDb();
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  const target = await db.transaction(async (tx) => {
    // ล็อกการแก้สิทธิ์ทีละคำขอ — Admin 2 คนลดสิทธิ์กันพร้อมกันจะไม่ทำให้เหลือ Admin 0 คน
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('users:admin-count'))`);
    const [row] = await tx.select().from(users).where(eq(users.id, id));
    if (!row) throw new HttpError(404, "ไม่พบผู้ใช้");

    // ต้องเหลือ Admin ที่ใช้งานได้อย่างน้อย 1 คนเสมอ
    const losingAdmin = row.role === "ADMIN" && (body.role === "VIEWER" || body.isActive === false);
    if (losingAdmin) {
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, "ADMIN"), eq(users.isActive, true), ne(users.id, id)))) as [{ n: number }];
      if (Number(n) === 0) throw new HttpError(409, "ต้องมี Admin ที่ใช้งานได้อย่างน้อย 1 คน");
    }

    await tx
      .update(users)
      .set({
        ...(body.role ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(passwordHash || body.unlock ? { failedLoginCount: 0, lockedUntil: null } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      })
      .where(eq(users.id, id));
    return row;
  });
  // เปลี่ยนรหัสผ่าน/ปิดใช้งาน/เปลี่ยนสิทธิ์จริง → ให้ login ใหม่ (กดบันทึกโดยไม่แก้อะไร = ไม่ต้อง logout)
  if (body.password || body.isActive === false || (body.role && body.role !== target.role))
    await revokeUserSessions(id);
  await logEvent(db, {
    type: "USER_UPDATED",
    message: `แก้ไขผู้ใช้ ${target.username} โดย ${actor.username}`,
  });
  return NextResponse.json({ ok: true });
});
