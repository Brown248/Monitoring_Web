import { isSettingsKey, SETTINGS_SCHEMAS } from "@app/core";
import { appSettings, eq, logEvent, saveSettings } from "@app/db";
import { NextResponse } from "next/server";
import { assertVersion, HttpError, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ key: string }> };

const LABELS: Record<string, string> = {
  check_defaults: "ค่าเริ่มต้นการตรวจ",
  smtp: "อีเมล (SMTP)",
  ai: "AI",
  sheets: "Google Sheets",
  retention: "การเก็บข้อมูล",
  security: "ความปลอดภัย",
  insights: "วินิจฉัยและเตือนล่วงหน้า",
};

export const PUT = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const key = (await ctx.params).key;
  if (!isSettingsKey(key)) throw new HttpError(404, "ไม่รู้จักหมวดการตั้งค่านี้");
  const value = await readJson(req, SETTINGS_SCHEMAS[key]);
  const version = await getDb().transaction(async (tx) => {
    // ล็อกแถวก่อนเทียบ version — 2 คนกดบันทึกพร้อมกันจะผ่านได้คนเดียว
    const [row] = await tx
      .select({ updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .for("update");
    assertVersion(req, row?.updatedAt);
    await saveSettings(tx, key, value as never);
    await logEvent(tx, {
      type: "SETTINGS_UPDATED",
      message: `บันทึกการตั้งค่า ${LABELS[key]} (โดย ${user.username})`,
    });
    const [saved] = await tx
      .select({ updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .where(eq(appSettings.key, key));
    return saved?.updatedAt.toISOString() ?? null;
  });
  return NextResponse.json({ ok: true, version });
});
