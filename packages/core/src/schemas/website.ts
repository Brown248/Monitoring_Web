import { z } from "zod";
import { checkTargetUrl } from "../ssrf/validate-url";
import { parseUpStatusCodes } from "../status/up-codes";
import { maxRoundSeconds } from "./website-constants";

/**
 * รูปแบบมาตรฐานของ URL: host ตัวเล็ก, ไม่มีพอร์ตมาตรฐาน, path อย่างน้อย "/", ไม่มี #fragment
 * → "HTTPS://Example.com:443/#a" กับ "https://example.com" นับเป็นเว็บเดียวกัน (ไม่ตรวจซ้ำ/ส่งอีเมลซ้ำ)
 */
export function normalizeUrl(value: string): string {
  try {
    const u = new URL(value.trim());
    u.hash = "";
    return u.href;
  } catch {
    return value.trim();
  }
}

/** http/https เท่านั้น, ไม่มี credential และไม่ใช่ IP ภายใน (hostname ถูกตรวจซ้ำตอนเชื่อมต่อจริง) */
export const websiteUrlSchema = z
  .string()
  .trim()
  .min(1, "กรุณาระบุ URL")
  .max(2048)
  .superRefine((value, ctx) => {
    const res = checkTargetUrl(value);
    if (!res.ok) ctx.addIssue({ code: "custom", message: res.message });
  })
  .transform(normalizeUrl);

const upCodesSchema = z
  .string()
  .trim()
  .max(200)
  .superRefine((value, ctx) => {
    const res = parseUpStatusCodes(value);
    if (!res.ok) ctx.addIssue({ code: "custom", message: res.error });
  });

const emailListSchema = z
  .array(z.string().trim().toLowerCase().pipe(z.email("อีเมลไม่ถูกต้อง")))
  .max(20, "ผู้รับอีเมลได้สูงสุด 20 คน")
  .transform((list) => [...new Set(list)]);

/** ค่าจากฟอร์มเพิ่ม/แก้ไขเว็บไซต์ (หน่วยวินาทีตามที่แสดงในฟอร์ม) */
export const websiteFormSchema = z
  .object({
    name: z.string().trim().min(1, "กรุณาระบุชื่อเว็บไซต์").max(200),
    url: websiteUrlSchema,
    enabled: z.boolean(),
    checkIntervalSeconds: z.number().int().min(60).max(86_400),
    timeoutSeconds: z.number().int().min(1).max(60),
    retryCount: z.number().int().min(0).max(5),
    retryDelaySeconds: z.number().int().min(0).max(30),
    confirmDownCount: z.number().int().min(1).max(10),
    confirmRecoveryCount: z.number().int().min(1).max(10),
    upStatusCodes: upCodesSchema,
    degradedThresholdMs: z.number().int().min(100).max(60_000).nullable(),
    treatAuthAsUp: z.boolean(),
    followRedirects: z.boolean(),
    alertEmails: emailListSchema,
    sendRecovery: z.boolean(),
    aiAutoAnalyze: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (maxRoundSeconds(v) >= v.checkIntervalSeconds) {
      ctx.addIssue({
        code: "custom",
        path: ["timeoutSeconds"],
        message: "เวลาสูงสุดต่อรอบ (Timeout × ครั้ง + รอ Retry) ต้องน้อยกว่ารอบตรวจ",
      });
    }
  });

export type WebsiteFormInput = z.infer<typeof websiteFormSchema>;

/** แปลงค่าจากฟอร์มเป็นคอลัมน์ของตาราง websites */
export function websiteFormToRow(v: WebsiteFormInput) {
  return {
    name: v.name,
    url: v.url,
    enabled: v.enabled,
    checkIntervalSeconds: v.checkIntervalSeconds,
    timeoutMs: v.timeoutSeconds * 1000,
    retryCount: v.retryCount,
    retryDelayMs: v.retryDelaySeconds * 1000,
    confirmDownCount: v.confirmDownCount,
    confirmRecoveryCount: v.confirmRecoveryCount,
    upStatusCodes: v.upStatusCodes,
    degradedThresholdMs: v.degradedThresholdMs,
    treatAuthAsUp: v.treatAuthAsUp,
    followRedirects: v.followRedirects,
    alertEmails: v.alertEmails,
    sendRecovery: v.sendRecovery,
    aiAutoAnalyze: v.aiAutoAnalyze,
  };
}

export const testUrlSchema = z.object({ url: z.string().trim().min(1).max(2048) });
export const toggleEnabledSchema = z.object({ enabled: z.boolean() });
