import { causeLabel, dayKey, formatDateTime, type SheetsSettings } from "@app/core";
import { parseServiceAccount, SheetsClient } from "@app/core/server";
import { and, desc, eq, integrationSyncLogs, logEvent, sql, withLease } from "@app/db";
import type { WorkerContext } from "../context";

const INTEGRATION = "google_sheets";

const INCIDENT_HEADER = ["Incident #", "เว็บไซต์", "URL", "เริ่ม", "ฟื้นตัว", "ระยะเวลา (นาที)", "สาเหตุ"];
const UPTIME_HEADER = [
  "วันที่",
  "เว็บไซต์",
  "Uptime %",
  "ตรวจทั้งหมด",
  "ล้มเหลว",
  "ล่มรวม (นาที)",
  "Response เฉลี่ย (ms)",
  "Incident",
];
// คอลัมน์สุดท้าย = เลขผลตรวจ ใช้ตรวจแถวที่ส่งไปแล้ว (กันแถวซ้ำเมื่อรอบก่อนล้มกลางคัน)
const CHECKS_HEADER = ["เวลา", "เว็บไซต์", "ผล", "HTTP", "Response (ms)", "Retry", "Error", "Check #"];

const INCIDENT_BATCH = 2_000;
/** วันที่ส่งต่อรอบ (แต่ละวัน = 1 แถวต่อเว็บ) */
const DAILY_MAX_DAYS = 31;
const CHECKS_BATCH = 5_000;
/** ส่งผลตรวจหลาย batch ต่อรอบจนทัน (เว็บ 200 เว็บ ตรวจทุกนาที ≈ 12,000 แถว/ชม.) แต่ไม่เกินเวลาที่กำหนด */
const CHECKS_MAX_BATCHES = 20;
const CHECKS_BUDGET_MS = 4 * 60_000;
/** สรุปรายวันเก่ากว่านี้ไม่ถูกสรุปใหม่แล้ว (rollup ย้อน 14 วัน) — ถือว่าปิดยอดแล้ว */
const DAILY_FROZEN_DAYS = 14;
const LEASE_NAME = "sheets-sync";
const LEASE_TTL_MS = 15 * 60_000;

export class SheetsSyncBusyError extends Error {
  constructor() {
    super("กำลัง sync Google Sheets อยู่แล้ว (อีกงานหนึ่ง) — รอสักครู่แล้วลองใหม่");
    this.name = "SheetsSyncBusyError";
  }
}

async function lastCursor(ctx: WorkerContext, entity: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ cursor: integrationSyncLogs.cursor })
    .from(integrationSyncLogs)
    .where(
      and(
        eq(integrationSyncLogs.integration, INTEGRATION),
        eq(integrationSyncLogs.entityType, entity),
        eq(integrationSyncLogs.status, "SUCCESS"),
      ),
    )
    .orderBy(desc(integrationSyncLogs.startedAt))
    .limit(1);
  return row?.cursor ?? null;
}

/** รอบล่าสุดล้มเหลว = อาจเขียนลงชีตไปแล้วบางส่วน (เช่น append สำเร็จแต่ตอบกลับช้าจนหมดเวลา) */
async function lastRunFailed(ctx: WorkerContext, entity: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ status: integrationSyncLogs.status })
    .from(integrationSyncLogs)
    .where(and(eq(integrationSyncLogs.integration, INTEGRATION), eq(integrationSyncLogs.entityType, entity)))
    .orderBy(desc(integrationSyncLogs.startedAt))
    .limit(1);
  return row?.status === "FAILED";
}

async function writeLog(
  ctx: WorkerContext,
  entity: string,
  startedAt: Date,
  status: "SUCCESS" | "FAILED",
  rows: number,
  cursor: string | null,
  message: string | null,
) {
  await ctx.db.insert(integrationSyncLogs).values({
    integration: INTEGRATION,
    entityType: entity,
    status,
    rowsSynced: rows,
    cursor,
    message,
    startedAt,
    finishedAt: new Date(),
  });
}

const failMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const skippedNote = (n: number) => (n > 0 ? `ข้าม ${n} แถวที่มีในชีตแล้ว` : null);

export function sheetsClientFor(ctx: WorkerContext, s: SheetsSettings): SheetsClient | null {
  const sa = parseServiceAccount(ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!sa || !s.spreadsheetId) return null;
  return new SheetsClient(sa, s.spreadsheetId);
}

/** ค่าวันที่ในชีต (USER_ENTERED แปลง "2026-10-21" เป็นเลข serial) → YYYY-MM-DD */
export function sheetDate(v: string): string {
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 20_000 && n < 90_000)
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
  }
  return v;
}

/**
 * แถวที่มีในชีตแล้ว (ตามคีย์) — อ่านเฉพาะเมื่อรอบก่อนล้มเหลว จึงไม่ต้องอ่านชีตทุกรอบ
 * ชีตยังไม่มี = ยังไม่มีแถวใดถูกส่ง
 */
async function existingKeys(
  client: SheetsClient,
  title: string,
  columns: string,
  key: (cells: string[]) => string,
): Promise<Set<string>> {
  if (!(await client.sheetTitles()).includes(title)) return new Set();
  return new Set((await client.columnValues(title, columns)).map(key));
}

/**
 * cursor ของ incident = "เวลาปิด#id" — เทียบแบบคู่ (เวลา, id) จึงไม่ส่งซ้ำแม้เวลาในฐานข้อมูลละเอียดกว่า
 * มิลลิวินาที และไม่ข้าม incident ที่ปิดในมิลลิวินาทีเดียวกัน · cursor แบบเก่า (เวลาอย่างเดียว) ยังอ่านได้
 */
export function parseIncidentCursor(raw: string | null): { at: string; id: number } {
  if (!raw) return { at: "1970-01-01T00:00:00.000Z", id: 0 };
  const [at, id] = raw.split("#");
  // แบบเก่า: ไม่มี id → ถือว่าส่งทุก incident ที่ปิดภายในมิลลิวินาทีนั้นไปแล้ว
  return { at: at!, id: id === undefined ? Number.MAX_SAFE_INTEGER : Number(id) || 0 };
}

/** ส่ง incident ที่ปิดแล้วหลัง cursor (ไม่ส่งซ้ำ เพราะแต่ละ incident ปิดครั้งเดียว) */
export async function syncIncidents(
  ctx: WorkerContext,
  client: SheetsClient,
  s: SheetsSettings,
): Promise<number> {
  const startedAt = new Date();
  const rawCursor = await lastCursor(ctx, "incidents");
  const cursor = rawCursor ?? "1970-01-01T00:00:00.000Z";
  const after = parseIncidentCursor(rawCursor);
  try {
    const res = await ctx.db.execute<{
      id: number;
      name: string;
      url: string;
      started_at: Date;
      recovered_at: Date;
      cause: string;
    }>(sql`
      SELECT i.id, w.name, w.url, i.started_at, i.recovered_at, i.cause
      FROM incidents i JOIN websites w ON w.id = i.website_id
      WHERE i.recovered_at IS NOT NULL
        AND (date_trunc('milliseconds', i.recovered_at), i.id) > (${after.at}::timestamptz, ${after.id}::bigint)
      ORDER BY date_trunc('milliseconds', i.recovered_at), i.id LIMIT ${INCIDENT_BATCH}
    `);
    const sent =
      res.rows.length > 0 && (await lastRunFailed(ctx, "incidents"))
        ? await existingKeys(client, s.incidentSheet, "A:A", (c) => c[0] ?? "")
        : new Set<string>();
    const tz = ctx.env.APP_TIMEZONE;
    const rows = res.rows
      .filter((r) => !sent.has(String(Number(r.id))))
      .map((r) => {
        const start = new Date(r.started_at);
        const end = new Date(r.recovered_at);
        return [
          Number(r.id),
          r.name,
          r.url,
          formatDateTime(start, tz),
          formatDateTime(end, tz),
          Math.round((end.getTime() - start.getTime()) / 60_000),
          r.cause,
        ];
      });
    if (rows.length > 0) {
      await client.ensureSheet(s.incidentSheet, INCIDENT_HEADER);
      await client.append(s.incidentSheet, rows);
    }
    const lastRow = res.rows[res.rows.length - 1];
    const newCursor = lastRow
      ? `${new Date(lastRow.recovered_at).toISOString()}#${Number(lastRow.id)}`
      : cursor;
    await writeLog(
      ctx,
      "incidents",
      startedAt,
      "SUCCESS",
      rows.length,
      newCursor,
      skippedNote(res.rows.length - rows.length),
    );
    return rows.length;
  } catch (err) {
    await writeLog(ctx, "incidents", startedAt, "FAILED", 0, null, failMessage(err));
    throw err;
  }
}

/**
 * ส่งสรุปรายวันของวันที่ปิดยอดแล้ว หลัง cursor — ทีละ "วันเต็ม" (ไม่ตัดกลางวัน แล้ว cursor ข้ามส่วนที่เหลือ)
 * วันที่ "ปิดยอด" = ทุกแถวของวันนั้นถูกสรุปใหม่หลังวันนั้นจบแล้ว (sync ตอน 00:05 ไม่ส่งตัวเลขเมื่อวานที่ยังไม่ครบ)
 */
export async function syncDailyUptime(
  ctx: WorkerContext,
  client: SheetsClient,
  s: SheetsSettings,
): Promise<number> {
  const startedAt = new Date();
  const tz = ctx.env.APP_TIMEZONE;
  const today = dayKey(new Date(), tz);
  const cursor = (await lastCursor(ctx, "daily_uptime")) ?? "1970-01-01";
  try {
    const dayRes = await ctx.db.execute<{ day: string; final: boolean }>(sql`
      SELECT d.day::text AS day,
             bool_and(d.updated_at >= ((d.day + 1)::timestamp AT TIME ZONE ${tz}))
               OR d.day < ${today}::date - ${DAILY_FROZEN_DAYS}::int AS final
      FROM daily_summaries d
      WHERE d.day > ${cursor}::date AND d.day < ${today}::date
      GROUP BY d.day ORDER BY d.day LIMIT ${DAILY_MAX_DAYS}
    `);
    // หยุดที่วันแรกที่ยังไม่ปิดยอด — cursor ต้องเดินหน้าอย่างเดียว ห้ามข้ามวัน
    const days: string[] = [];
    for (const d of dayRes.rows) {
      if (!d.final) break;
      days.push(d.day);
    }
    if (days.length === 0) {
      await writeLog(ctx, "daily_uptime", startedAt, "SUCCESS", 0, cursor, null);
      return 0;
    }
    const res = await ctx.db.execute<{
      day: string;
      name: string;
      total_checks: number;
      up_checks: number;
      down_checks: number;
      downtime_seconds: number;
      avg_response_ms: number | null;
      incident_count: number;
    }>(sql`
      SELECT d.day::text AS day, w.name, d.total_checks, d.up_checks, d.down_checks, d.downtime_seconds,
             d.avg_response_ms, d.incident_count
      FROM daily_summaries d JOIN websites w ON w.id = d.website_id
      WHERE d.day >= ${days[0]}::date AND d.day <= ${days[days.length - 1]}::date
      ORDER BY d.day, w.name
    `);
    const sent = (await lastRunFailed(ctx, "daily_uptime"))
      ? await existingKeys(client, s.uptimeSheet, "A:B", (c) => `${sheetDate(c[0] ?? "")}|${c[1] ?? ""}`)
      : new Set<string>();
    const rows = res.rows
      .filter((r) => !sent.has(`${r.day}|${r.name}`))
      .map((r) => {
        const decided = Number(r.up_checks) + Number(r.down_checks);
        const uptime = decided > 0 ? Math.round((Number(r.up_checks) / decided) * 10_000) / 100 : null;
        return [
          r.day,
          r.name,
          uptime,
          Number(r.total_checks),
          Number(r.down_checks),
          Math.round(Number(r.downtime_seconds) / 60),
          r.avg_response_ms === null ? null : Math.round(Number(r.avg_response_ms)),
          Number(r.incident_count),
        ];
      });
    if (rows.length > 0) {
      await client.ensureSheet(s.uptimeSheet, UPTIME_HEADER);
      await client.append(s.uptimeSheet, rows);
    }
    await writeLog(
      ctx,
      "daily_uptime",
      startedAt,
      "SUCCESS",
      rows.length,
      days[days.length - 1]!,
      skippedNote(res.rows.length - rows.length),
    );
    return rows.length;
  } catch (err) {
    await writeLog(ctx, "daily_uptime", startedAt, "FAILED", 0, null, failMessage(err));
    throw err;
  }
}

/** ชื่อชีตผลตรวจของเดือนนั้น เช่น "Check History 2026-10" (เดือนตาม APP_TIMEZONE) */
export function checksSheetTitle(base: string, at: Date, tz: string): string {
  return `${base} ${dayKey(at, tz).slice(0, 7)}`;
}

/** ส่งผลตรวจทีละ batch จนทัน (หรือครบเวลา/จำนวน batch ต่อรอบ) — แต่ละ batch บันทึก cursor ของตัวเอง */
export async function syncChecks(
  ctx: WorkerContext,
  client: SheetsClient,
  s: SheetsSettings,
): Promise<number> {
  const began = Date.now();
  let total = 0;
  let checkDuplicates = await lastRunFailed(ctx, "checks");
  for (let batch = 0; batch < CHECKS_MAX_BATCHES && Date.now() - began < CHECKS_BUDGET_MS; batch++) {
    const startedAt = new Date();
    const cursor = Number((await lastCursor(ctx, "checks")) ?? 0);
    try {
      const res = await ctx.db.execute<{
        id: number;
        checked_at: Date;
        name: string;
        status: string;
        degraded: boolean;
        http_status: number | null;
        response_time_ms: number | null;
        retries: number;
        error_code: string | null;
      }>(sql`
        SELECT c.id, c.checked_at, w.name, c.status, c.degraded, c.http_status, c.response_time_ms, c.retries, c.error_code
        FROM check_results c JOIN websites w ON w.id = c.website_id
        WHERE c.id > ${cursor} ORDER BY c.id LIMIT ${CHECKS_BATCH}
      `);
      // แยกชีตรายเดือน — ผลตรวจทุกครั้งในชีตเดียวจะชนเพดาน 10 ล้านเซลล์ของ Google ในไม่กี่สัปดาห์/เดือน
      // แล้ว sync ล้มถาวร (และการตรวจแถวซ้ำต้องอ่านทั้งคอลัมน์ที่ใหญ่ขึ้นเรื่อย ๆ)
      const byMonth = new Map<string, typeof res.rows>();
      for (const r of res.rows) {
        const title = checksSheetTitle(s.checksSheet, new Date(r.checked_at), ctx.env.APP_TIMEZONE);
        byMonth.set(title, [...(byMonth.get(title) ?? []), r]);
      }
      let appended = 0;
      for (const [title, monthRows] of byMonth) {
        const sent = checkDuplicates
          ? await existingKeys(client, title, "H:H", (c) => c[0] ?? "")
          : new Set<string>();
        const fresh = monthRows.filter((r) => !sent.has(String(Number(r.id))));
        const rows = checkRows(ctx, fresh).map((r, i) => [...r, Number(fresh[i]!.id)]);
        if (rows.length > 0) {
          await client.ensureSheet(title, CHECKS_HEADER);
          await client.append(title, rows);
          appended += rows.length;
        }
      }
      checkDuplicates = false;
      const rows = { length: appended };
      const newCursor = res.rows.length > 0 ? String(res.rows[res.rows.length - 1]!.id) : String(cursor);
      await writeLog(
        ctx,
        "checks",
        startedAt,
        "SUCCESS",
        rows.length,
        newCursor,
        skippedNote(res.rows.length - rows.length),
      );
      total += rows.length;
      if (res.rows.length < CHECKS_BATCH) break; // ทันแล้ว
    } catch (err) {
      await writeLog(ctx, "checks", startedAt, "FAILED", 0, null, failMessage(err));
      throw err;
    }
  }
  return total;
}

export function checkRows(
  ctx: WorkerContext,
  rows: Array<{
    checked_at: Date;
    name: string;
    status: string;
    degraded: boolean;
    http_status: number | null;
    response_time_ms: number | null;
    retries: number;
    error_code: string | null;
  }>,
) {
  const tz = ctx.env.APP_TIMEZONE;
  return rows.map((r) => [
    formatDateTime(new Date(r.checked_at), tz),
    r.name,
    r.degraded ? "DEGRADED" : r.status,
    r.http_status,
    r.response_time_ms,
    Number(r.retries),
    r.error_code ? causeLabel(r.error_code, r.http_status) : "",
  ]);
}

/**
 * sync ทุกประเภทที่เปิดไว้ — คืนสรุปจำนวนแถวที่ส่ง
 * ถือ lease ระหว่างทำ: sync ตามรอบกับปุ่ม "Sync ตอนนี้" (หรือ Worker 2 ตัว) ไม่ส่งข้อมูลชุดเดียวกันซ้ำพร้อมกัน
 */
export async function runSheetsSync(
  ctx: WorkerContext,
  reason: string,
  client?: SheetsClient,
): Promise<string> {
  const { sheets } = await ctx.settings();
  const c = client ?? sheetsClientFor(ctx, sheets);
  if (!c) throw new Error("ยังไม่ได้ตั้งค่า Spreadsheet ID หรือไม่พบ GOOGLE_SERVICE_ACCOUNT_JSON");
  const holder = `${ctx.workerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const done = await withLease(ctx.db, LEASE_NAME, holder, LEASE_TTL_MS, async () => {
    const parts: string[] = [];
    if (sheets.sendIncidents) parts.push(`Incident ${await syncIncidents(ctx, c, sheets)} แถว`);
    if (sheets.sendDailyUptime) parts.push(`Uptime รายวัน ${await syncDailyUptime(ctx, c, sheets)} แถว`);
    if (sheets.sendChecks) parts.push(`Check History ${await syncChecks(ctx, c, sheets)} แถว`);
    return parts.join(" · ") || "ไม่ได้เลือกข้อมูลที่จะส่ง";
  });
  if (!done) throw new SheetsSyncBusyError();
  await logEvent(ctx.db, {
    type: "SHEETS_SYNC",
    level: "SUCCESS",
    message: `Google Sheets sync สำเร็จ (${reason})`,
    detail: done.value,
  });
  return done.value;
}

/** sync ตามรอบที่ตั้งไว้ (hourly / daily) — นับจาก sync ครั้งล่าสุด */
export async function maybeScheduledSheetsSync(ctx: WorkerContext): Promise<void> {
  const { sheets } = await ctx.settings();
  if (sheets.interval === "manual" || !sheetsClientFor(ctx, sheets)) return;
  const [last] = await ctx.db
    .select({ at: integrationSyncLogs.startedAt })
    .from(integrationSyncLogs)
    .where(eq(integrationSyncLogs.integration, INTEGRATION))
    .orderBy(desc(integrationSyncLogs.startedAt))
    .limit(1);
  const periodMs = sheets.interval === "hourly" ? 3_600_000 : 86_400_000;
  if (last && Date.now() - last.at.getTime() < periodMs) return;
  try {
    await runSheetsSync(ctx, sheets.interval === "hourly" ? "รายชั่วโมง" : "รายวัน");
  } catch (err) {
    if (err instanceof SheetsSyncBusyError) return; // ปุ่ม "Sync ตอนนี้" กำลังทำอยู่ — รอบนี้ไม่ต้องทำซ้ำ
    const message = failMessage(err);
    await logEvent(ctx.db, {
      type: "SHEETS_FAILED",
      level: "ERROR",
      message: "Google Sheets sync ล้มเหลว",
      detail: message,
    });
    ctx.log.warn("sheets sync failed", { error: message });
  }
}
