import { z } from "zod";

// ขั้นตอนการทดสอบใช้งานด้วย browser จริง (isomorphic — ใช้ทั้งฟอร์มหน้าเว็บและ worker)

export const JOURNEY_ACTIONS = ["goto", "fill", "click", "waitFor", "expectText", "expectNoText"] as const;
export type JourneyAction = (typeof JOURNEY_ACTIONS)[number];

export const JOURNEY_ACTION_LABEL: Record<JourneyAction, string> = {
  goto: "เปิดหน้า",
  fill: "กรอกช่อง",
  click: "คลิก",
  waitFor: "รอให้เห็น",
  expectText: "ต้องเห็นข้อความ",
  expectNoText: "ต้องไม่เห็นข้อความ",
};

/** ค่าที่ขึ้นต้นด้วย secret: จะอ่านจาก .env ของ Worker (JOURNEY_<NAME>) — ไม่เก็บรหัสผ่านใน DB */
export const SECRET_PREFIX = "secret:";
export const secretEnvName = (name: string) => `JOURNEY_${name.toUpperCase()}`;
/**
 * โดเมนที่อนุญาตให้ใช้ secret นี้ (ผู้ดูแลเครื่องกำหนดใน .env ของ Worker) — ชื่อเต็มก่อน แล้วค่อยส่วนหน้า "_" แรก
 * เช่น secret:CRM_PASS → JOURNEY_CRM_PASS_DOMAIN หรือ JOURNEY_CRM_DOMAIN
 * (secret ทุกตัวอยู่ใน .env เดียวกัน — ไม่ผูกโดเมน ผู้ดูแลเว็บคนไหนก็ตั้ง journey บนเว็บของตัวเองแล้วดึงรหัสของเว็บอื่นได้)
 */
export const secretDomainEnvNames = (name: string): string[] => {
  const upper = name.toUpperCase();
  const prefix = upper.split("_")[0]!;
  return [...new Set([`JOURNEY_${upper}_DOMAIN`, `JOURNEY_${prefix}_DOMAIN`])];
};

const stepSchema = z
  .object({
    action: z.enum(JOURNEY_ACTIONS),
    selector: z.string().trim().max(300).optional(),
    value: z.string().max(500).optional(),
  })
  .superRefine((s, ctx) => {
    const need = (field: "selector" | "value", msg: string) => {
      if (!s[field]?.trim()) ctx.addIssue({ code: "custom", path: [field], message: msg });
    };
    if (s.action === "goto") need("value", "ใส่ URL ที่จะเปิด");
    if (s.action === "fill") {
      need("selector", "ใส่ selector ของช่อง");
      need("value", "ใส่ค่าที่จะกรอก");
    }
    if (s.action === "click" || s.action === "waitFor") need("selector", "ใส่ selector");
    if (s.action === "expectText" || s.action === "expectNoText") need("value", "ใส่ข้อความ");
    if (s.value?.startsWith(SECRET_PREFIX) && !/^secret:[A-Za-z0-9_]{1,40}$/.test(s.value))
      ctx.addIssue({ code: "custom", path: ["value"], message: "รูปแบบ secret:ชื่อ (A-Z, 0-9, _)" });
    if (s.action === "goto" && s.value && !/^https?:\/\//i.test(s.value))
      ctx.addIssue({ code: "custom", path: ["value"], message: "URL ต้องขึ้นต้นด้วย http:// หรือ https://" });
  });

export const journeySchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  steps: z.array(stepSchema).min(1, "ต้องมีอย่างน้อย 1 ขั้นตอน").max(25),
});
export type JourneyInput = z.infer<typeof journeySchema>;

/** แม่แบบ "ฟอร์ม Login" — selector ที่ใช้ได้กับเว็บส่วนใหญ่ แก้ได้ภายหลัง */
export function loginTemplate(url: string, secretName = "MYAPP"): JourneyInput["steps"] {
  return [
    { action: "goto", value: url },
    {
      action: "fill",
      selector: 'input[type="email"], input[name="username"], input[name="email"]',
      value: `secret:${secretName}_USER`,
    },
    { action: "fill", selector: 'input[type="password"]', value: `secret:${secretName}_PASS` },
    { action: "click", selector: 'button[type="submit"], input[type="submit"]' },
    { action: "waitFor", selector: "[ใส่ selector ที่เห็นเฉพาะหลัง login]" },
  ];
}

/** ชื่อ secret ที่ขั้นตอนใช้ (สำหรับแสดงว่าต้องตั้งตัวแปรอะไรใน .env) */
export function secretsUsed(steps: Array<{ value?: string }>): string[] {
  return [
    ...new Set(
      steps
        .map((s) => s.value)
        .filter((v): v is string => Boolean(v?.startsWith(SECRET_PREFIX)))
        .map((v) => secretEnvName(v.slice(SECRET_PREFIX.length))),
    ),
  ];
}
