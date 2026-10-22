import os from "node:os";
import { createLogger, TIMEZONE_HINT } from "@app/core";
import { createDb, sql, withLease } from "@app/db";
import { createSettingsCache, type WorkerContext } from "./context";
import { loadEnv } from "./env";
import { beat, startWatchdog } from "./heartbeat";
import { processAiJobs } from "./jobs/ai";
import { runCanary } from "./jobs/canary";
import { closeOrphanIncidents, ensureStates, sweepStaleRootCauses } from "./jobs/checks";
import { refreshFavicons } from "./jobs/favicons";
import { enqueuePostmortems, processPostmortems } from "./jobs/postmortem";
import { runLookalikeWatch, runSecurityScans } from "./jobs/security";
import { dispatchSecurityAlerts } from "./jobs/security-alerts";
import { runVisualChecks } from "./jobs/visual";
import { runAnomalyDetection, runAutoDiagnosis, runFingerprints } from "./jobs/insights";
import { drainJobRequests, processJobRequests } from "./jobs/job-requests";
import { runJourneys } from "./jobs/journeys";
import { dispatchNotifications, stopDispatching } from "./jobs/notifications";
import { maybeRunRetention } from "./jobs/retention";
import { rollupRecent } from "./jobs/rollup";
import { maybeScheduledSheetsSync } from "./jobs/sheets";
import { CheckPool, every } from "./loop";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const env = loadEnv();
  const workerId = `${os.hostname()}:${process.pid}`;
  const log = createLogger({ level: env.LOG_LEVEL, bindings: { service: "worker", workerId } });
  // งานหนักสุดคือ retention (ลบทีละ 10,000 แถว) และ rollup — 2 นาทีพอเหลือเฟือ
  const { db, pool } = createDb(env.DATABASE_URL, {
    applicationName: "worker",
    max: 20,
    statementTimeoutMs: 120_000,
  });
  pool.on("error", (err) => log.error("pg pool error", { err }));

  const ctx: WorkerContext = {
    db,
    env,
    log,
    workerId,
    canary: { failing: false, checkedAt: null },
    settings: createSettingsCache(db),
  };

  // PostgreSQL ต้องรู้จัก timezone นี้ด้วย (SQL ใช้ AT TIME ZONE) — ไม่งั้นงานสรุป/ลบข้อมูลล้มทุกรอบแบบเงียบ
  const tzOk = await db.execute(sql`SELECT 1 FROM pg_timezone_names WHERE name = ${env.APP_TIMEZONE}`);
  if (tzOk.rows.length === 0)
    throw new Error(`APP_TIMEZONE: PostgreSQL ไม่รู้จัก timezone นี้ — ${TIMEZONE_HINT}`);
  await ensureStates(db);
  const startedAt = new Date();
  const checks = new CheckPool(ctx);
  const tz = env.APP_TIMEZONE;

  // heartbeat ไม่สำเร็จ 5 นาที (หรือ 6 รอบ ถ้าตั้งรอบไว้นาน) = ค้าง → ออกให้ Docker รีสตาร์ท
  const watchdog = startWatchdog({
    maxStaleMs: Math.max(300_000, env.WORKER_HEARTBEAT_INTERVAL_MS * 6),
    onStale: (staleMs) => {
      log.error("watchdog: heartbeat stalled — exiting so the container restarts", { staleMs });
      process.exit(1);
    },
  });
  // งานตามรอบที่ไม่ควรทำซ้อนกันเมื่อรัน Worker มากกว่า 1 ตัว (ถ่ายภาพ/Journey/สแกน/ลบข้อมูลเก่า)
  // — ตัวที่ได้ lease ทำ ตัวอื่นข้ามรอบนั้น · lease หมดอายุเองถ้าตัวที่ถือตายกลางคัน
  const exclusive = (name: string, ttlMs: number, fn: () => Promise<unknown>) => async () => {
    await withLease(db, `job:${name}`, workerId, ttlMs, fn);
  };
  const loops = [
    every(
      "heartbeat",
      env.WORKER_HEARTBEAT_INTERVAL_MS,
      async () => {
        await beat(db, { workerId, startedAt, version: VERSION }, checks.stats());
        watchdog.ok();
      },
      log,
    ),
    every("canary", 60_000, () => runCanary(ctx), log),
    every("checks", env.WORKER_POLL_INTERVAL_MS, () => checks.tick(), log, 1_000),
    every("outbox", 5_000, async () => void (await dispatchNotifications(ctx)), log, 2_000),
    every("ai", 10_000, () => processAiJobs(ctx), log, 3_000),
    every("jobs", 3_000, () => processJobRequests(ctx), log, 2_000),
    every(
      "favicons",
      120_000,
      exclusive("favicons", 10 * 60_000, () => refreshFavicons(ctx)),
      log,
      15_000,
    ),
    every(
      "postmortem",
      15_000,
      async () => {
        await enqueuePostmortems(ctx);
        await processPostmortems(ctx);
      },
      log,
      8_000,
    ),
    every(
      "security-scan",
      300_000,
      exclusive("security-scan", 10 * 60_000, () => runSecurityScans(ctx)),
      log,
      30_000,
    ),
    every(
      "visual",
      300_000,
      exclusive("visual", 10 * 60_000, () => runVisualChecks(ctx)),
      log,
      45_000,
    ),
    every(
      "lookalike",
      600_000,
      exclusive("lookalike", 15 * 60_000, () => runLookalikeWatch(ctx)),
      log,
      60_000,
    ),
    every(
      "diagnose",
      10_000,
      exclusive("diagnose", 10 * 60_000, () => runAutoDiagnosis(ctx)),
      log,
      6_000,
    ),
    every(
      "fingerprints",
      60_000,
      exclusive("fingerprints", 10 * 60_000, () => runFingerprints(ctx)),
      log,
      25_000,
    ),
    every(
      "anomaly",
      300_000,
      exclusive("anomaly", 10 * 60_000, () => runAnomalyDetection(ctx)),
      log,
      90_000,
    ),
    every(
      "journeys",
      60_000,
      exclusive("journeys", 15 * 60_000, () => runJourneys(ctx)),
      log,
      50_000,
    ),
    // ไม่มีการ claim รายฉบับ — Worker 2 ตัว (เช่น ช่วงอัปเดต) จะส่งอีเมลเดียวกันซ้ำ → ทำทีละตัว
    every(
      "security-alerts",
      30_000,
      exclusive("security-alerts", 15 * 60_000, () => dispatchSecurityAlerts(ctx)),
      log,
      20_000,
    ),
    every(
      "rollup",
      600_000,
      exclusive("rollup", 30 * 60_000, () => rollupRecent(db, tz)),
      log,
      5_000,
    ),
    // แยกจาก maintenance — sync ที่ช้า/โดน 429 ไม่ทำให้การปิด Incident ค้าง/ลบข้อมูลเก่าล่าช้า
    every("sheets", 60_000, () => maybeScheduledSheetsSync(ctx), log, 40_000),
    every(
      "maintenance",
      60_000,
      async () => {
        await ensureStates(db);
        await closeOrphanIncidents(db);
        await sweepStaleRootCauses(ctx);
        await withLease(db, "job:retention", workerId, 60 * 60_000, () => maybeRunRetention(ctx));
      },
      log,
      10_000,
    ),
  ];
  log.info("worker started", {
    version: VERSION,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    canaries: env.canaryUrls.length,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    watchdog.stop();
    stopDispatching();
    // Docker ให้เวลา 40 วินาที (stop_grace_period) ก่อน SIGKILL — ออกเองก่อนถ้ายังค้าง
    setTimeout(() => {
      log.error("shutdown took too long — forcing exit");
      process.exit(1);
    }, 35_000).unref();
    // หยุดรับงานใหม่ แล้วรอให้การตรวจที่ค้างอยู่จบก่อนปิด pool
    await Promise.all(loops.map((l) => l.stop()));
    await checks.drain();
    await drainJobRequests();
    await pool.end();
    log.info("worker stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // ยังไม่มี logger (เช่น env ผิด) → พิมพ์เฉพาะ message ไม่พิมพ์ object ที่อาจมีค่า secret
  // แสดงสาเหตุจริงด้วย (เช่น "password authentication failed") — ข้อความของ drizzle บอกแค่ query ที่ล้ม
  const cause = err instanceof Error && err.cause instanceof Error ? ` — สาเหตุ: ${err.cause.message}` : "";
  // บรรทัดแรกเท่านั้น (บรรทัด params ของ drizzle อาจมีข้อมูล)
  console.error(err instanceof Error ? `${err.message.split("\n")[0]}${cause}` : "worker failed to start");
  process.exit(1);
});
