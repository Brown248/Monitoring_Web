import {
  buildTestEmail,
  createMailTransport,
  effectiveFrom,
  isSmtpConfigured,
  sendMail,
  SmtpHostNotAllowedError,
  smtpErrorMessage,
} from "@app/core/server";
import { smtpSettingsSchema } from "@app/core";
import { getSettings } from "@app/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

// smtp = ค่าที่อยู่บนหน้าจอ (ยังไม่บันทึกก็ทดสอบได้) · ไม่ส่งมา = ใช้ค่าที่บันทึกไว้
const schema = z.object({ to: z.email("อีเมลผู้รับไม่ถูกต้อง"), smtp: smtpSettingsSchema.optional() });

/** ส่งอีเมลทดสอบด้วยค่าบนหน้าจอ (หรือค่าที่บันทึกไว้) — รหัสผ่านมาจาก .env เสมอ */
export const POST = route(async (req) => {
  await requireApi(req, "ADMIN");
  const body = await readJson(req, schema);
  const to = body.to;
  const saved = await getSettings(getDb(), "smtp");
  const smtp = body.smtp ?? saved;
  if (!isSmtpConfigured(smtp)) throw new HttpError(409, "กรุณากรอก SMTP host และชื่อผู้ส่งก่อน");
  const env = getEnv();
  // ค่าบนหน้าจอที่ยังไม่บันทึกทดสอบได้ แต่ถ้า host/ผู้ใช้ต่างจากที่บันทึกไว้ ต้องบันทึกก่อน
  // (กันกดทดสอบแล้วรหัสผ่านใน .env ถูกส่งไป server อื่นโดยไม่มีบันทึกว่าใครเปลี่ยน)
  const sameServer =
    smtp.host.trim().toLowerCase() === saved.host.trim().toLowerCase() &&
    smtp.username.trim().toLowerCase() === saved.username.trim().toLowerCase();
  if (env.SMTP_PASSWORD && smtp.username && !sameServer)
    throw new HttpError(409, "เปลี่ยน SMTP host หรือชื่อผู้ใช้ — กดบันทึกก่อน แล้วค่อยกดส่งอีเมลทดสอบ");
  let transport: ReturnType<typeof createMailTransport>;
  try {
    transport = createMailTransport(smtp, env.SMTP_PASSWORD, { allowedHosts: env.SMTP_ALLOWED_HOST });
  } catch (err) {
    if (err instanceof SmtpHostNotAllowedError) throw new HttpError(409, err.message);
    throw err;
  }
  try {
    const res = await sendMail(transport, effectiveFrom(smtp), { ...buildTestEmail(env.APP_BASE_URL), to });
    return NextResponse.json({ ok: true, message: `ส่งแล้ว · ${res.response || "SMTP OK"}` });
  } catch (err) {
    throw new HttpError(502, `ส่งไม่สำเร็จ: ${smtpErrorMessage(err)}`);
  } finally {
    transport.close();
  }
});
