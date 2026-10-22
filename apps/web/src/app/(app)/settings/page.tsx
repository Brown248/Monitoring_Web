import { formatDateTime, formatRelativeDay } from "@app/core";
import { parseServiceAccount } from "@app/core/server";
import { appSettings, asc, sql, users } from "@app/db";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { aiHealth, loadSettings, sheetsHealth } from "@/lib/data/system";
import { getEnv, tz } from "@/lib/env";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = { title: "ตั้งค่า" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireUser();
  const zone = tz();
  const env = getEnv();
  const settings = await loadSettings();
  const [ai, sheets, userRows, siteCount, versionRows] = await Promise.all([
    aiHealth(settings),
    sheetsHealth(settings),
    getDb()
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .orderBy(asc(users.id)),
    getDb().execute<{ n: string; per_day: string }>(sql`
      SELECT count(*)::text AS n, coalesce(sum(86400 / check_interval_seconds), 0)::text AS per_day
      FROM websites WHERE archived_at IS NULL AND enabled
    `),
    getDb().select({ key: appSettings.key, updatedAt: appSettings.updatedAt }).from(appSettings),
  ]);
  const versions = Object.fromEntries(versionRows.map((r) => [r.key, r.updatedAt.toISOString()]));
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  return (
    <SettingsClient
      isAdmin={me.role === "ADMIN"}
      meId={me.id}
      settings={settings}
      versions={versions}
      secrets={{
        smtpPassword: Boolean(env.SMTP_PASSWORD),
        aiKey: Boolean(env.AI_API_KEY),
        aiBaseUrl: env.AI_BASE_URL ?? null,
        serviceAccount: Boolean(sa),
        serviceAccountEmail: sa?.client_email ?? null,
      }}
      usage={{
        aiCalls: ai.callsThisMonth,
        sheetsLastSync: sheets.lastSyncAt ? formatDateTime(sheets.lastSyncAt, zone) : null,
        sheetsLastStatus: sheets.lastStatus,
        websites: Number(siteCount.rows[0]?.n ?? 0),
        checksPerDay: Number(siteCount.rows[0]?.per_day ?? 0),
      }}
      users={userRows.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        isActive: u.isActive,
        locked: Boolean(u.lockedUntil && u.lockedUntil > new Date()),
        lastLogin: u.lastLoginAt ? formatRelativeDay(u.lastLoginAt, zone) : "ยังไม่เคย",
      }))}
    />
  );
}
