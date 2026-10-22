import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { SmtpSettings } from "../schemas/settings";

/** ค่าที่ใช้เชื่อมต่อ/ส่งเท่านั้น (ไม่รวมรายชื่อผู้รับ) */
export type SmtpConnection = Omit<SmtpSettings, "alertEmails">;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  messageId: string;
  response: string;
}

export function isSmtpConfigured(s: SmtpConnection): boolean {
  return s.host.trim() !== "" && s.from.trim() !== "";
}

/**
 * ผู้ส่งจริงที่ใช้ส่ง — ช่อง From ใส่แค่ชื่อ (ไม่มีอีเมล) ได้: ใช้ชื่อนั้นคู่กับ username ของ SMTP
 * (Microsoft 365/Gmail รับเมลไว้ก่อนแล้วทิ้งเงียบ ๆ ถ้าผู้ส่งไม่มีอีเมลหรือไม่ตรงกับบัญชีที่ login)
 */
export function effectiveFrom(s: SmtpConnection): string {
  const from = s.from.trim();
  if (senderDomain(from)) return from;
  const user = s.username.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user)) return from;
  const name = from.replace(/["\\]/g, "");
  return name ? `"${name}" <${user}>` : user;
}

/** โดเมนของผู้ส่ง จาก "ชื่อ <a@b.com>" หรือ "a@b.com" — ไม่มี = null */
export function senderDomain(from: string): string | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*>?\s*$/i.exec(from.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export class SmtpHostNotAllowedError extends Error {
  constructor(host: string, allowed: string) {
    super(
      `SMTP host "${host}" ไม่ตรงกับ SMTP_ALLOWED_HOST ใน .env (${allowed}) — ไม่ส่งรหัสผ่านไป server อื่น`,
    );
    this.name = "SmtpHostNotAllowedError";
  }
}

/**
 * SMTP_ALLOWED_HOST (ใน .env, คั่นด้วย comma) = server ที่อนุญาตให้ส่ง SMTP_PASSWORD ไปได้
 * ผู้ดูแลเว็บแก้ host ในหน้าตั้งค่าได้ แต่รหัสผ่านอยู่ใน .env ของผู้ดูแลเครื่อง — ล็อกไว้กันรหัสถูกส่งไป server ของคนอื่น
 * ไม่ตั้ง = ไม่ล็อก (ใช้ได้ทุก host)
 */
export function assertSmtpHostAllowed(host: string, allowedHosts: string | undefined): void {
  const allowed = (allowedHosts ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return;
  if (!allowed.includes(host.trim().toLowerCase().replace(/\.$/, ""))) {
    throw new SmtpHostNotAllowedError(host, allowed.join(", "));
  }
}

/** password มาจาก SMTP_PASSWORD ใน .env เท่านั้น — ไม่เก็บใน DB */
export function createMailTransport(
  s: SmtpConnection,
  password: string | undefined,
  opts: { allowedHosts?: string } = {},
) {
  if (password) assertSmtpHostAllowed(s.host, opts.allowedHosts);
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "SSL",
    requireTLS: s.security === "STARTTLS",
    ignoreTLS: s.security === "NONE",
    auth: s.username ? { user: s.username, pass: password ?? "" } : undefined,
    // แนะนำตัวกับ SMTP server ด้วยโดเมนของผู้ส่ง ไม่ใช่ชื่อเครื่อง/"localhost"
    ...(senderDomain(effectiveFrom(s)) ? { name: senderDomain(effectiveFrom(s))! } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export type MailTransport = ReturnType<typeof createMailTransport>;

export async function sendMail(
  transport: MailTransport,
  from: string,
  msg: MailMessage,
): Promise<SendResult> {
  const domain = senderDomain(from);
  const info = await transport.sendMail({
    from,
    // Message-ID ลงท้าย @localhost ทำให้ตัวกรองสแปม (เช่น Microsoft 365) ให้คะแนนแย่ — ใช้โดเมนของผู้ส่ง
    ...(domain ? { messageId: `<${randomUUID()}@${domain}>` } : {}),
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  return { messageId: String(info.messageId ?? ""), response: String(info.response ?? "").slice(0, 200) };
}

/** ตรวจว่าเชื่อมต่อและ login SMTP ได้ (ไม่ส่งอีเมล) */
export async function verifySmtp(transport: MailTransport): Promise<void> {
  await transport.verify();
}

/** ตัดข้อความ error ให้ปลอดภัยต่อการบันทึก (ไม่มี credential) */
export function smtpErrorMessage(err: unknown): string {
  const e = err as { responseCode?: number; response?: string; code?: string; message?: string };
  if (e.responseCode && e.response) return `${e.responseCode} ${e.response}`.slice(0, 300);
  return `${e.code ? `${e.code} · ` : ""}${e.message ?? String(err)}`.slice(0, 300);
}
