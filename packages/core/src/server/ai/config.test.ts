import { describe, expect, it } from "vitest";
import { aiSettingsSchema, type AiSettings } from "../../schemas/settings";
import { GEMINI_BASE_URL, GEMINI_DEFAULT_MODEL, isAiReady, providerConfig } from "./config";

const base: AiSettings = {
  provider: "gemini",
  model: "",
  monthlyLimit: 200,
  autoAnalyze: false,
  thai: true,
  autoPostmortem: false,
  postmortemMinMinutes: 5,
} as AiSettings;

describe("Gemini provider", () => {
  it("ใช้ model และ base URL เริ่มต้นของ Gemini เมื่อไม่ได้ตั้งค่า", () => {
    const cfg = providerConfig(base, { apiKey: "k", baseUrl: undefined });
    expect(cfg).toEqual({ apiKey: "k", model: GEMINI_DEFAULT_MODEL, baseUrl: GEMINI_BASE_URL });
    expect(isAiReady(base, { apiKey: "k", baseUrl: undefined })).toBe(true);
  });

  it("AI_BASE_URL ที่ตั้งไว้ชนะค่าเริ่มต้น และ model ที่ระบุชนะค่าเริ่มต้น", () => {
    const cfg = providerConfig(
      { ...base, model: "gemini-2.5-pro" },
      { apiKey: "k", baseUrl: "https://proxy.example/v1" },
    );
    expect(cfg.model).toBe("gemini-2.5-pro");
    expect(cfg.baseUrl).toBe("https://proxy.example/v1");
  });

  it("provider อื่นไม่ได้ base URL ของ Gemini", () => {
    expect(
      providerConfig({ ...base, provider: "openai", model: "m" }, { apiKey: "k", baseUrl: undefined })
        .baseUrl,
    ).toBeUndefined();
  });

  it("ไม่มี API key = ยังไม่พร้อม และ schema ปฏิเสธ provider ที่ไม่รู้จัก", () => {
    expect(isAiReady(base, { apiKey: undefined, baseUrl: undefined })).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...base, provider: "gemini" }).success).toBe(true);
    expect(aiSettingsSchema.safeParse({ ...base, provider: "bard" }).success).toBe(false);
  });
});
