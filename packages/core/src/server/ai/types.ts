import { z } from "zod";

export const analysisSchema = z.object({
  summary: z.string(),
  facts: z.array(z.string()),
  possibleCauses: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

export type AnalysisResult = z.infer<typeof analysisSchema>;

export interface AnalyzeRequest {
  system: string;
  user: string;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  /** สำหรับ OpenAI-compatible endpoint (เช่น Azure/Ollama) — ค่า default คือ api.openai.com */
  baseUrl?: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiError";
  }
}
