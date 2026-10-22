import { parseSettings, SETTINGS_DEFAULTS, type SettingsKey, type SettingsMap } from "@app/core";
import { inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { appSettings, events } from "./schema";

/** ใช้ได้ทั้ง db และ transaction */
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function getSettings<K extends SettingsKey>(db: DbOrTx, key: K): Promise<SettingsMap[K]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(sql`${appSettings.key} = ${key}`);
  return parseSettings(key, rows[0]?.value);
}

export async function getAllSettings(db: DbOrTx): Promise<SettingsMap> {
  const keys = Object.keys(SETTINGS_DEFAULTS) as SettingsKey[];
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, keys));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<SettingsKey, unknown>;
  for (const k of keys) out[k] = parseSettings(k, byKey.get(k));
  return out as SettingsMap;
}

export async function saveSettings<K extends SettingsKey>(
  db: DbOrTx,
  key: K,
  value: SettingsMap[K],
): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** ค่าสถานะภายในระบบ (ไม่ใช่การตั้งค่าของผู้ใช้) เช่น เวลารัน retention ล่าสุด */
export async function getState<T>(db: DbOrTx, key: string): Promise<T | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(sql`${appSettings.key} = ${"state:" + key}`);
  return (rows[0]?.value as T | undefined) ?? null;
}

export async function setState(db: DbOrTx, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: "state:" + key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * สิทธิ์ทำงานชิ้นหนึ่งแต่ผู้เดียวแบบมีวันหมดอายุ (lease) — กันงานเดียวกันรันซ้อน เช่น sync ตามรอบชนกับปุ่ม
 * "Sync ตอนนี้" หรือ Worker 2 ตัวทำงานพร้อมกัน · หมดอายุเอง ถ้าผู้ถือตายกลางคัน (ไม่ค้างตลอดไป)
 * คืน true = ได้สิทธิ์ (หรือต่ออายุของตัวเอง)
 */
export async function tryAcquireLease(
  db: DbOrTx,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const key = `lease:${name}`.slice(0, 64);
  const res = await db.execute<{ key: string }>(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, jsonb_build_object('holder', ${holder}::text, 'until', now() + make_interval(secs => ${ttlMs / 1000})), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE (app_settings.value->>'until')::timestamptz < now() OR app_settings.value->>'holder' = ${holder}::text
    RETURNING key
  `);
  return res.rows.length > 0;
}

export async function releaseLease(db: DbOrTx, name: string, holder: string): Promise<void> {
  const key = `lease:${name}`.slice(0, 64);
  await db.execute(sql`DELETE FROM app_settings WHERE key = ${key} AND value->>'holder' = ${holder}::text`);
}

/** รัน fn ถ้าได้ lease (คืน null ถ้ามีคนอื่นถืออยู่) แล้วปล่อยเมื่อจบ */
export async function withLease<T>(
  db: DbOrTx,
  name: string,
  holder: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ value: T } | null> {
  if (!(await tryAcquireLease(db, name, holder, ttlMs))) return null;
  try {
    return { value: await fn() };
  } finally {
    await releaseLease(db, name, holder).catch(() => undefined);
  }
}

/**
 * จองโควตา AI 1 ครั้งก่อนเรียกจริง (นับ + บันทึกในทรานแซกชันเดียวกันภายใต้ advisory lock)
 * — คำขอพร้อมกันหลายรายการไม่ผ่านการตรวจโควตาไปพร้อมกันหมด · คืน id ของแถวที่จอง หรือ null ถ้าครบโควตา
 * แถวที่จองนับเป็น "ล้มเหลว" ไว้ก่อน จนกว่า finishAiCall จะบันทึกผลจริง (worker ตายกลางคันก็ยังนับโควตา)
 */
export async function reserveAiCall(
  db: Database,
  opts: { provider: string; model: string | null; monthlyLimit: number },
): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_quota'))`);
    if (opts.monthlyLimit > 0) {
      const used = await tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ai_calls WHERE at >= date_trunc('month', now())`,
      );
      if (Number(used.rows[0]?.n ?? 0) >= opts.monthlyLimit) return null;
    }
    const res = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_calls (provider, model, success, error)
      VALUES (${opts.provider}, ${opts.model}, false, 'กำลังเรียก AI')
      RETURNING id::text AS id
    `);
    return Number(res.rows[0]!.id);
  });
}

/**
 * บันทึกผลของการเรียกที่จองไว้ · extraRequests = จำนวนครั้งที่เรียก model เพิ่ม (เช่น AI เรียกเครื่องมือหลายรอบ)
 * นับเป็นแถวแยก เพราะผู้ให้บริการคิดเงินทุกครั้งที่เรียก
 */
export async function finishAiCall(
  db: DbOrTx,
  id: number,
  result: { success: boolean; model?: string | null; error?: string | null; extraRequests?: number },
): Promise<void> {
  await db.execute(sql`
    UPDATE ai_calls SET success = ${result.success}, error = ${result.success ? null : (result.error ?? "").slice(0, 300)},
      model = coalesce(${result.model ?? null}, model)
    WHERE id = ${id}
  `);
  const extra = Math.max(0, Math.min(50, Math.floor(result.extraRequests ?? 0)));
  if (extra > 0)
    await db.execute(sql`
      INSERT INTO ai_calls (provider, model, success, error)
      SELECT provider, model, ${result.success}, ${result.success ? null : "เรียกเพิ่มระหว่างใช้เครื่องมือ"}
      FROM ai_calls CROSS JOIN generate_series(1, ${extra}) WHERE id = ${id}
    `);
}

export type EventLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface NewEvent {
  type: string;
  message: string;
  level?: EventLevel;
  detail?: string | null;
  websiteId?: number | null;
  incidentId?: number | null;
  at?: Date;
}

export async function logEvent(db: DbOrTx, e: NewEvent): Promise<void> {
  await db.insert(events).values({
    type: e.type,
    message: e.message,
    level: e.level ?? "INFO",
    detail: e.detail ?? null,
    websiteId: e.websiteId ?? null,
    incidentId: e.incidentId ?? null,
    at: e.at ?? new Date(),
  });
}
