import { isValidTimeZone, LOG_LEVELS, TIMEZONE_HINT } from "@app/core";
import { z } from "zod";

const int = (min: number, fallback: number) => z.coerce.number().int().min(min).default(fallback);
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.url(),
  APP_TIMEZONE: z.string().min(1).default("Asia/Bangkok").refine(isValidTimeZone, TIMEZONE_HINT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  WORKER_POLL_INTERVAL_MS: int(500, 2_000),
  // healthcheck ของ Docker ถือว่าตายถ้า heartbeat เก่ากว่า 90 วินาที — รอบต้องสั้นกว่านั้น
  WORKER_HEARTBEAT_INTERVAL_MS: int(5_000, 30_000).pipe(
    z.number().max(60_000, "ต้องไม่เกิน 60000 (60 วินาที)"),
  ),
  CHECK_MAX_BODY_BYTES: int(1_024, 65_536),
  /** ปลายทาง canary คั่นด้วย comma — ใช้แยกปัญหาเน็ตขาออกของ Worker ออกจากเว็บล่มจริง */
  CANARY_URLS: z
    .string()
    .default("https://www.google.com/generate_204,https://www.cloudflare.com/cdn-cgi/trace"),
  /** path ของ Chromium/Chrome/Edge สำหรับตรวจหน้าเว็บด้วยภาพ (ไม่ตั้ง = หาเองจากตำแหน่งมาตรฐาน) */
  CHROMIUM_PATH: optionalText,
  // secret — อยู่ใน .env เท่านั้น
  SMTP_PASSWORD: optionalText,
  /** server ที่อนุญาตให้ส่ง SMTP_PASSWORD ไป (คั่นด้วย comma) — ไม่ตั้ง = ไม่ล็อก */
  SMTP_ALLOWED_HOST: optionalText,
  AI_API_KEY: optionalText,
  AI_BASE_URL: optionalText,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalText,
});

export type WorkerEnv = z.infer<typeof schema> & { canaryUrls: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // prettifyError แสดงเฉพาะชื่อตัวแปรและเหตุผล ไม่แสดงค่า (กัน secret หลุดลง log)
    throw new Error(`Invalid worker environment:\n${z.prettifyError(parsed.error)}`);
  }
  const canaryUrls = parsed.data.CANARY_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ...parsed.data, canaryUrls };
}
