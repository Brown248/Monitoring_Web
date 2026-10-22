import { z } from "zod";
import { maxRoundSeconds } from "./website-constants";

export const checkDefaultsSchema = z
  .object({
    checkIntervalSeconds: z.number().int().min(60).max(86_400),
    timeoutSeconds: z.number().int().min(1).max(60),
    retryCount: z.number().int().min(0).max(5),
    retryDelaySeconds: z.number().int().min(0).max(30),
    confirmDownCount: z.number().int().min(1).max(10),
    confirmRecoveryCount: z.number().int().min(1).max(10),
    concurrency: z.number().int().min(1).max(50),
    /** ตอบช้ากว่านี้ (ms) นับว่า "ช้า" — ใช้กับเว็บที่ไม่ได้ตั้งเกณฑ์ DEGRADED ของตัวเอง */
    slowThresholdMs: z.number().int().min(200).max(60_000),
  })
  .superRefine((v, ctx) => {
    // กฎเดียวกับฟอร์มเว็บไซต์ — ไม่งั้นค่าเริ่มต้นที่บันทึกได้ จะทำให้ฟอร์มเพิ่มเว็บใหม่ error ทันที
    if (maxRoundSeconds(v) >= v.checkIntervalSeconds)
      ctx.addIssue({
        code: "custom",
        path: ["timeoutSeconds"],
        message: "เวลาสูงสุดต่อรอบ (Timeout × ครั้ง + รอ Retry) ต้องน้อยกว่ารอบตรวจ",
      });
  });

/** รายการอีเมลผู้รับ — ตัดซ้ำ/ตัวพิมพ์ใหญ่ */
export const emailListSchema = z
  .array(z.string().trim().toLowerCase().pipe(z.email("อีเมลไม่ถูกต้อง")))
  .max(30, "ผู้รับได้สูงสุด 30 คน")
  .transform((list) => [...new Set(list)]);

/** รวมผู้รับจากหลายรายการ (ผู้รับของเว็บ + ผู้รับทุกเว็บ ฯลฯ) ไม่ให้ใครได้เมลซ้ำ */
export function mergeRecipients(...lists: Array<readonly string[] | null | undefined>): string[] {
  return [
    ...new Set(
      lists
        .flatMap((l) => l ?? [])
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export const smtpSettingsSchema = z.object({
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(["STARTTLS", "SSL", "NONE"]),
  username: z.string().trim().max(255),
  from: z.string().trim().max(320),
  /** ผู้รับแจ้งเตือนของทุกเว็บ (ล่ม/กลับมา/ความปลอดภัย) — รวมกับผู้รับของแต่ละเว็บ */
  alertEmails: emailListSchema.default([]),
});

/** คำที่มักพบเมื่อเว็บองค์กรถูกแฮกฝังลิงก์พนัน/เปลี่ยนหน้า (ตรวจแบบไม่สนตัวพิมพ์) */
export const DEFAULT_DEFACE_KEYWORDS = [
  "hacked by",
  "defaced by",
  "สล็อต",
  "บาคาร่า",
  "แทงบอล",
  "เว็บตรง",
  "คาสิโนออนไลน์",
  "หวยออนไลน์",
  "pg slot",
  "slot gacor",
  "ufabet",
  "เครดิตฟรี",
];

export const AI_PROVIDERS = ["none", "openai", "anthropic"] as const;

export const aiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  model: z.string().trim().max(100),
  monthlyLimit: z.number().int().min(0).max(100_000),
  autoAnalyze: z.boolean(),
  thai: z.boolean(),
  /** ให้ AI ร่างรายงานสรุปเหตุ (postmortem) อัตโนมัติเมื่อ Incident ปิด */
  autoPostmortem: z.boolean(),
  /** ร่าง postmortem อัตโนมัติเฉพาะ Incident ที่ล่มนานอย่างน้อยกี่นาที */
  postmortemMinMinutes: z.number().int().min(0).max(1440),
});

const keywordListSchema = z
  .array(z.string().trim().toLowerCase().min(2).max(60))
  .max(100)
  .transform((list) => [...new Set(list)]);

const domainListSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, "รูปแบบโดเมนไม่ถูกต้อง"),
  )
  .max(50)
  .transform((list) => [...new Set(list)]);

/** ฟีเจอร์ด้านความปลอดภัยของเว็บ (ตรวจหน้าเว็บถูกแก้, โดเมนปลอม, คะแนนความปลอดภัย) */
export const securitySettingsSchema = z.object({
  /** ถ่ายภาพหน้าเว็บด้วย browser จริงแล้วเทียบกับภาพต้นแบบ */
  visualEnabled: z.boolean(),
  visualIntervalMinutes: z.union([
    z.literal(60),
    z.literal(180),
    z.literal(360),
    z.literal(720),
    z.literal(1440),
  ]),
  /** % พิกเซลที่เปลี่ยนจากต้นแบบที่ถือว่าผิดปกติ */
  visualThresholdPct: z.number().int().min(2).max(90),
  /** คำที่ไม่ควรปรากฏในหน้าเว็บบริษัท (เช่น เว็บพนันที่ถูกฝัง) */
  defaceKeywords: keywordListSchema,
  /** สแกนความปลอดภัยแบบ passive วันละครั้ง */
  scanEnabled: z.boolean(),
  /** เฝ้า Certificate Transparency หาโดเมนเลียนแบบ */
  ctEnabled: z.boolean(),
  /** ชื่อแบรนด์/คำที่ใช้ค้นหาโดเมนเลียนแบบ เช่น "mycompany" */
  brandKeywords: keywordListSchema,
  /** โดเมนของบริษัทเอง (ไม่นับเป็นโดเมนปลอม รวม subdomain) */
  ownDomains: domainListSchema,
  /** ผู้รับแจ้งเตือนด้านความปลอดภัย (นอกจากผู้รับของแต่ละเว็บ) */
  alertEmails: emailListSchema,
});

export const sheetsSettingsSchema = z.object({
  spreadsheetId: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9_-]*$/, "Spreadsheet ID มีอักขระที่ไม่ถูกต้อง"),
  interval: z.enum(["hourly", "daily", "manual"]),
  incidentSheet: z.string().trim().min(1).max(100),
  uptimeSheet: z.string().trim().min(1).max(100),
  checksSheet: z.string().trim().min(1).max(100),
  sendIncidents: z.boolean(),
  sendDailyUptime: z.boolean(),
  sendChecks: z.boolean(),
});

/** 0 = เก็บตลอด */
export const retentionSettingsSchema = z.object({
  checksDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180), z.literal(365)]),
  dailySummaryDays: z.union([z.literal(365), z.literal(730), z.literal(1825), z.literal(0)]),
  incidentDays: z.union([z.literal(365), z.literal(730), z.literal(0)]),
});

/** ฟีเจอร์วิเคราะห์เชิงลึก (วินิจฉัย, ติดตามการเปลี่ยนแปลง, เตือนก่อนล่ม, ทดสอบหลัง login) */
export const insightsSettingsSchema = z.object({
  /** วินิจฉัยอัตโนมัติทุกครั้งที่เปิด Incident */
  autoDiagnose: z.boolean(),
  /** เก็บลายนิ้วมือ (IP/DNS/ใบรับรอง/header) ทุกกี่นาที — 0 = ปิด */
  fingerprintMinutes: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60), z.literal(180)]),
  /** เตือนเมื่อช้า/ล้มเหลวผิดปกติเทียบกับพฤติกรรมปกติของเว็บ */
  anomalyEnabled: z.boolean(),
  /** low = เตือนเฉพาะผิดปกติมาก, high = ไวขึ้น */
  anomalySensitivity: z.enum(["low", "normal", "high"]),
  /** ทดสอบใช้งานด้วย browser ตามขั้นตอนที่ตั้งไว้ของแต่ละเว็บ */
  journeysEnabled: z.boolean(),
});

export type CheckDefaults = z.infer<typeof checkDefaultsSchema>;
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export type SheetsSettings = z.infer<typeof sheetsSettingsSchema>;
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export type InsightsSettings = z.infer<typeof insightsSettingsSchema>;

export interface SettingsMap {
  check_defaults: CheckDefaults;
  smtp: SmtpSettings;
  ai: AiSettings;
  sheets: SheetsSettings;
  retention: RetentionSettings;
  security: SecuritySettings;
  insights: InsightsSettings;
}
export type SettingsKey = keyof SettingsMap;

export const SETTINGS_SCHEMAS: { [K in SettingsKey]: z.ZodType<SettingsMap[K]> } = {
  check_defaults: checkDefaultsSchema,
  smtp: smtpSettingsSchema,
  ai: aiSettingsSchema,
  sheets: sheetsSettingsSchema,
  retention: retentionSettingsSchema,
  security: securitySettingsSchema,
  insights: insightsSettingsSchema,
};

export const SETTINGS_DEFAULTS: SettingsMap = {
  check_defaults: {
    checkIntervalSeconds: 300,
    timeoutSeconds: 10,
    retryCount: 2,
    retryDelaySeconds: 3,
    confirmDownCount: 2,
    confirmRecoveryCount: 2,
    concurrency: 10,
    slowThresholdMs: 3000,
  },
  smtp: { host: "", port: 587, security: "STARTTLS", username: "", from: "", alertEmails: [] },
  ai: {
    provider: "none",
    model: "",
    monthlyLimit: 200,
    autoAnalyze: true,
    thai: true,
    autoPostmortem: true,
    postmortemMinMinutes: 5,
  },
  sheets: {
    spreadsheetId: "",
    interval: "hourly",
    incidentSheet: "Incidents",
    uptimeSheet: "Daily Uptime",
    checksSheet: "Check History",
    sendIncidents: true,
    sendDailyUptime: true,
    sendChecks: false,
  },
  retention: { checksDays: 90, dailySummaryDays: 730, incidentDays: 0 },
  security: {
    visualEnabled: true,
    visualIntervalMinutes: 360,
    visualThresholdPct: 25,
    defaceKeywords: DEFAULT_DEFACE_KEYWORDS,
    scanEnabled: true,
    ctEnabled: true,
    brandKeywords: [],
    ownDomains: [],
    alertEmails: [],
  },
  insights: {
    autoDiagnose: true,
    fingerprintMinutes: 30,
    anomalyEnabled: true,
    anomalySensitivity: "normal",
    journeysEnabled: true,
  },
};

export function isSettingsKey(key: string): key is SettingsKey {
  // Object.hasOwn: "toString" / "constructor" ไม่ใช่หมวดการตั้งค่า
  return Object.hasOwn(SETTINGS_DEFAULTS, key);
}

/** อ่านค่าที่เก็บไว้ ถ้าไม่ผ่าน schema (เช่น เวอร์ชันเก่า) ใช้ค่า default แทน */
export function parseSettings<K extends SettingsKey>(key: K, raw: unknown): SettingsMap[K] {
  const merged = { ...SETTINGS_DEFAULTS[key], ...(raw && typeof raw === "object" ? raw : {}) };
  const parsed = SETTINGS_SCHEMAS[key].safeParse(merged);
  return parsed.success ? parsed.data : SETTINGS_DEFAULTS[key];
}
