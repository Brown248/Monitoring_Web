import { isAiReady } from "@app/core/server";
import type { Metadata } from "next";
import { AskChat } from "@/components/client/ask-chat";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { loadSettings } from "@/lib/data/system";
import { getEnv } from "@/lib/env";

export const metadata: Metadata = { title: "ถาม AI" };
export const dynamic = "force-dynamic";

export default async function AskPage() {
  await requireUser();
  const { ai } = await loadSettings();
  const env = getEnv();
  const ready =
    ai.provider === "anthropic" && isAiReady(ai, { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL });
  const reason =
    ai.provider === "none"
      ? "ยังไม่ได้เปิดใช้ AI — เลือก provider เป็น Anthropic และใส่ AI_API_KEY ใน .env (หน้าตั้งค่า > AI)"
      : ai.provider !== "anthropic"
        ? "ฟีเจอร์ถาม AI รองรับเฉพาะ provider Anthropic (Claude)"
        : "ไม่พบ AI_API_KEY ใน .env";
  return (
    <>
      <PageHeader title="ถาม AI" subtitle="ถามเป็นภาษาไทยได้เลย — ตอบจากข้อมูลการตรวจเว็บจริงของบริษัท" />
      <AskChat ready={ready} reason={reason} />
    </>
  );
}
