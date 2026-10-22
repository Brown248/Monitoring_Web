import { parseUpStatusCodes } from "@app/core";
import { testUrl } from "@app/core/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, requireApi, route } from "@/lib/api";

const schema = z.object({
  url: z.string().trim().min(1).max(2048),
  timeoutSeconds: z.number().int().min(1).max(60).default(10),
  followRedirects: z.boolean().default(true),
  upStatusCodes: z.string().max(200).default("200-399"),
  treatAuthAsUp: z.boolean().default(false),
});

/** ทดสอบ URL ก่อนบันทึก — ผ่าน SSRF guard เดียวกับ worker */
export const POST = route(async (req) => {
  await requireApi(req, "ADMIN");
  const body = await readJson(req, schema);
  // ตรวจรูปแบบเหมือนตอนบันทึก — ไม่ให้ "ทดสอบผ่าน" แต่กดบันทึกแล้วไม่ผ่าน
  const codes = parseUpStatusCodes(body.upStatusCodes);
  if (!codes.ok) throw new HttpError(400, codes.error, { upStatusCodes: codes.error });
  const result = await testUrl(body.url, {
    timeoutMs: body.timeoutSeconds * 1000,
    followRedirects: body.followRedirects,
    maxRedirects: 3,
    upStatusCodes: body.upStatusCodes,
    treatAuthAsUp: body.treatAuthAsUp,
  });
  return NextResponse.json(result);
});
