import { loginSchema } from "@app/core";
import { NextResponse } from "next/server";
import { assertSameOrigin, clientIp, HttpError, readJson, route } from "@/lib/api";
import { login, setSessionCookie } from "@/lib/auth";
import { cookieSecure } from "@/lib/env";

export const POST = route(async (req) => {
  assertSameOrigin(req);
  // cookie secure บน http = เบราว์เซอร์ทิ้ง cookie → login สำเร็จแต่เด้งกลับหน้า login วนไม่จบ บอกสาเหตุตรง ๆ แทน
  const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim();
  if (cookieSecure() && proto === "http")
    throw new HttpError(
      500,
      "ตั้ง COOKIE_SECURE=true แต่เปิดเว็บผ่าน http:// — เบราว์เซอร์จะไม่เก็บ session · ใช้ https หรือตั้ง COOKIE_SECURE=false (หรือ auto)",
    );
  const body = await readJson(req, loginSchema);
  const res = await login(body.username, body.password, body.remember, clientIp(req));
  if (!res.ok) throw new HttpError(res.status, res.error);
  await setSessionCookie(res.token, res.expiresAt, res.remember);
  return NextResponse.json({ ok: true, user: res.user });
});
