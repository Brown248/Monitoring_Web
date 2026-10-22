/**
 * ส่งออก/นำเข้ารายชื่อเว็บไซต์ + ความเชื่อมโยง + การทดสอบใช้งานจริง + ค่าตั้งที่ไม่ใช่ความลับ
 * ใช้ย้ายรายชื่อจากเครื่อง dev ไป server โดยไม่พาประวัติ/ภาพต้นแบบ/ค่าที่เรียนรู้จากเครื่องอื่นไปด้วย
 * (รหัสผ่านทั้งหมดอยู่ใน .env — ไม่มีในไฟล์นี้)
 */
import {
  journeySchema,
  SETTINGS_SCHEMAS,
  SETTINGS_DEFAULTS,
  wouldCreateCycle,
  type Edge,
  type JourneyInput,
  type SettingsKey,
} from "@app/core";
import { normalizeUrl, websiteFormSchema, websiteFormToRow, type WebsiteFormInput } from "@app/core/server";
import {
  journeys,
  logEvent,
  saveSettings,
  sql,
  websiteDependencies,
  websites,
  websiteState,
  type Database,
  type DbOrTx,
} from "@app/db";

export const TRANSFER_VERSION = 1;

export interface SitesFile {
  version: number;
  exportedAt: string;
  websites: WebsiteFormInput[];
  /** อ้างอิงด้วย URL (id ของแต่ละเครื่องไม่ตรงกัน) */
  dependencies: Array<{ url: string; dependsOn: string }>;
  journeys: Array<{ url: string } & JourneyInput>;
  settings: Partial<Record<SettingsKey, unknown>>;
}

export async function exportSites(db: Database): Promise<SitesFile> {
  const rows = await db.execute<{
    id: number;
    name: string;
    url: string;
    enabled: boolean;
    check_interval_seconds: number;
    timeout_ms: number;
    retry_count: number;
    retry_delay_ms: number;
    confirm_down_count: number;
    confirm_recovery_count: number;
    up_status_codes: string;
    degraded_threshold_ms: number | null;
    treat_auth_as_up: boolean;
    follow_redirects: boolean;
    alert_emails: string[];
    send_recovery: boolean;
    ai_auto_analyze: boolean;
  }>(sql`SELECT * FROM websites WHERE archived_at IS NULL ORDER BY id`);
  const urlById = new Map(rows.rows.map((r) => [Number(r.id), r.url]));
  const deps = await db.execute<{ website_id: number; depends_on_id: number }>(
    sql`SELECT website_id, depends_on_id FROM website_dependencies ORDER BY website_id, depends_on_id`,
  );
  const js = await db.execute<{
    website_id: number;
    enabled: boolean;
    interval_minutes: number;
    steps: unknown;
  }>(sql`SELECT website_id, enabled, interval_minutes, steps FROM journeys ORDER BY website_id`);
  // เฉพาะค่าตั้งที่ผู้ใช้บันทึกไว้ (ไม่ใช่ state:/lease: ของระบบ)
  const st = await db.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM app_settings WHERE key IN (${sql.join(
      Object.keys(SETTINGS_DEFAULTS).map((k) => sql`${k}`),
      sql`, `,
    )}) ORDER BY key`,
  );
  return {
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    websites: rows.rows.map((r) => ({
      name: r.name,
      url: r.url,
      enabled: r.enabled,
      checkIntervalSeconds: r.check_interval_seconds,
      timeoutSeconds: Math.round(r.timeout_ms / 1000),
      retryCount: r.retry_count,
      retryDelaySeconds: Math.round(r.retry_delay_ms / 1000),
      confirmDownCount: r.confirm_down_count,
      confirmRecoveryCount: r.confirm_recovery_count,
      upStatusCodes: r.up_status_codes,
      degradedThresholdMs: r.degraded_threshold_ms,
      treatAuthAsUp: r.treat_auth_as_up,
      followRedirects: r.follow_redirects,
      alertEmails: r.alert_emails ?? [],
      sendRecovery: r.send_recovery,
      aiAutoAnalyze: r.ai_auto_analyze,
    })),
    dependencies: deps.rows
      .filter((d) => urlById.has(Number(d.website_id)) && urlById.has(Number(d.depends_on_id)))
      .map((d) => ({
        url: urlById.get(Number(d.website_id))!,
        dependsOn: urlById.get(Number(d.depends_on_id))!,
      })),
    journeys: js.rows
      .filter((j) => urlById.has(Number(j.website_id)))
      .map((j) => ({
        url: urlById.get(Number(j.website_id))!,
        enabled: j.enabled,
        intervalMinutes: j.interval_minutes as JourneyInput["intervalMinutes"],
        steps: j.steps as JourneyInput["steps"],
      })),
    settings: Object.fromEntries(st.rows.map((r) => [r.key, r.value])),
  };
}

export interface ImportReport {
  added: string[];
  skipped: Array<{ name: string; reason: string }>;
  dependencies: number;
  journeys: number;
  settings: { saved: string[]; kept: string[]; invalid: Array<{ key: string; reason: string }> };
}

/**
 * นำเข้าแบบรันซ้ำได้: เว็บที่ URL มีอยู่แล้วจะข้าม (ไม่แก้ของเดิม) · ค่าตั้งที่ server บันทึกไว้แล้วจะไม่ทับ
 * เว้นแต่ overwriteSettings · ทั้งหมดอยู่ในทรานแซกชันเดียว (ผิดพลาดกลางทาง = ไม่มีอะไรเปลี่ยน)
 */
export async function importSites(
  db: Database,
  raw: unknown,
  opts: { overwriteSettings?: boolean; dryRun?: boolean; actor?: string } = {},
): Promise<ImportReport> {
  const file = raw as Partial<SitesFile>;
  if (!file || typeof file !== "object" || file.version !== TRANSFER_VERSION || !Array.isArray(file.websites))
    throw new Error(`ไฟล์ไม่ใช่รายชื่อเว็บรุ่น ${TRANSFER_VERSION} (ส่งออกด้วยคำสั่ง export-sites)`);
  const report: ImportReport = {
    added: [],
    skipped: [],
    dependencies: 0,
    journeys: 0,
    settings: { saved: [], kept: [], invalid: [] },
  };
  const actor = opts.actor ?? "นำเข้ารายชื่อเว็บ";

  const run = async (tx: DbOrTx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('monitor:import-sites'))`);
    const existing = await tx.execute<{ id: number; url: string }>(
      sql`SELECT id, url FROM websites WHERE archived_at IS NULL`,
    );
    const idByUrl = new Map(existing.rows.map((r) => [normalizeUrl(r.url), Number(r.id)]));

    for (const w of file.websites!) {
      const parsed = websiteFormSchema.safeParse(w);
      const label = (w as { name?: string })?.name ?? "(ไม่มีชื่อ)";
      if (!parsed.success) {
        report.skipped.push({ name: label, reason: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" });
        continue;
      }
      const key = normalizeUrl(parsed.data.url);
      if (idByUrl.has(key)) {
        report.skipped.push({ name: parsed.data.name, reason: "มี URL นี้อยู่แล้ว" });
        continue;
      }
      const [row] = await tx
        .insert(websites)
        .values(websiteFormToRow(parsed.data))
        .returning({ id: websites.id });
      await tx.insert(websiteState).values({ websiteId: row!.id, nextCheckAt: new Date() });
      await logEvent(tx, {
        type: "WEBSITE_CREATED",
        websiteId: row!.id,
        message: `เพิ่มเว็บไซต์ ${parsed.data.name} (${actor})`,
      });
      idByUrl.set(key, row!.id);
      report.added.push(parsed.data.name);
    }

    // ความเชื่อมโยง — ข้ามที่หาเว็บไม่เจอหรือทำให้เกิดวงวน
    const edgesRes = await tx.execute<{ website_id: number; depends_on_id: number }>(
      sql`SELECT website_id, depends_on_id FROM website_dependencies`,
    );
    const edges: Edge[] = edgesRes.rows.map((r) => [Number(r.website_id), Number(r.depends_on_id)] as const);
    for (const d of file.dependencies ?? []) {
      const from = idByUrl.get(normalizeUrl(d.url));
      const to = idByUrl.get(normalizeUrl(d.dependsOn));
      if (!from || !to || from === to || edges.some(([a, b]) => a === from && b === to)) continue;
      if (wouldCreateCycle(edges, from, to)) continue;
      await tx.insert(websiteDependencies).values({ websiteId: from, dependsOnId: to }).onConflictDoNothing();
      edges.push([from, to]);
      report.dependencies++;
    }

    // การทดสอบใช้งานจริง — ไม่ทับของที่ server ตั้งไว้แล้ว
    for (const j of file.journeys ?? []) {
      const id = idByUrl.get(normalizeUrl(j.url));
      const parsed = journeySchema.safeParse(j);
      if (!id || !parsed.success) continue;
      const res = await tx
        .insert(journeys)
        .values({ websiteId: id, ...parsed.data })
        .onConflictDoNothing()
        .returning({ id: journeys.websiteId });
      if (res.length) report.journeys++;
    }

    // ค่าตั้ง
    const saved = await tx.execute<{ key: string }>(sql`SELECT key FROM app_settings`);
    const savedKeys = new Set(saved.rows.map((r) => r.key));
    for (const [key, value] of Object.entries(file.settings ?? {})) {
      if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) continue;
      const k = key as SettingsKey;
      if (savedKeys.has(k) && !opts.overwriteSettings) {
        report.settings.kept.push(k);
        continue;
      }
      const merged = { ...SETTINGS_DEFAULTS[k], ...(value && typeof value === "object" ? value : {}) };
      const parsed = SETTINGS_SCHEMAS[k].safeParse(merged);
      if (!parsed.success) {
        report.settings.invalid.push({ key: k, reason: parsed.error.issues[0]?.message ?? "ไม่ถูกต้อง" });
        continue;
      }
      await saveSettings(tx, k, parsed.data as never);
      report.settings.saved.push(k);
    }
    if (opts.dryRun) throw DRY_RUN;
  };

  try {
    await db.transaction((tx) => run(tx));
  } catch (err) {
    if (err !== DRY_RUN) throw err;
  }
  return report;
}

const DRY_RUN = new Error("dry-run");
