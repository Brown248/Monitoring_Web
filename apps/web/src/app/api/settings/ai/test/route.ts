import { aiSettingsSchema } from "@app/core";
import { testAiConnection } from "@app/core/server";
import { NextResponse } from "next/server";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { getEnv } from "@/lib/env";

/** ทดสอบ provider + model + AI_API_KEY ผ่าน Models API (ไม่เสียโควตา token) */
export const POST = route(async (req) => {
  await requireApi(req, "ADMIN");
  const ai = await readJson(req, aiSettingsSchema);
  const env = getEnv();
  try {
    const message = await testAiConnection(ai, { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL });
    return NextResponse.json({ ok: true, message });
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
});
