import { CHECKS_EXPORT_LIMIT, buildChecksFilterSql, type ChecksFilter } from "@app/db/queries";
import { eq, jobRequests, logEvent, sql, withLease } from "@app/db";
import type { WorkerContext } from "../context";
import { runLookalikeWatch, runSecurityScanNow } from "./security";
import { checkRows, runSheetsSync, sheetsClientFor } from "./sheets";
import { diagnoseWebsite } from "./insights";
import { runJourneyNow } from "./journeys";
import { runVisualCheckNow } from "./visual";

const JOB_LABEL: Record<string, string> = {
  SHEETS_SYNC: "Sync Google Sheets",
  SHEETS_EXPORT_CHECKS: "ส่งผลตรวจไป Google Sheets",
  SECURITY_SCAN: "สแกนความปลอดภัย",
  VISUAL_CAPTURE: "ถ่ายภาพหน้าเว็บ",
  LOOKALIKE_SCAN: "ค้นหาโดเมนเลียนแบบ",
  DIAGNOSE: "วินิจฉัยปัญหา",
  JOURNEY_RUN: "ทดสอบใช้งานจริง",
};

/** ทำงานที่หน้าเว็บสั่งพร้อมกันได้สูงสุดกี่งาน — งานนาน (ค้นโดเมนเลียนแบบตอน crt.sh ล่ม) ไม่ขวางงานอื่นทั้งคิว */
const MAX_PARALLEL_JOBS = 3;
const inFlight = new Set<Promise<void>>();

/** งานที่หน้าเว็บสั่งไว้ (Sync ตอนนี้ / ถ่ายภาพ / วินิจฉัย ฯลฯ) — claim ได้หลายงาน แต่ละงานทำแยกกัน */
export async function processJobRequests(ctx: WorkerContext): Promise<void> {
  // Worker ดับ/รีสตาร์ทระหว่างทำงาน → งานค้าง RUNNING ตลอด (และปุ่มเดิมจะกดใหม่ไม่ได้เพราะกันงานซ้ำ)
  await ctx.db.execute(sql`
    UPDATE job_requests SET status = 'FAILED', finished_at = now(),
      result = 'Worker หยุดทำงานระหว่างทำงานนี้ — สั่งใหม่ได้เลย'
    WHERE status = 'RUNNING' AND started_at < now() - interval '15 minutes'
  `);
  while (inFlight.size < MAX_PARALLEL_JOBS) {
    const claimed = await ctx.db.execute<{
      id: number;
      type: string;
      payload: Record<string, unknown> | null;
    }>(sql`
      WITH next AS (
        SELECT id FROM job_requests WHERE status = 'PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE job_requests j SET status = 'RUNNING', started_at = now()
      FROM next WHERE j.id = next.id
      RETURNING j.id, j.type, j.payload
    `);
    const job = claimed.rows[0];
    if (!job) return;
    const p: Promise<void> = runJob(ctx, job)
      .catch((err: unknown) => ctx.log.error("job request crashed", { err }))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
}

/** ตอนปิด Worker: รองานที่กำลังทำให้จบก่อน (ไม่งั้นค้าง RUNNING 15 นาที) */
export async function drainJobRequests(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

async function runJob(
  ctx: WorkerContext,
  job: { id: number; type: string; payload: Record<string, unknown> | null },
): Promise<void> {
  const id = Number(job.id);
  try {
    let result: string;
    if (job.type === "SHEETS_SYNC") {
      result = await runSheetsSync(ctx, "สั่งจากหน้าเว็บ");
    } else if (job.type === "SHEETS_EXPORT_CHECKS") {
      result = await exportChecks(ctx, (job.payload ?? {}) as ChecksFilter);
    } else if (job.type === "SECURITY_SCAN") {
      result = await runSecurityScanNow(ctx, Number(job.payload?.websiteId));
    } else if (job.type === "VISUAL_CAPTURE") {
      result = await runVisualCheckNow(ctx, Number(job.payload?.websiteId));
    } else if (job.type === "DIAGNOSE") {
      result = await diagnoseWebsite(ctx, Number(job.payload?.websiteId), "manual");
    } else if (job.type === "JOURNEY_RUN") {
      result = await runJourneyNow(ctx, Number(job.payload?.websiteId));
    } else if (job.type === "LOOKALIKE_SCAN") {
      // รอบตามตารางกำลังค้นอยู่ (lease เดียวกัน) → ไม่ค้นซ้อน (แต่ละคำรอ crt.sh ได้นาน และโดนจำกัดอัตรา)
      const done = await withLease(ctx.db, "job:lookalike", `${ctx.workerId}:manual`, 15 * 60_000, () =>
        runLookalikeWatch(ctx, true),
      );
      if (!done) throw new Error("กำลังค้นหาโดเมนเลียนแบบตามรอบอยู่ — รอผลรอบนั้นสักครู่");
      result = done.value;
    } else {
      throw new Error(`ไม่รู้จักงานประเภท ${job.type}`);
    }
    await ctx.db
      .update(jobRequests)
      .set({ status: "DONE", result, finishedAt: new Date() })
      .where(eq(jobRequests.id, id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(jobRequests)
      .set({ status: "FAILED", result: message, finishedAt: new Date() })
      .where(eq(jobRequests.id, id));
    await logEvent(ctx.db, {
      type: "JOB_FAILED",
      level: "ERROR",
      message: `${JOB_LABEL[job.type] ?? `งาน ${job.type}`} ไม่สำเร็จ`,
      detail: message,
    });
  }
}

async function exportChecks(ctx: WorkerContext, filter: ChecksFilter): Promise<string> {
  const { sheets } = await ctx.settings();
  const client = sheetsClientFor(ctx, sheets);
  if (!client) throw new Error("ยังไม่ได้ตั้งค่า Spreadsheet ID หรือไม่พบ GOOGLE_SERVICE_ACCOUNT_JSON");
  const where = buildChecksFilterSql(filter, new Date());
  const res = await ctx.db.execute<{
    checked_at: Date;
    name: string;
    status: string;
    degraded: boolean;
    http_status: number | null;
    response_time_ms: number | null;
    retries: number;
    error_code: string | null;
  }>(sql`
    SELECT c.checked_at, w.name, c.status, c.degraded, c.http_status, c.response_time_ms, c.retries, c.error_code
    FROM check_results c JOIN websites w ON w.id = c.website_id
    WHERE ${where} ORDER BY c.checked_at DESC LIMIT ${CHECKS_EXPORT_LIMIT}
  `);
  const rows = checkRows(ctx, res.rows);
  const sheet = `${sheets.checksSheet} (export)`;
  await client.ensureSheet(sheet, ["เวลา", "เว็บไซต์", "ผล", "HTTP", "Response (ms)", "Retry", "Error"]);
  await client.append(sheet, rows);
  const msg = `ส่งผลตรวจ ${rows.length} แถวไปชีต "${sheet}"`;
  await logEvent(ctx.db, { type: "SHEETS_EXPORT", level: "SUCCESS", message: msg });
  return msg;
}
