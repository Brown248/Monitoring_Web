import "server-only";
import { isValidTimeZone, LOG_LEVELS, TIMEZONE_HINT } from "@app/core";
import { z } from "zod";

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.url(),
  APP_TIMEZONE: z.string().min(1).default("Asia/Bangkok").refine(isValidTimeZone, TIMEZONE_HINT),
  // true/false/1/0/yes/no (ไม่สนตัวพิมพ์/ช่องว่าง) · auto = ตาม APP_BASE_URL (https → secure)
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(["true", "false", "1", "0", "yes", "no", "auto", ""]))
    .transform((v) => (v === "auto" ? ("auto" as const) : v === "true" || v === "1" || v === "yes")),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(12),
  /** จำนวน reverse proxy ที่เชื่อถือหน้าเว็บนี้ (0 = เปิดตรง, 1 = มี nginx/Caddy 1 ชั้น) — ใช้หา IP จริงของผู้ใช้ */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  CANARY_URLS: z
    .string()
    .default("https://www.google.com/generate_204,https://www.cloudflare.com/cdn-cgi/trace"),
  // secret — ใช้เพื่อทดสอบการเชื่อมต่อจากหน้าตั้งค่า และแสดงว่า "ตั้งค่าแล้ว" เท่านั้น (ไม่แสดงค่า)
  SMTP_PASSWORD: optionalText,
  /** server ที่อนุญาตให้ส่ง SMTP_PASSWORD ไป (คั่นด้วย comma) — ไม่ตั้ง = ไม่ล็อก */
  SMTP_ALLOWED_HOST: optionalText,
  AI_API_KEY: optionalText,
  AI_BASE_URL: optionalText,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalText,
  BACKUP_DESTINATION: optionalText,
});

export type WebEnv = z.infer<typeof schema>;

let cached: WebEnv | undefined;

/** parse ตอนเรียกใช้ครั้งแรก (ไม่ใช่ตอน import) เพื่อให้ `next build` ผ่านโดยไม่ต้องมี secret */
export function getEnv(): WebEnv {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid web environment:\n${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** cookie แบบ secure ส่งได้เฉพาะ https */
export function cookieSecure(): boolean {
  const env = getEnv();
  return env.COOKIE_SECURE === "auto" ? env.APP_BASE_URL.startsWith("https://") : env.COOKIE_SECURE;
}

export function tz(): string {
  return getEnv().APP_TIMEZONE;
}
