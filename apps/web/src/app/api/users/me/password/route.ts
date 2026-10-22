import { changePasswordSchema } from "@app/core";
import { eq, users } from "@app/db";
import argon2 from "argon2";
import { NextResponse } from "next/server";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { currentToken, hashPassword, revokeUserSessions } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const POST = route(async (req) => {
  const me = await requireApi(req);
  const body = await readJson(req, changePasswordSchema);
  const db = getDb();
  const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, me.id));
  if (!u || !(await argon2.verify(u.hash, body.currentPassword).catch(() => false))) {
    throw new HttpError(400, "รหัสผ่านปัจจุบันไม่ถูกต้อง", { currentPassword: "รหัสผ่านปัจจุบันไม่ถูกต้อง" });
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(body.newPassword) })
    .where(eq(users.id, me.id));
  // ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้
  await revokeUserSessions(me.id, await currentToken());
  return NextResponse.json({ ok: true });
});
