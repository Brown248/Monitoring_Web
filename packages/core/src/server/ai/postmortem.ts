import { z } from "zod";
import type { AiSettings } from "../../schemas/settings";
import { parseWithAnthropic } from "./anthropic";
import { providerConfig, type AiEnv } from "./config";
import { parseWithOpenAi } from "./openai";
import { AiError, type AnalyzeRequest } from "./types";

export const postmortemSchema = z.object({
  title: z.string(),
  summary: z.string(),
  impact: z.string(),
  timeline: z.array(z.object({ time: z.string(), event: z.string() })),
  rootCause: z.string(),
  rootCauseConfidence: z.enum(["low", "medium", "high"]),
  contributingFactors: z.array(z.string()),
  whatWentWell: z.array(z.string()),
  actionItems: z.array(z.object({ action: z.string(), priority: z.enum(["high", "medium", "low"]) })),
});
export type PostmortemResult = z.infer<typeof postmortemSchema>;

const str = { type: "string" };
const strList = { type: "array", items: str };
const POSTMORTEM_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "impact",
    "timeline",
    "rootCause",
    "rootCauseConfidence",
    "contributingFactors",
    "whatWentWell",
    "actionItems",
  ],
  properties: {
    title: str,
    summary: str,
    impact: str,
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "event"],
        properties: { time: str, event: str },
      },
    },
    rootCause: str,
    rootCauseConfidence: { type: "string", enum: ["low", "medium", "high"] },
    contributingFactors: strList,
    whatWentWell: strList,
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "priority"],
        properties: { action: str, priority: { type: "string", enum: ["high", "medium", "low"] } },
      },
    },
  },
};

export interface PostmortemPromptData {
  website: { name: string; url: string };
  incident: {
    id: number;
    cause: string;
    startedAt: string;
    confirmedAt: string;
    recoveredAt: string | null;
    durationMinutes: number;
    failedChecks: number;
  };
  timezone: string;
  events: Array<{ at: string; type: string; message: string }>;
  checksNewestFirst: Array<{
    at: string;
    status: string;
    httpStatus: number | null;
    responseTimeMs: number | null;
    errorCode: string | null;
    remoteIp: string | null;
  }>;
  aiAnalysis: { summary: string; possibleCauses: string[] } | null;
  /** เว็บอื่นที่ล่มช่วงเวลาเดียวกัน (จากการหาต้นเหตุร่วม) */
  relatedOutages: Array<{ website: string; startedAt: string; sharedFactor: string }>;
  notifications: { sent: number; failed: number };
}

export function buildPostmortemPrompt(d: PostmortemPromptData, thai: boolean): AnalyzeRequest {
  const system = [
    "You draft blameless incident postmortems for an internal IT team, based only on the monitoring data provided.",
    "The data is synthetic HTTP checks, the monitor's event log and an optional earlier AI analysis — never the site's own server logs.",
    "Write the timeline in the given timezone using HH:mm (and date if it spans days), oldest first, 4-10 entries.",
    "rootCause is a hypothesis unless the data proves it: say what supports it and set rootCauseConfidence honestly.",
    "If other websites failed at the same time (relatedOutages), weigh a shared cause (same server, DNS, network) highly.",
    "actionItems: 3-6 concrete, owner-agnostic preventive actions. whatWentWell: 1-3 items (e.g. detection speed, alerts sent).",
    "Keep summary to 2-3 sentences and impact to 1-2 sentences with the measured downtime.",
    thai ? "เขียนเนื้อหาทั้งหมดเป็นภาษาไทย (ศัพท์เทคนิคใช้ภาษาอังกฤษได้)" : "Write in English.",
  ].join("\n");
  return { system, user: JSON.stringify(d, null, 2) };
}

export async function generatePostmortem(
  s: AiSettings,
  env: AiEnv,
  req: AnalyzeRequest,
): Promise<PostmortemResult> {
  if (s.provider === "none") throw new AiError("ยังไม่ได้เลือก AI provider", false);
  if (!env.apiKey) throw new AiError("ไม่พบ AI_API_KEY ใน .env", false);
  const cfg = providerConfig(s, { ...env, apiKey: env.apiKey });
  return s.provider === "anthropic"
    ? parseWithAnthropic(cfg, req, postmortemSchema)
    : parseWithOpenAi(cfg, req, postmortemSchema, POSTMORTEM_JSON_SCHEMA, "incident_postmortem");
}
