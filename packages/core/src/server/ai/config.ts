import type { AiSettings } from "../../schemas/settings";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic";

export interface AiEnv {
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

export function effectiveModel(s: AiSettings): string {
  if (s.model) return s.model;
  return s.provider === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : "";
}

export function isAiReady(s: AiSettings, env: AiEnv): boolean {
  return s.provider !== "none" && Boolean(env.apiKey) && effectiveModel(s) !== "";
}
