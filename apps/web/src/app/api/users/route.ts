import { createUserSchema } from "@app/core";
import { eq, logEvent, users } from "@app/db";
import { NextResponse } from "next/server";
import { HttpError, isUniqueViolation, readJson, requireApi, route } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const POST = route(async (req) => {
  const actor = await requireApi(req, "ADMIN");
  const body = await readJson(req, createUserSchema);
  const db = getDb();
  const dupError = () => new HttpError(409, "มีชื่อผู้ใช้นี้แล้ว", { username: "ชื่อผู้ใช้นี้ถูกใช้แล้ว" });
  const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.username, body.username));
  if (dup) throw dupError();
  // สองคนสร้างชื่อเดียวกันพร้อมกัน → unique index กันไว้ ตอบ 409 แทน 500
  const [u] = await db
    .insert(users)
    .values({ username: body.username, passwordHash: await hashPassword(body.password), role: body.role })
    .returning({ id: users.id })
    .catch((err: unknown) => {
      throw isUniqueViolation(err) ? dupError() : err;
    });
  await logEvent(db, {
    type: "USER_CREATED",
    message: `เพิ่มผู้ใช้ ${body.username} (${body.role}) โดย ${actor.username}`,
  });
  return NextResponse.json({ id: u!.id }, { status: 201 });
});
