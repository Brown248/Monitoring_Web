import "server-only";
import type { UserRole } from "@app/core";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { getCurrentUser, type CurrentUser } from "./auth";
import { getEnv } from "./env";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export function jsonError(status: number, message: string, fields?: Record<string, string>) {
  return NextResponse.json({ error: message, ...(fields ? { fields } : {}) }, { status });
}

/** แปลง zod issues เป็น { field: message } ให้ฟอร์มแสดงใต้ช่องที่ผิด */
export function zodFields(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    // ช่องรายการ (อีเมล/คำค้น): error ของรายการย่อย "alertEmails.2" แสดงใต้ช่อง "alertEmails" พร้อมบอกว่าบรรทัดไหน
    // (เก็บ key เต็มไว้ด้วย — ฟอร์มที่แสดง error รายบรรทัด เช่น steps.0.selector ใช้ key นี้)
    out[issue.path.join(".") || "_"] ??= issue.message;
    const at = issue.path.findIndex((p) => typeof p === "number");
    if (at > 0)
      out[issue.path.slice(0, at).join(".")] ??= `รายการที่ ${Number(issue.path[at]) + 1}: ${issue.message}`;
  }
  return out;
}

/** ขนาด body สูงสุดโดยปริยาย — ฟอร์มของระบบนี้เล็กกว่านี้มาก */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * อ่าน JSON body แบบจำกัดขนาด — Route Handler ของ Next ไม่จำกัดให้ (ส่งข้อมูลหลายร้อย MB มาที่หน้า login
 * โดยไม่ต้อง login ก็ทำให้ process หน่วยความจำเต็มได้) · เกิน = 413 โดยไม่อ่านต่อ
 */
export async function readJsonBody(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > maxBytes) throw new HttpError(413, "ข้อมูลที่ส่งมาใหญ่เกินไป");
  if (!req.body) throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "ข้อมูลที่ส่งมาใหญ่เกินไป");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)");
  }
}

export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<z.infer<S>> {
  const body = await readJsonBody(req, maxBytes);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "ข้อมูลไม่ถูกต้อง", zodFields(parsed.error));
  return parsed.data;
}

/** ชนกับ unique index ของฐานข้อมูล (เช่น สองคนเพิ่มข้อมูลเดียวกันพร้อมกัน) — ใช้ตอบ 409 แทน 500 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** ค่าแรกของ header ที่ proxy อาจต่อกันหลายค่า ("a, b") */
const firstValue = (v: string | null) => v?.split(",")[0]?.trim() || null;

/** คำขอที่แก้ข้อมูลต้องมาจากหน้าเว็บนี้เอง — Origin "null"/ผิดรูปแบบ = ปฏิเสธ (403 ไม่ใช่ 500) */
export function assertSameOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const host = firstValue(req.headers.get("x-forwarded-host")) ?? req.headers.get("host");
  if (!origin || !host) return;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost !== host) throw new HttpError(403, "Origin ไม่ตรงกับเว็บนี้");
}

/**
 * กันบันทึกทับกัน: หน้าเว็บส่ง x-base-version = updated_at ของข้อมูลตอนเปิดฟอร์ม
 * ถ้าข้อมูลในฐานข้อมูลเปลี่ยนไปแล้ว (มีคนอื่นบันทึกก่อน) → 409 แทนการเขียนทับเงียบ ๆ
 * ไม่ส่ง header (สคริปต์/เครื่องมืออื่น) = ไม่ตรวจ
 */
export function assertVersion(req: Request, current: Date | null | undefined): void {
  const base = req.headers.get("x-base-version");
  if (!base) return;
  // "none" = ตอนเปิดฟอร์มยังไม่เคยบันทึก — มีแล้วตอนนี้ = มีคนบันทึกครั้งแรกไปก่อน
  if (base === "none") {
    if (current)
      throw new HttpError(
        409,
        "มีผู้ดูแลคนอื่นบันทึกข้อมูลนี้ไปก่อนแล้ว — โหลดหน้าใหม่เพื่อดูค่าล่าสุดแล้วแก้อีกครั้ง",
      );
    return;
  }
  if (!current) return;
  if (new Date(current).toISOString() !== base)
    throw new HttpError(
      409,
      "มีผู้ดูแลคนอื่นบันทึกข้อมูลนี้ไปก่อนแล้ว — โหลดหน้าใหม่เพื่อดูค่าล่าสุดแล้วแก้อีกครั้ง",
    );
}

/**
 * IP ของผู้ใช้ — ใช้จำกัดการเดารหัสผ่าน
 * production (peer-ip.mjs ต่อ IP ของ socket ท้าย X-Forwarded-For): นับจากขวา ข้าม proxy ที่เชื่อถือ
 * TRUST_PROXY_HOPS ชั้น — ค่าทางซ้ายที่ผู้ใช้ใส่มาเองปลอมได้ จึงไม่ใช้ (เดิมใช้ค่าแรก = ปลอมได้ทุกครั้ง)
 */
export function clientIp(req: Request): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (process.env.WEB_PEER_IN_XFF === "1" && chain.length > 0) {
    const hops = getEnv().TRUST_PROXY_HOPS;
    return normalizeIp(chain[Math.max(0, chain.length - 1 - hops)]!);
  }
  // dev (next dev ไม่มี peer-ip.mjs)
  return normalizeIp(chain[0] ?? req.headers.get("x-real-ip") ?? "direct");
}

/** ::ffff:10.0.0.5 → 10.0.0.5 (IPv4 ที่มาทาง socket IPv6) */
function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/**
 * ตรวจ session + สิทธิ์ และกัน CSRF: request ที่เปลี่ยนข้อมูลต้องมาจาก origin เดียวกัน
 * (cookie เป็น SameSite=Lax อยู่แล้ว ตรงนี้เป็นชั้นที่สอง)
 */
export async function requireApi(req: Request, role?: UserRole): Promise<CurrentUser> {
  assertSameOrigin(req);
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "กรุณาเข้าสู่ระบบ");
  if (role === "ADMIN" && user.role !== "ADMIN") throw new HttpError(403, "ต้องเป็นผู้ดูแลระบบ (Admin)");
  return user;
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** ห่อ route handler: แปลง HttpError เป็น JSON และไม่ส่งรายละเอียด error ภายในให้ client */
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.message, err.fields);
      console.error(
        JSON.stringify({
          level: "error",
          msg: "api error",
          path: new URL(req.url).pathname,
          err: String(err),
        }),
      );
      return jsonError(500, "เกิดข้อผิดพลาดภายในระบบ");
    }
  };
}

export function parseId(raw: string): number {
  const id = Number(raw);
  // นอกช่วง int4 → 400 (ไม่ใช่ "integer out of range" 500 จากฐานข้อมูล)
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(400, "id ไม่ถูกต้อง");
  return id;
}
