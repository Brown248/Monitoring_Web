// OpenAI-compatible Chat Completions (เลือกได้จากหน้าตั้งค่า) — เรียกผ่าน fetch
import { z } from "zod";
import {
  AiError,
  analysisSchema,
  type AnalysisResult,
  type AnalyzeRequest,
  type ProviderConfig,
} from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
});

function base(cfg: ProviderConfig): string {
  return (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function httpError(res: Response): Promise<AiError> {
  const retryable = res.status === 429 || res.status >= 500;
  const label =
    res.status === 401
      ? "API key ไม่ถูกต้อง"
      : res.status === 404
        ? "ไม่พบ model/endpoint"
        : res.status === 429
          ? "โควตาหมด/ถูกจำกัดอัตรา"
          : "API error";
  const body = (await res.text().catch(() => "")).slice(0, 200);
  return new AiError(`${label} (${res.status}) ${body}`.trim(), retryable);
}

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "facts", "possibleCauses", "nextSteps"],
  properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    possibleCauses: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
};

export async function analyzeWithOpenAi(cfg: ProviderConfig, req: AnalyzeRequest): Promise<AnalysisResult> {
  return parseWithOpenAi(cfg, req, analysisSchema, jsonSchema, "incident_analysis");
}

/** structured output แบบทั่วไป: ส่ง JSON schema (strict) แล้ว validate ซ้ำด้วย zod */
export async function parseWithOpenAi<T>(
  cfg: ProviderConfig,
  req: AnalyzeRequest,
  schema: z.ZodType<T>,
  json: Record<string, unknown>,
  name: string,
): Promise<T> {
  if (!cfg.model) throw new AiError("กรุณาระบุ Model ในหน้าตั้งค่า", false);
  let res: Response;
  try {
    res = await fetch(`${base(cfg)}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema: json },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new AiError(
      `เชื่อมต่อ AI provider ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!res.ok) throw await httpError(res);
  const parsed = responseSchema.safeParse(await res.json());
  if (!parsed.success) throw new AiError("รูปแบบคำตอบจาก provider ไม่ถูกต้อง", true);
  const choice = parsed.data.choices[0]!;
  if (choice.message.refusal) throw new AiError("AI ปฏิเสธการวิเคราะห์ (refusal)", false);
  // ถูกตัดเพราะยาวเกิน — ลองใหม่ก็ถูกตัดเหมือนเดิม
  if (choice.finish_reason === "length") throw new AiError("คำตอบยาวเกินขีดจำกัดของ model", false);
  try {
    return schema.parse(JSON.parse(choice.message.content ?? ""));
  } catch {
    throw new AiError("AI ตอบกลับในรูปแบบที่อ่านไม่ได้", true);
  }
}

export async function testOpenAi(cfg: ProviderConfig): Promise<string> {
  if (!cfg.model) throw new AiError("กรุณาระบุ Model", false);
  const res = await fetch(`${base(cfg)}/models/${encodeURIComponent(cfg.model)}`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  }).catch((err: unknown) => {
    throw new AiError(`เชื่อมต่อไม่ได้: ${err instanceof Error ? err.message : String(err)}`, true);
  });
  if (!res.ok) throw await httpError(res);
  return `เชื่อมต่อได้ · model ${cfg.model}`;
}
