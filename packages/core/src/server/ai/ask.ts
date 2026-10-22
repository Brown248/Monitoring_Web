import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { AiSettings } from "../../schemas/settings";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic";
import { effectiveModel, type AiEnv } from "./config";
import { AiError } from "./types";

/** เครื่องมืออ่านข้อมูล (read-only) ที่หน้าเว็บส่งให้ AI ใช้ตอบคำถาม */
export interface AskTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>): Promise<unknown>;
}

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskResult {
  answer: string;
  /** ชื่อเครื่องมือที่ AI เรียกใช้ (แสดงให้ผู้ใช้เห็นว่าคำตอบมาจากข้อมูลส่วนไหน) */
  toolsUsed: string[];
  model: string;
  /** จำนวนครั้งที่เรียก model จริง (1 + รอบที่เรียกเครื่องมือ) — ใช้นับโควตา */
  requests: number;
}

const MAX_TOOL_RESULT_CHARS = 30_000;

function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError("API key ไม่ถูกต้อง (401)", false);
  if (err instanceof Anthropic.PermissionDeniedError)
    return new AiError("ไม่มีสิทธิ์ใช้งาน model นี้ (403)", false);
  if (err instanceof Anthropic.NotFoundError) return new AiError("ไม่พบ model ที่ระบุ (404)", false);
  if (err instanceof Anthropic.RateLimitError)
    return new AiError("ถูกจำกัดอัตราการเรียก/โควตาหมด (429)", true);
  if (err instanceof Anthropic.APIError)
    return new AiError(`API error ${err.status ?? ""}: ${err.message}`.slice(0, 300), true);
  return new AiError(err instanceof Error ? err.message.slice(0, 300) : String(err), true);
}

/**
 * ตอบคำถามภาษาธรรมชาติจากข้อมูลจริงในระบบ: AI เลือกเรียกเครื่องมืออ่านข้อมูล (tool runner ของ SDK วน loop ให้)
 * เครื่องมือทั้งหมดเป็นแบบอ่านอย่างเดียว — AI เปลี่ยนแปลงอะไรในระบบไม่ได้
 */
export async function askMonitoringAi(
  s: AiSettings,
  env: AiEnv,
  opts: { system: string; history: AskTurn[]; question: string; tools: AskTool[] },
): Promise<AskResult> {
  if (s.provider !== "anthropic")
    throw new AiError(
      "ฟีเจอร์ถาม AI รองรับเฉพาะ provider Anthropic (Claude) — เปลี่ยนได้ในหน้าตั้งค่า",
      false,
    );
  if (!env.apiKey) throw new AiError("ไม่พบ AI_API_KEY ใน .env", false);
  const model = effectiveModel(s) || ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: env.apiKey, maxRetries: 2, timeout: 120_000 });

  const used: string[] = [];
  const tools = opts.tools.map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.input,
      run: async (input) => {
        used.push(t.name);
        try {
          const json = JSON.stringify(await t.run(input));
          return json.length > MAX_TOOL_RESULT_CHARS
            ? `${json.slice(0, MAX_TOOL_RESULT_CHARS)}… (ตัดทอน — ข้อมูลยาวเกินไป ให้กรองให้แคบลง)`
            : json;
        } catch (err) {
          return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  );

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...opts.history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: opts.question },
  ];

  try {
    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: 16000,
      max_iterations: 8,
      // ถ้า model ปฏิเสธด้วยเหตุผลด้าน safety ให้ server ส่งต่อไปยัง model สำรองอัตโนมัติ
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: opts.system,
      tools,
      messages,
    });
    let final: Anthropic.Beta.BetaMessage | null = null;
    let requests = 0;
    for await (const message of runner) {
      final = message;
      requests++;
    }
    if (!final) throw new AiError("AI ไม่ได้ตอบกลับ", true);
    if (final.stop_reason === "refusal") throw new AiError("AI ปฏิเสธคำถามนี้", false);
    if (final.stop_reason === "max_tokens") throw new AiError("คำตอบยาวเกินกำหนด ลองถามให้แคบลง", false);
    const answer = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!answer) {
      throw new AiError(
        final.stop_reason === "tool_use"
          ? "AI ใช้ข้อมูลเกินจำนวนรอบที่กำหนด ลองถามให้เจาะจงขึ้น"
          : "AI ไม่ได้ให้คำตอบ",
        false,
      );
    }
    return { answer, toolsUsed: [...new Set(used)], model, requests: Math.max(1, requests) };
  } catch (err) {
    throw toAiError(err);
  }
}
