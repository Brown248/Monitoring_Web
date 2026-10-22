import { formatDateTime, normalizeChatHistory } from "@app/core";
import { AiError, askMonitoringAi } from "@app/core/server";
import { finishAiCall, getSettings, reserveAiCall } from "@app/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { monitoringTools } from "@/lib/ai-tools";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getEnv, tz } from "@/lib/env";

const schema = z.object({
  question: z.string().trim().min(2, "พิมพ์คำถามอย่างน้อย 2 ตัวอักษร").max(1000),
  // หน้าเว็บตัดให้แล้ว แต่ server ไม่เชื่อ client: รับยาวได้แล้วตัดเอง (ไม่ปฏิเสธทั้งคำถามเพราะคำตอบเก่ายาว)
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(20_000) }))
    .max(40)
    .default([]),
});

// จำกัดต่อผู้ใช้ 30 คำถาม/ชั่วโมง (ในหน่วยความจำของ process — เว็บรันเครื่องเดียว)
const RATE = { max: 30, windowMs: 3_600_000 };
const asked = new Map<number, number[]>();

function rateLimit(userId: number) {
  const now = Date.now();
  const list = (asked.get(userId) ?? []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= RATE.max) throw new HttpError(429, "ถามครบ 30 ครั้งในชั่วโมงนี้แล้ว ลองใหม่ภายหลัง");
  list.push(now);
  asked.set(userId, list);
}

function systemPrompt(zone: string, thai: boolean): string {
  return [
    "You are the assistant inside SYNTECH Web Monitor, the internal website-monitoring system of a company.",
    "Answer questions about the monitored websites using ONLY data returned by the tools. Call tools to get facts; never guess numbers, dates, or causes.",
    "If the tools return nothing relevant, say plainly that the data does not show it. If a question is ambiguous (e.g. which website), make a reasonable assumption and state it.",
    "Root causes are hypotheses unless the data proves them — say so. You can only read data; you cannot change settings, run checks or send email.",
    "Keep answers short and scannable: a direct answer first, then a few bullets or a small markdown table if it helps. Use websites' names, not ids.",
    `The current time is ${formatDateTime(new Date(), zone)} (${zone}). Interpret relative dates (yesterday, this month) in this timezone.`,
    thai ? "ตอบเป็นภาษาไทยเสมอ (ศัพท์เทคนิคใช้ภาษาอังกฤษได้)" : "Answer in English.",
  ].join("\n");
}

/** ถาม AI จากข้อมูลจริงในระบบ (เครื่องมืออ่านอย่างเดียว) */
export const POST = route(async (req) => {
  const user = await requireApi(req);
  // ประวัติแชตยาวกว่าฟอร์มทั่วไป (หน้าเว็บตัดให้เหลือข้อความละ ~4,000 ตัวอักษร × 10)
  const body = await readJson(req, schema, 512 * 1024);
  const db = getDb();
  const env = getEnv();
  const ai = await getSettings(db, "ai");
  rateLimit(user.id);
  // จองโควตาก่อนเรียก (คำถามพร้อมกันหลายคนไม่ผ่านการตรวจโควตาไปพร้อมกัน)
  const callId = await reserveAiCall(db, {
    provider: ai.provider,
    model: ai.model || null,
    monthlyLimit: ai.monthlyLimit,
  });
  if (callId === null) throw new HttpError(429, `ใช้ AI ครบโควตาเดือนนี้แล้ว (${ai.monthlyLimit} ครั้ง)`);
  const zone = tz();
  try {
    const result = await askMonitoringAi(
      ai,
      { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL },
      {
        system: systemPrompt(zone, ai.thai),
        history: normalizeChatHistory(body.history),
        question: body.question,
        tools: monitoringTools(zone),
      },
    );
    await finishAiCall(db, callId, {
      success: true,
      model: result.model,
      extraRequests: result.requests - 1,
    });
    return NextResponse.json({ answer: result.answer, toolsUsed: result.toolsUsed, model: result.model });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishAiCall(db, callId, { success: false, error: message }).catch(() => undefined);
    if (err instanceof AiError) throw new HttpError(err.retryable ? 503 : 400, err.message);
    throw err;
  }
});
