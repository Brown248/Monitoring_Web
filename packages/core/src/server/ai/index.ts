import type { AiSettings } from "../../schemas/settings";
import { analyzeWithAnthropic, ANTHROPIC_DEFAULT_MODEL, testAnthropic } from "./anthropic";
import { providerConfig, type AiEnv } from "./config";
import { analyzeWithOpenAi, testOpenAi } from "./openai";
import { AiError, type AnalysisResult, type AnalyzeRequest } from "./types";

export { AiError, ANTHROPIC_DEFAULT_MODEL };
export type { AnalysisResult };

export { effectiveModel, isAiReady, type AiEnv } from "./config";
export * from "./postmortem";
export * from "./ask";

export async function analyze(s: AiSettings, env: AiEnv, req: AnalyzeRequest): Promise<AnalysisResult> {
  if (s.provider === "none") throw new AiError("ยังไม่ได้เลือก AI provider", false);
  if (!env.apiKey) throw new AiError("ไม่พบ AI_API_KEY ใน .env", false);
  const cfg = providerConfig(s, { ...env, apiKey: env.apiKey });
  return s.provider === "anthropic" ? analyzeWithAnthropic(cfg, req) : analyzeWithOpenAi(cfg, req);
}

export async function testAiConnection(s: AiSettings, env: AiEnv): Promise<string> {
  if (s.provider === "none") throw new AiError("ยังไม่ได้เลือก AI provider", false);
  if (!env.apiKey) throw new AiError("ไม่พบ AI_API_KEY ใน .env", false);
  const cfg = providerConfig(s, { ...env, apiKey: env.apiKey });
  return s.provider === "anthropic" ? testAnthropic(cfg) : testOpenAi(cfg);
}

export interface IncidentPromptData {
  websiteName: string;
  url: string;
  cause: string;
  startedAt: string;
  confirmedAt: string;
  recoveredAt: string | null;
  failedCheckCount: number;
  canarySummary: string;
  checks: Array<{
    at: string;
    status: string;
    httpStatus: number | null;
    responseTimeMs: number | null;
    retries: number;
    errorCode: string | null;
    errorMessage: string | null;
    dnsMs: number | null;
    connectMs: number | null;
    tlsMs: number | null;
    redirectCount: number;
  }>;
  avgResponseMs24h: number | null;
}

/** สร้าง prompt จากผลตรวจเท่านั้น — ไม่ส่ง header, cookie หรือ secret ใด ๆ */
export function buildIncidentPrompt(d: IncidentPromptData, thai: boolean): AnalyzeRequest {
  const lang = thai ? "ตอบเป็นภาษาไทยทั้งหมด" : "Respond in English.";
  const system = [
    "You analyze website-monitoring incidents for an internal IT team.",
    "You only see synthetic HTTP check results collected by the monitor (status, timings, error codes) — never the site's own logs.",
    "Separate what the data shows (facts) from hypotheses (possibleCauses). Do not claim certainty you do not have.",
    "Keep summary to 2-3 sentences. Give 2-4 items per list. nextSteps must be concrete checks an operator can run.",
    "Your analysis is advisory only; it never changes the website status.",
    lang,
  ].join("\n");
  const user = JSON.stringify(
    {
      website: { name: d.websiteName, url: d.url },
      incident: {
        cause: d.cause,
        firstFailureAt: d.startedAt,
        confirmedAt: d.confirmedAt,
        recoveredAt: d.recoveredAt,
        failedChecks: d.failedCheckCount,
      },
      baseline: { avgResponseMs24h: d.avgResponseMs24h },
      canary: d.canarySummary,
      recentChecksNewestFirst: d.checks,
    },
    null,
    2,
  );
  return { system, user };
}
