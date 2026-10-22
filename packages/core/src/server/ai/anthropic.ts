import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import {
  AiError,
  analysisSchema,
  type AnalysisResult,
  type AnalyzeRequest,
  type ProviderConfig,
} from "./types";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

function client(cfg: ProviderConfig): Anthropic {
  return new Anthropic({ apiKey: cfg.apiKey, maxRetries: 2, timeout: 120_000 });
}

function toAiError(err: unknown): AiError {
  if (err instanceof Anthropic.AuthenticationError) return new AiError("API key ไม่ถูกต้อง (401)", false);
  if (err instanceof Anthropic.PermissionDeniedError)
    return new AiError("ไม่มีสิทธิ์ใช้งาน model นี้ (403)", false);
  if (err instanceof Anthropic.NotFoundError) return new AiError("ไม่พบ model ที่ระบุ (404)", false);
  if (err instanceof Anthropic.BadRequestError)
    return new AiError(`คำขอไม่ถูกต้อง: ${err.message}`.slice(0, 300), false);
  if (err instanceof Anthropic.RateLimitError)
    return new AiError("ถูกจำกัดอัตราการเรียก/โควตาหมด (429)", true);
  if (err instanceof Anthropic.APIError)
    return new AiError(`API error ${err.status ?? ""}: ${err.message}`.slice(0, 300), true);
  return new AiError(err instanceof Error ? err.message.slice(0, 300) : String(err), true);
}

export async function analyzeWithAnthropic(
  cfg: ProviderConfig,
  req: AnalyzeRequest,
): Promise<AnalysisResult> {
  return parseWithAnthropic(cfg, req, analysisSchema);
}

/** structured output แบบทั่วไปด้วย zod schema */
export async function parseWithAnthropic<T>(
  cfg: ProviderConfig,
  req: AnalyzeRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const response = await client(cfg).beta.messages.parse({
      model: cfg.model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 16000,
      // ถ้า model ปฏิเสธด้วยเหตุผลด้าน safety ให้ server ส่งต่อไปยัง model สำรองอัตโนมัติ
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(schema) },
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    if (response.stop_reason === "refusal") throw new AiError("AI ปฏิเสธการวิเคราะห์ (refusal)", false);
    // ลองใหม่ก็ยาวเท่าเดิม — ไม่ retry (เสียโควตาเปล่า 3 รอบ)
    if (response.stop_reason === "max_tokens") throw new AiError("คำตอบยาวเกิน max_tokens", false);
    if (!response.parsed_output) throw new AiError("AI ตอบกลับในรูปแบบที่อ่านไม่ได้", true);
    return response.parsed_output as T;
  } catch (err) {
    throw err instanceof AiError ? err : toAiError(err);
  }
}

/** ทดสอบ key + model ผ่าน Models API (ไม่เสีย token) */
export async function testAnthropic(cfg: ProviderConfig): Promise<string> {
  try {
    const m = await client(cfg).models.retrieve(cfg.model || ANTHROPIC_DEFAULT_MODEL);
    return `เชื่อมต่อได้ · ${m.display_name} (${m.id})`;
  } catch (err) {
    throw toAiError(err);
  }
}
