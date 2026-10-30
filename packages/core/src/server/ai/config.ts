import type { AiSettings } from "../../schemas/settings";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic";
import type { ProviderConfig } from "./types";

export interface AiEnv {
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

// Gemini ใช้ endpoint แบบ OpenAI-compatible ของ Google ผ่านโค้ดชุดเดียวกับ openai
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export function effectiveModel(s: AiSettings): string {
  if (s.model) return s.model;
  if (s.provider === "anthropic") return ANTHROPIC_DEFAULT_MODEL;
  if (s.provider === "gemini") return GEMINI_DEFAULT_MODEL;
  return "";
}

/** ค่าที่ส่งให้ provider จริง: Gemini ไม่ต้องตั้ง AI_BASE_URL (ตั้งไว้ = ใช้ค่านั้นแทน) */
export function providerConfig(s: AiSettings, env: AiEnv & { apiKey: string }): ProviderConfig {
  const baseUrl = env.baseUrl || (s.provider === "gemini" ? GEMINI_BASE_URL : undefined);
  return { apiKey: env.apiKey, model: effectiveModel(s), baseUrl };
}

export function isAiReady(s: AiSettings, env: AiEnv): boolean {
  return s.provider !== "none" && Boolean(env.apiKey) && effectiveModel(s) !== "";
}
