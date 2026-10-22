/**
 * Integration test ของ pipeline หลักกับ PostgreSQL จริง
 * รันเมื่อมี TEST_DATABASE_URL เท่านั้น (ฐานข้อมูลแยกสำหรับเทสต์ — จะถูกล้างข้อมูล)
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/monitor_test pnpm test
 */
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createLogger, dayKey, SETTINGS_DEFAULTS, type CheckOutcome, type SettingsMap } from "@app/core";
import {
  aiAnalyses,
  closeIncidentsOfInactiveSite,
  createDb,
  eq,
  events,
  incidents,
  notificationEvents,
  sql,
  websites,
  websiteState,
  dailySummaries,
  type DbHandle,
  type Website,
} from "@app/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerContext } from "./context";
import { processAiJobs } from "./jobs/ai";
import {
  claimDueChecks,
  closeOrphanIncidents,
  confirmNotOurNetwork,
  recordOutcome,
  sweepStaleRootCauses,
} from "./jobs/checks";
import { dispatchNotifications } from "./jobs/notifications";
import { refreshFavicons } from "./jobs/favicons";
import { drainJobRequests, processJobRequests } from "./jobs/job-requests";
import { dispatchSecurityAlerts } from "./jobs/security-alerts";
import { anomalyBaselines, resetAnomalyBaselineCache, runAnomalyDetection } from "./jobs/insights";
import { rollupRecent } from "./jobs/rollup";
import { runRetention } from "./jobs/retention";
import {
  checksSheetTitle,
  runSheetsSync,
  sheetDate,
  syncChecks,
  syncDailyUptime,
  syncIncidents,
} from "./jobs/sheets";
import { finishAiCall, getState, recheckRootCauses, reserveAiCall, tryAcquireLease } from "@app/db";
import { raiseAlertOnce, withBrowser } from "./jobs/visual";
import { redactEmails } from "./jobs/postmortem";
import type { SheetsClient } from "@app/core/server";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

let handle: DbHandle;
let smtp: SMTPServer;
let smtpPort = 0;
const mails: string[] = [];
let settings: SettingsMap;

function ctx(): WorkerContext {
  return {
    db: handle.db,
    env: {
      DATABASE_URL: url!,
      APP_BASE_URL: "http://monitor.test:3000",
      APP_TIMEZONE: "Asia/Bangkok",
      LOG_LEVEL: "error",
      WORKER_POLL_INTERVAL_MS: 1000,
      WORKER_HEARTBEAT_INTERVAL_MS: 30000,
      CHECK_MAX_BODY_BYTES: 65536,
      CANARY_URLS: "",
      canaryUrls: [],
      SMTP_PASSWORD: undefined,
      SMTP_ALLOWED_HOST: undefined,
      AI_API_KEY: undefined,
      AI_BASE_URL: undefined,
      GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
      CHROMIUM_PATH: undefined,
    },
    log: createLogger({ level: "error" }),
    workerId: "test-worker",
    canary: { failing: false, checkedAt: null },
    settings: async () => settings,
  };
}

function outcome(status: CheckOutcome["status"], extra: Partial<CheckOutcome> = {}): CheckOutcome {
  const now = new Date();
  return {
    status,
    degraded: false,
    retries: status === "UP" ? 0 : 2,
    httpStatus: status === "UP" ? 200 : status === "DOWN" ? 503 : null,
    firstHttpStatus: null,
    responseTimeMs: status === "UP" ? 120 : 88,
    errorCode: status === "UP" ? null : status === "DOWN" ? "HTTP_STATUS" : "SSRF_BLOCKED",
    errorMessage: status === "UP" ? null : "x",
    finalUrl: null,
    redirectCount: 0,
    remoteIp: "93.184.216.34",
    dnsMs: 5,
    connectMs: 10,
    tlsMs: 30,
    startedAt: now,
    finishedAt: new Date(now.getTime() + 100),
    ...extra,
  };
}

async function addSite(name: string, extra: Partial<typeof websites.$inferInsert> = {}): Promise<Website> {
  const [w] = await handle.db
    .insert(websites)
    .values({
      name,
      url: `https://${name}.example.com`,
      alertEmails: ["ops@example.com", "it@example.com"],
      ...extra,
    })
    .returning();
  await handle.db.insert(websiteState).values({ websiteId: w!.id });
  return w!;
}

const openIncidents = (websiteId: number) =>
  handle.db
    .select()
    .from(incidents)
    .where(sql`${incidents.websiteId} = ${websiteId} AND ${incidents.recoveredAt} IS NULL`);

d("worker pipeline (real PostgreSQL)", () => {
  beforeAll(async () => {
    handle = createDb(url!, { max: 10 });
    await migrate(handle.db, {
      migrationsFolder: path.resolve(import.meta.dirname, "../../../packages/db/migrations"),
    });
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, session, cb) {
        stream.on("data", () => undefined);
        stream.on("end", () => {
          mails.push(session.envelope.rcptTo.map((r) => r.address).join(","));
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
    smtpPort = (smtp.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => smtp.close(() => r()));
    await handle.pool.end();
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`TRUNCATE websites, website_state, check_results, incidents, events, notification_events, ai_analyses, ai_calls, daily_summaries, integration_sync_logs RESTART IDENTITY CASCADE`,
    );
    await handle.db.execute(sql`DELETE FROM app_settings WHERE key LIKE 'lease:%' OR key LIKE 'state:%'`);
    mails.length = 0;
    settings = {
      ...SETTINGS_DEFAULTS,
      smtp: {
        host: "127.0.0.1",
        port: smtpPort,
        security: "NONE",
        username: "",
        from: "Monitor <m@example.com>",
        alertEmails: [],
      },
    };
  });

  it("recipients for every site get DOWN too — merged with the site's own, no duplicates", async () => {
    settings = {
      ...settings,
      smtp: { ...settings.smtp, alertEmails: ["OPS@example.com", "boss@example.com"] },
    };
    const own = await addSite("own", { alertEmails: ["ops@example.com"] });
    const none = await addSite("none", { alertEmails: [] });
    for (const s of [own, none]) {
      await recordOutcome(ctx(), s, outcome("DOWN"));
      await recordOutcome(ctx(), s, outcome("DOWN"));
    }
    const rows = await handle.db.execute<{ name: string; recipient: string }>(sql`
      SELECT w.name, n.recipient FROM notification_events n
      JOIN incidents i ON i.id = n.incident_id JOIN websites w ON w.id = i.website_id
      WHERE n.event_type = 'DOWN' ORDER BY w.name, n.recipient
    `);
    expect(rows.rows).toEqual([
      { name: "none", recipient: "boss@example.com" },
      { name: "none", recipient: "ops@example.com" },
      { name: "own", recipient: "boss@example.com" },
      { name: "own", recipient: "ops@example.com" },
    ]);
  });

  it("opens exactly one incident after N failures and sends DOWN once per recipient", async () => {
    const site = await addSite("shop");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    expect(await openIncidents(site.id)).toHaveLength(0);
    const [s1] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    expect(s1).toMatchObject({ consecutiveFailures: 1, status: "UP" });

    await recordOutcome(ctx(), site, outcome("DOWN"));
    const open = await openIncidents(site.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ cause: "HTTP 503", failedCheckCount: 2 });
    const [s2] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    expect(s2!.status).toBe("DOWN");

    // ล้มเหลวต่อ — ไม่เปิดซ้ำ ไม่สร้างอีเมลซ้ำ
    await recordOutcome(ctx(), site, outcome("DOWN"));
    expect(await openIncidents(site.id)).toHaveLength(1);
    const notif = await handle.db.select().from(notificationEvents);
    expect(notif).toHaveLength(2);
    expect(notif.every((n) => n.eventType === "DOWN" && n.status === "PENDING")).toBe(true);
    const [inc] = await openIncidents(site.id);
    expect(inc!.failedCheckCount).toBe(3);

    // ส่งจริงผ่าน SMTP แล้วไม่ส่งซ้ำ
    expect(await dispatchNotifications(ctx())).toBe(2);
    expect(mails.sort()).toEqual(["it@example.com", "ops@example.com"]);
    expect(await dispatchNotifications(ctx())).toBe(0);
    const sent = await handle.db.select().from(notificationEvents);
    expect(
      sent.every((n) => n.status === "SENT" && n.attempts === 1 && n.smtpResponse?.startsWith("250")),
    ).toBe(true);

    // first-failure event ถูกผูกเข้ากับ incident
    const evs = await handle.db.select().from(events).where(eq(events.incidentId, inc!.id));
    expect(evs.map((e) => e.type)).toEqual(
      expect.arrayContaining(["FIRST_FAILURE", "INCIDENT_OPENED", "OUTBOX_CREATED", "EMAIL_SENT"]),
    );
  });

  it("closes after N successes and sends RECOVERY once", async () => {
    const site = await addSite("booking");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await dispatchNotifications(ctx());
    await recordOutcome(ctx(), site, outcome("UP"));
    expect(await openIncidents(site.id)).toHaveLength(1); // ยังไม่ครบ 2 รอบ
    await recordOutcome(ctx(), site, outcome("UP"));
    expect(await openIncidents(site.id)).toHaveLength(0);
    const [inc] = await handle.db.select().from(incidents);
    expect(inc!.recoveredAt).not.toBeNull();
    const rec = (await handle.db.select().from(notificationEvents)).filter((n) => n.eventType === "RECOVERY");
    expect(rec).toHaveLength(2);
    mails.length = 0;
    expect(await dispatchNotifications(ctx())).toBe(2);
    expect(mails).toHaveLength(2);
    const [state] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    expect(state).toMatchObject({ status: "UP", consecutiveFailures: 0, consecutiveSuccesses: 2 });
  });

  it("does not send RECOVERY when disabled for the site", async () => {
    const site = await addSite("norecovery", { sendRecovery: false });
    for (const s of ["DOWN", "DOWN", "UP", "UP"] as const) await recordOutcome(ctx(), site, outcome(s));
    const rec = (await handle.db.select().from(notificationEvents)).filter((n) => n.eventType === "RECOVERY");
    expect(rec).toHaveLength(0);
  });

  it("UNKNOWN neither counts as a failure nor resets the streak", async () => {
    const site = await addSite("blog");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await recordOutcome(ctx(), site, outcome("UNKNOWN"));
    let [state] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    expect(state).toMatchObject({ status: "UNKNOWN", consecutiveFailures: 1 });
    await recordOutcome(ctx(), site, outcome("DOWN"));
    expect(await openIncidents(site.id)).toHaveLength(1);
    [state] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    expect(state!.status).toBe("DOWN");
  });

  it("concurrent results for the same site cannot open two incidents", async () => {
    const site = await addSite("race");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await Promise.all([
      recordOutcome(ctx(), site, outcome("DOWN")),
      recordOutcome(ctx(), site, outcome("DOWN")),
    ]);
    expect(await openIncidents(site.id)).toHaveLength(1);
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(2);
  });

  it("claimDueChecks hands each due site to exactly one claimer (SKIP LOCKED) and pushes next_check_at", async () => {
    for (let i = 0; i < 6; i++) await addSite(`site${i}`, { checkIntervalSeconds: 300 });
    const disabled = await addSite("disabled", { enabled: false });
    const [a, b] = await Promise.all([claimDueChecks(handle.db, 6), claimDueChecks(handle.db, 6)]);
    const ids = [...a!, ...b!].map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(disabled.id);
    expect(await claimDueChecks(handle.db, 10)).toHaveLength(0);
    const [st] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, ids[0]!));
    expect(st!.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
  });

  it("email failures back off and stop after the max attempts", async () => {
    settings = { ...settings, smtp: { ...settings.smtp, port: 1 } }; // พอร์ตที่ปิดอยู่
    const site = await addSite("mailfail", { alertEmails: ["ops@example.com"] });
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await recordOutcome(ctx(), site, outcome("DOWN"));
    expect(await dispatchNotifications(ctx())).toBe(0);
    let [n] = await handle.db.select().from(notificationEvents);
    expect(n).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(n!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await dispatchNotifications(ctx())).toBe(0); // ยังไม่ถึงเวลา retry → ไม่ส่ง
    await handle.db
      .update(notificationEvents)
      .set({ attempts: 11, nextAttemptAt: new Date(Date.now() - 1000) });
    await dispatchNotifications(ctx());
    [n] = await handle.db.select().from(notificationEvents);
    expect(n).toMatchObject({ status: "DEAD", attempts: 12 });
  });

  it("SMTP not configured: emails stay queued without using up attempts", async () => {
    settings = { ...settings, smtp: { ...settings.smtp, host: "" } };
    const site = await addSite("nosmtp", { alertEmails: ["ops@example.com"] });
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await recordOutcome(ctx(), site, outcome("DOWN"));
    expect(await dispatchNotifications(ctx())).toBe(0);
    const [n] = await handle.db.select().from(notificationEvents);
    expect(n).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("RECOVERY waits until the DOWN email for the same recipient is sent", async () => {
    const site = await addSite("order", { alertEmails: ["ops@example.com"] });
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), site, outcome(s));
    // DOWN ส่งไม่ผ่าน (SMTP ขัดข้อง) และรอ retry
    await handle.db
      .update(notificationEvents)
      .set({ status: "FAILED", attempts: 3, nextAttemptAt: new Date(Date.now() + 3_600_000) });
    for (const s of ["UP", "UP"] as const) await recordOutcome(ctx(), site, outcome(s));
    expect(await dispatchNotifications(ctx())).toBe(0); // RECOVERY ยังไม่ออกก่อน DOWN
    await handle.db
      .update(notificationEvents)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(notificationEvents.eventType, "DOWN"));
    expect(await dispatchNotifications(ctx())).toBe(1); // DOWN ออกก่อน
    expect(await dispatchNotifications(ctx())).toBe(1); // แล้วค่อย RECOVERY
  });

  it("disabling/archiving closes the open incident, resets the streak and releases dependents", async () => {
    const db = await addSite("db", { alertEmails: [] });
    const app = await addSite("app", { alertEmails: ["ops@example.com"] });
    await handle.db.execute(
      sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES (${app.id}, ${db.id})`,
    );
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), db, outcome(s));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), app, outcome(s));
    const [appInc] = await openIncidents(app.id);
    expect(appInc!.rootCauseWebsiteId).toBe(db.id);
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(0); // ล่มตามกัน → ไม่ส่ง

    // ผู้ดูแลปิดการตรวจ db (เหมือนกดปุ่มในหน้าเว็บ)
    await handle.db.transaction(async (tx) => {
      await tx.update(websites).set({ enabled: false }).where(eq(websites.id, db.id));
      await closeIncidentsOfInactiveSite(tx, db.id, "ปิดการตรวจ db");
    });
    expect(await openIncidents(db.id)).toHaveLength(0);
    const [st] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, db.id));
    expect(st).toMatchObject({ consecutiveFailures: 0, failureStreakFirstCheckId: null });
    // app ยังล่มด้วยตัวเอง → แจ้งเตือนตอนนี้ ไม่ใช่เงียบตลอดไป
    const [after] = await openIncidents(app.id);
    expect(after!.rootCauseWebsiteId).toBeNull();
    const queued = await handle.db.select().from(notificationEvents);
    expect(queued.map((n) => `${n.eventType}:${n.recipient}`)).toEqual(["DOWN:ops@example.com"]);
    // incident ที่ปิดเพราะหยุดตรวจ ไม่มี recovery check และไม่ส่ง RECOVERY
    const [closed] = await handle.db.select().from(incidents).where(eq(incidents.websiteId, db.id));
    expect(closed!.recoveryCheckId).toBeNull();
  });

  it("when the root cause recovers, a dependent that is still down gets alerted", async () => {
    const db = await addSite("db2", { alertEmails: [] });
    const app = await addSite("app2", { alertEmails: ["ops@example.com"] });
    await handle.db.execute(
      sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES (${app.id}, ${db.id})`,
    );
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), db, outcome(s));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), app, outcome(s));
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(0);
    for (const s of ["UP", "UP"] as const) await recordOutcome(ctx(), db, outcome(s));
    const [inc] = await openIncidents(app.id);
    expect(inc!.rootCauseWebsiteId).toBeNull();
    expect((await handle.db.select().from(notificationEvents)).map((n) => n.eventType)).toEqual(["DOWN"]);
    // app กลับมา → RECOVERY ส่งได้ (เพราะแจ้ง DOWN ไปแล้วจริง)
    for (const s of ["UP", "UP"] as const) await recordOutcome(ctx(), app, outcome(s));
    const kinds = (await handle.db.select().from(notificationEvents)).map((n) => n.eventType).sort();
    expect(kinds).toEqual(["DOWN", "RECOVERY"]);
  });

  it("root cause recovering at the same moment a dependent opens its incident: the dependent is still alerted", async () => {
    const db = await addSite("rdb", { alertEmails: [] });
    const app = await addSite("rapp", { alertEmails: ["ops@example.com"] });
    await handle.db.execute(
      sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES (${app.id}, ${db.id})`,
    );
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), db, outcome(s));
    await recordOutcome(ctx(), app, outcome("DOWN"));
    // ทรานแซกชันอื่นกำลังปิด incident ของต้นเหตุ (ยังไม่ commit)
    const other = await handle.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "UPDATE incidents SET recovered_at = now() WHERE website_id = $1 AND recovered_at IS NULL",
        [db.id],
      );
      const opening = recordOutcome(ctx(), app, outcome("DOWN")); // เปิด incident ของ app พร้อมกัน
      await new Promise((r) => setTimeout(r, 300));
      await other.query("COMMIT");
      await opening;
    } finally {
      other.release();
    }
    const [inc] = await openIncidents(app.id);
    expect(inc!.rootCauseWebsiteId).toBeNull(); // ไม่ได้บันทึกว่าล่มตามต้นเหตุที่กลับมาแล้ว
    expect((await handle.db.select().from(notificationEvents)).map((n) => n.eventType)).toEqual(["DOWN"]);
  });

  it("maintenance releases incidents still pointing at a root cause that is no longer down", async () => {
    const db = await addSite("sdb", { alertEmails: [] });
    const app = await addSite("sapp", { alertEmails: ["ops@example.com"] });
    await handle.db.execute(
      sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES (${app.id}, ${db.id})`,
    );
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), db, outcome(s));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), app, outcome(s));
    // ปิด incident ต้นเหตุตรงๆ โดยไม่ผ่านการปล่อย (จำลองกรณีที่หลุด)
    await handle.db.execute(sql`UPDATE incidents SET recovered_at = now() WHERE website_id = ${db.id}`);
    expect(await sweepStaleRootCauses(ctx())).toBe(1);
    const [inc] = await openIncidents(app.id);
    expect(inc!.rootCauseWebsiteId).toBeNull();
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(1);
    expect(await sweepStaleRootCauses(ctx())).toBe(0);
  });

  it("removing a dependency while the root cause is still down alerts the dependent right away", async () => {
    const db = await addSite("ddb", { alertEmails: [] });
    const app = await addSite("dapp", { alertEmails: ["ops@example.com"] });
    await handle.db.execute(
      sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES (${app.id}, ${db.id})`,
    );
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), db, outcome(s));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), app, outcome(s));
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(0); // ล่มตามกัน → เงียบ
    // ผู้ดูแลเอาการพึ่งพาออก (db ยังล่มอยู่) — แบบเดียวกับ PUT /dependencies
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM website_dependencies WHERE website_id = ${app.id}`);
      await recheckRootCauses(tx, [app.id]);
    });
    const [inc] = await openIncidents(app.id);
    expect(inc!.rootCauseWebsiteId).toBeNull();
    expect((await handle.db.select().from(notificationEvents)).map((n) => n.eventType)).toEqual(["DOWN"]);
    // งาน maintenance ไม่ปล่อยซ้ำ
    expect(await sweepStaleRootCauses(ctx())).toBe(0);
  });

  it("a disabled/archived dependency never suppresses alerts", async () => {
    const db = await addSite("db3", { alertEmails: [] });
    const app = await addSite("app3", { alertEmails: ["ops@example.com"] });
    await handle.db.execute(
      sql`INSERT INTO website_dependencies (website_id, depends_on_id) VALUES (${app.id}, ${db.id})`,
    );
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), db, outcome(s));
    // ปิดการตรวจ db โดยแก้ฐานข้อมูลตรง (incident ยังค้าง — กรณีข้อมูลเก่า)
    await handle.db.update(websites).set({ enabled: false }).where(eq(websites.id, db.id));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), app, outcome(s));
    const [inc] = await openIncidents(app.id);
    expect(inc!.rootCauseWebsiteId).toBeNull();
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(1);
    // งาน maintenance ปิด incident ค้างของเว็บที่หยุดตรวจ
    expect(await closeOrphanIncidents(handle.db)).toBe(1);
    expect(await openIncidents(db.id)).toHaveLength(0);
  });

  it("a result that finishes after the site was disabled is discarded", async () => {
    const site = await addSite("flappy");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await handle.db.update(websites).set({ enabled: false }).where(eq(websites.id, site.id));
    await recordOutcome(ctx(), site, outcome("DOWN")); // ตรวจค้างอยู่ตอนถูกปิด
    expect(await openIncidents(site.id)).toHaveLength(0);
    expect(await handle.db.select().from(notificationEvents)).toHaveLength(0);
  });

  it("opens the incident even if the streak's first check was deleted by retention", async () => {
    const site = await addSite("retained");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    const [st] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    // จำลอง retention ลบผลตรวจแรกของ streak ไปแล้ว
    await handle.db.execute(sql`DELETE FROM check_results WHERE id = ${st!.failureStreakFirstCheckId}`);
    await recordOutcome(ctx(), site, outcome("DOWN"));
    expect(await openIncidents(site.id)).toHaveLength(1);
    const [st2] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, site.id));
    expect(st2!.status).toBe("DOWN");
  });

  it("a redirect to a private address is DOWN on a healthy network, UNKNOWN while the network itself fails", async () => {
    const noPublicDns = async () => ({ addresses: [] as string[] });
    const fresh = { failing: false, checkedAt: new Date() };
    // เน็ตปกติ → ล่มจริง เปิด incident ได้ (ไม่ค้าง UNKNOWN ตลอดไป)
    const site = await addSite("moved");
    for (let i = 0; i < 2; i++) {
      const c = { ...ctx(), canary: fresh };
      const raw = outcome("DOWN", { errorCode: "PRIVATE_REDIRECT", httpStatus: null });
      await recordOutcome(c, site, await confirmNotOurNetwork(c, raw, site.url, noPublicDns));
    }
    expect(await openIncidents(site.id)).toHaveLength(1);
    // เน็ตของ worker ถูกจับไปหน้า login ของเราเตอร์ (canary ล้ม) → ไม่นับว่าเว็บล่ม
    const other = await addSite("captive");
    for (let i = 0; i < 3; i++) {
      const c = { ...ctx(), canary: { failing: true, checkedAt: new Date() } };
      const raw = outcome("DOWN", { errorCode: "PRIVATE_TARGET", httpStatus: null });
      await recordOutcome(c, other, await confirmNotOurNetwork(c, raw, other.url, noPublicDns));
    }
    expect(await openIncidents(other.id)).toHaveLength(0);
    const [st] = await handle.db.select().from(websiteState).where(eq(websiteState.websiteId, other.id));
    expect(st!.consecutiveFailures).toBe(0);
  });

  it("Sheets incident sync never resends or skips, even for incidents closed in the same millisecond", async () => {
    const appended: unknown[][] = [];
    const client = {
      ensureSheet: async () => undefined,
      append: async (_sheet: string, rows: unknown[][]) => void appended.push(...rows),
    } as unknown as SheetsClient;
    const a = await addSite("sa");
    const b = await addSite("sb");
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), a, outcome(s));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), b, outcome(s));
    // ปิดทั้งสอง incident ในคำสั่งเดียว → เวลาปิดเท่ากัน (กรณีที่ cursor แบบเวลาอย่างเดียวจะข้ามหรือซ้ำ)
    await handle.db.execute(sql`
      UPDATE incidents SET recovered_at = (SELECT max(started_at) FROM incidents) + interval '0.000456 seconds'
      WHERE recovered_at IS NULL
    `);
    const s = settings.sheets;
    expect(await syncIncidents(ctx(), client, s)).toBe(2);
    expect(await syncIncidents(ctx(), client, s)).toBe(0); // ไม่ส่งซ้ำ
    // incident ใหม่ที่ปิดด้วยการหยุดตรวจ (now() ของฐานข้อมูล) ก็ส่งครั้งเดียว
    const c = await addSite("sc");
    for (const st of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), c, outcome(st));
    await closeIncidentsOfInactiveSite(handle.db, c.id, "ปิดการตรวจ");
    expect(await syncIncidents(ctx(), client, s)).toBe(1);
    expect(await syncIncidents(ctx(), client, s)).toBe(0);
    expect(appended.map((r) => r[1]).sort()).toEqual(["sa", "sb", "sc"]);
  });

  /** ชีตจำลองในหน่วยความจำ: append ล้มได้หลังเขียนแล้ว (เหมือนหมดเวลารอคำตอบ) */
  function fakeSheets() {
    const data = new Map<string, unknown[][]>();
    const state = { failAfterWrite: false, appends: 0 };
    const client = {
      sheetTitles: async () => [...data.keys()],
      ensureSheet: async (title: string, header: unknown[]) => {
        if (!data.has(title)) data.set(title, [header]);
      },
      append: async (title: string, rows: unknown[][]) => {
        state.appends++;
        data.get(title)!.push(...rows);
        if (state.failAfterWrite) throw new Error("Sheets API timeout");
        return rows.length;
      },
      columnValues: async (title: string, cols: string) => {
        const idx = cols === "A:B" ? [0, 1] : cols === "H:H" ? [7] : [0];
        // วันที่ที่ USER_ENTERED → เลข serial ของ Sheets
        const raw = (v: unknown) =>
          typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
            ? String((Date.parse(`${v}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000)
            : String(v ?? "");
        return (data.get(title) ?? []).map((r) => idx.map((i) => raw(r[i])));
      },
    };
    return { client: client as unknown as SheetsClient, data, state };
  }

  it("Sheets: a write that timed out is not appended again on the next round", async () => {
    const { client, data, state } = fakeSheets();
    const a = await addSite("t1");
    for (const s of ["DOWN", "DOWN", "UP", "UP"] as const) await recordOutcome(ctx(), a, outcome(s));
    state.failAfterWrite = true;
    await expect(syncIncidents(ctx(), client, settings.sheets)).rejects.toThrow("timeout");
    state.failAfterWrite = false;
    expect(await syncIncidents(ctx(), client, settings.sheets)).toBe(0); // มีในชีตแล้ว → ข้าม
    expect(data.get(settings.sheets.incidentSheet)!.length).toBe(2); // หัวตาราง + 1 แถว

    for (let i = 0; i < 3; i++) await recordOutcome(ctx(), a, outcome("UP"));
    state.failAfterWrite = true;
    await expect(syncChecks(ctx(), client, settings.sheets)).rejects.toThrow();
    state.failAfterWrite = false;
    expect(await syncChecks(ctx(), client, settings.sheets)).toBe(0);
    // ชีตผลตรวจแยกรายเดือน เช่น "Check History 2026-10"
    const month = checksSheetTitle(settings.sheets.checksSheet, new Date(), "Asia/Bangkok");
    expect(data.get(month)!.length).toBe(1 + 7);
  });

  it("Sheets daily uptime sends whole, closed days only — never half a day", async () => {
    const { client, data } = fakeSheets();
    const a = await addSite("d1");
    const b = await addSite("d2");
    const tz = "Asia/Bangkok";
    const day = (n: number) => dayKey(new Date(Date.now() - n * 86_400_000), tz);
    const ins = (id: number, d: string, updatedAt: string) =>
      handle.db.execute(sql`
        INSERT INTO daily_summaries (website_id, day, total_checks, up_checks, down_checks, unknown_checks, downtime_seconds, incident_count, updated_at)
        VALUES (${id}, ${d}::date, 10, 9, 1, 0, 60, 1, ${updatedAt}::timestamptz)
      `);
    // 3 วันก่อน: ปิดยอดครบ · เมื่อวาน: เว็บ b ยังสรุปไว้ตั้งแต่ก่อนวันจบ (rollup หลังเที่ยงคืนยังไม่รัน)
    await ins(a.id, day(3), new Date().toISOString());
    await ins(b.id, day(3), new Date().toISOString());
    await ins(a.id, day(1), new Date().toISOString());
    await ins(b.id, day(1), new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(await syncDailyUptime(ctx(), client, settings.sheets)).toBe(2);
    expect(await syncDailyUptime(ctx(), client, settings.sheets)).toBe(0); // เมื่อวานยังไม่ปิดยอด → รอ
    await handle.db.execute(sql`UPDATE daily_summaries SET updated_at = now() WHERE website_id = ${b.id}`);
    expect(await syncDailyUptime(ctx(), client, settings.sheets)).toBe(2);
    const sheet = data.get(settings.sheets.uptimeSheet)!;
    expect(sheet.slice(1).map((r) => `${String(r[0])}|${String(r[1])}`)).toEqual([
      `${day(3)}|d1`,
      `${day(3)}|d2`,
      `${day(1)}|d1`,
      `${day(1)}|d2`,
    ]);
    expect(sheetDate("46000")).toBe("2025-12-09");
  });

  it("Sheets sync never runs twice at the same time (scheduled vs the 'Sync now' button)", async () => {
    const { client } = fakeSheets();
    expect(await tryAcquireLease(handle.db, "sheets-sync", "other-worker", 60_000)).toBe(true);
    await expect(runSheetsSync(ctx(), "test", client)).rejects.toThrow("กำลัง sync");
    await handle.db.execute(sql`DELETE FROM app_settings WHERE key = 'lease:sheets-sync'`);
    expect(await runSheetsSync(ctx(), "test", client)).toContain("Incident");
    // ปล่อย lease หลังจบ
    expect(await tryAcquireLease(handle.db, "sheets-sync", "next", 60_000)).toBe(true);
  });

  it("Sheets incident sync reads a cursor written by the old version (time only) without resending", async () => {
    const appended: unknown[][] = [];
    const client = {
      ensureSheet: async () => undefined,
      append: async (_sheet: string, rows: unknown[][]) => void appended.push(...rows),
    } as unknown as SheetsClient;
    const a = await addSite("old");
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), a, outcome(s));
    await handle.db.execute(
      sql`UPDATE incidents SET recovered_at = '2030-01-01T00:00:00.123456Z' WHERE recovered_at IS NULL`,
    );
    await handle.db.execute(sql`
      INSERT INTO integration_sync_logs (integration, entity_type, status, rows_synced, cursor, started_at, finished_at)
      VALUES ('google_sheets', 'incidents', 'SUCCESS', 1, '2030-01-01T00:00:00.123Z', now(), now())
    `);
    expect(await syncIncidents(ctx(), client, settings.sheets)).toBe(0);
  });

  it("a hung query is cut off by statement_timeout instead of blocking the worker forever", async () => {
    const short = createDb(url!, { max: 1, statementTimeoutMs: 300 });
    try {
      const r = await short.db.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
      expect(r.rows[0]!.statement_timeout).toBe("300ms");
      const t0 = Date.now();
      await expect(short.db.execute(sql`SELECT pg_sleep(5)`)).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(3_000);
      // pool ยังใช้ต่อได้หลัง timeout
      expect((await short.db.execute<{ one: number }>(sql`SELECT 1 AS one`)).rows[0]!.one).toBe(1);
    } finally {
      await short.pool.end();
    }
  });

  it("security alert emails: back off between attempts, wait for recipients, skip archived sites", async () => {
    const quiet = await addSite("noone", { alertEmails: [] });
    const gone = await addSite("gone", { alertEmails: ["ops@example.com"] });
    const live = await addSite("live", { alertEmails: ["ops@example.com"] });
    const add = (websiteId: number, minutesAgo: number, attempts = 0) =>
      handle.db.execute(sql`
        INSERT INTO security_alerts (website_id, type, severity, title, created_at, notify_attempts)
        VALUES (${websiteId}, 'SITE_CHANGE', 'medium', 't', now() - make_interval(mins => ${minutesAgo}), ${attempts})
      `);
    await add(quiet.id, 0);
    await add(gone.id, 0);
    await add(live.id, 2, 2); // ครั้งที่ 3 ส่งได้หลัง 3 นาที → ยังไม่ถึงเวลา
    await handle.db.update(websites).set({ archivedAt: new Date() }).where(eq(websites.id, gone.id));
    await dispatchSecurityAlerts(ctx());
    expect(mails).toHaveLength(0);
    const rows = async () =>
      (
        await handle.db.execute<{
          website_id: number;
          notified_at: Date | null;
          notify_error: string | null;
        }>(sql`SELECT website_id, notified_at, notify_error FROM security_alerts ORDER BY id`)
      ).rows;
    const [q] = await rows();
    expect(q!.notified_at).toBeNull(); // ไม่มีผู้รับ → ไม่ปิดถาวร
    expect(q!.notify_error).toContain("ยังไม่มีผู้รับ");
    // ถึงเวลาลองครั้งที่ 3 + มีผู้รับด้านความปลอดภัยแล้ว → ส่งทั้งสองรายการ ยกเว้นเว็บที่เก็บเข้าคลัง
    await handle.db.execute(sql`UPDATE security_alerts SET created_at = created_at - interval '5 minutes'`);
    settings = { ...settings, security: { ...settings.security, alertEmails: ["sec@example.com"] } };
    await dispatchSecurityAlerts(ctx());
    expect(mails).toHaveLength(2);
    const after = await rows();
    expect(after.map((r) => r.notified_at !== null)).toEqual([true, false, true]);
  });

  it("AI quota: concurrent requests cannot all pass the limit, and tool rounds count", async () => {
    const opts = { provider: "anthropic", model: "m", monthlyLimit: 5 };
    const ids = await Promise.all(Array.from({ length: 12 }, () => reserveAiCall(handle.db, opts)));
    expect(ids.filter((x) => x !== null)).toHaveLength(5);
    const [first] = ids.filter((x): x is number => x !== null);
    await finishAiCall(handle.db, first!, { success: true, extraRequests: 3 });
    const r = await handle.db.execute<{ n: string; ok: string }>(
      sql`SELECT count(*)::text AS n, count(*) FILTER (WHERE success)::text AS ok FROM ai_calls`,
    );
    expect(r.rows[0]).toEqual({ n: "8", ok: "4" });
    expect(await reserveAiCall(handle.db, opts)).toBeNull();
    expect(await reserveAiCall(handle.db, { ...opts, monthlyLimit: 0 })).not.toBeNull(); // 0 = ไม่จำกัด
  });

  it("postmortem input never contains recipients' email addresses", () => {
    expect(redactEmails("ส่งอีเมล DOWN ถึง it.ops@company.co.th, boss@x.com")).toBe(
      "ส่งอีเมล DOWN ถึง <อีเมล>, <อีเมล>",
    );
    expect(redactEmails("ไม่มีอีเมล @ ตรงนี้")).toBe("ไม่มีอีเมล @ ตรงนี้");
  });

  it("emails queued long ago (SMTP set up later) are expired instead of all going out at once", async () => {
    const site = await addSite("backlog", { alertEmails: ["ops@example.com"] });
    for (const s of ["DOWN", "DOWN", "UP", "UP"] as const) await recordOutcome(ctx(), site, outcome(s));
    const fresh = await addSite("fresh", { alertEmails: ["ops@example.com"] });
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), fresh, outcome(s));
    // งานของ backlog เกิดไว้ตั้งแต่ 3 วันก่อน (ตอนยังไม่ได้ตั้ง SMTP)
    await handle.db.execute(sql`
      UPDATE notification_events SET created_at = now() - interval '3 days'
      WHERE incident_id IN (SELECT id FROM incidents WHERE website_id = ${site.id})
    `);
    while ((await dispatchNotifications(ctx())) > 0);
    expect(mails).toEqual(["ops@example.com"]); // เฉพาะ fresh
    const rows = await handle.db.execute<{
      event_type: string;
      status: string;
      last_error: string | null;
    }>(sql`
      SELECT n.event_type, n.status, n.last_error FROM notification_events n
      JOIN incidents i ON i.id = n.incident_id WHERE i.website_id = ${site.id} ORDER BY n.id
    `);
    expect(rows.rows.map((r) => `${r.event_type}:${r.status}`)).toEqual(["DOWN:DEAD", "RECOVERY:DEAD"]);
    expect(rows.rows[0]!.last_error).toContain("ไม่ส่งแล้ว");
  });

  it("retention runs every cleanup query (incl. heartbeats of old workers) on the real schema", async () => {
    await handle.db.execute(sql`
      INSERT INTO worker_heartbeats (worker_id, hostname, pid, started_at, last_seen_at)
      VALUES ('old:1', 'old', 1, now() - interval '30 days', now() - interval '30 days'),
             ('live:2', 'live', 2, now(), now())
      ON CONFLICT DO NOTHING
    `);
    const removed = await runRetention(ctx());
    expect(removed.worker_heartbeats).toBe(1);
    const left = await handle.db.execute<{ worker_id: string }>(sql`SELECT worker_id FROM worker_heartbeats`);
    expect(left.rows.map((r) => r.worker_id)).toContain("live:2");
  });

  it("a browser that cannot start is reported (not silently retried every minute, no leaked proxy)", async () => {
    const c = { ...ctx(), env: { ...ctx().env, CHROMIUM_PATH: process.execPath } }; // ไฟล์มีอยู่ แต่ไม่ใช่ browser
    const t0 = Date.now();
    expect(await withBrowser(c, async () => "never")).toBeNull();
    const state = await getState<{ available: boolean; error?: string }>(handle.db, "visual");
    expect(state).toMatchObject({ available: false });
    expect(state?.error).toBeTruthy();
    // รอบถัดไปภายใน 15 นาทีไม่พยายามเปิดซ้ำ (เดิมลองทุกนาทีและเปิด proxy ค้างทุกครั้ง)
    const t1 = Date.now();
    expect(await withBrowser(c, async () => "never")).toBeNull();
    expect(Date.now() - t1).toBeLessThan(Math.max(50, (t1 - t0) / 2));
  }, 60_000);

  it("page-change alerts: one per issue even when runs overlap, and a pause after acknowledging", async () => {
    const site = await addSite("vis");
    const alert = { websiteId: site.id, type: "VISUAL_CHANGE", severity: "medium", title: "เปลี่ยน 30%" };
    const raised = await Promise.all(Array.from({ length: 5 }, () => raiseAlertOnce(ctx(), alert)));
    expect(raised.filter(Boolean)).toHaveLength(1); // ตามรอบ + กดถ่ายภาพเอง พร้อมกัน → alert เดียว
    await handle.db.execute(sql`UPDATE security_alerts SET acknowledged_at = now()`);
    expect(await raiseAlertOnce(ctx(), alert)).toBe(false); // เพิ่งรับทราบ → ไม่เตือนซ้ำทุกรอบ
    await handle.db.execute(sql`UPDATE security_alerts SET acknowledged_at = now() - interval '25 hours'`);
    expect(await raiseAlertOnce(ctx(), alert)).toBe(true); // ยังเปลี่ยนอยู่หลัง 24 ชม. → เตือนอีกครั้ง
  });

  it("web-requested jobs run side by side (a slow one doesn't block the queue)", async () => {
    await handle.db.execute(sql`TRUNCATE job_requests RESTART IDENTITY`);
    await handle.db.execute(
      sql`INSERT INTO job_requests (type) VALUES ('NOPE_A'), ('NOPE_B'), ('NOPE_C'), ('NOPE_D')`,
    );
    await processJobRequests(ctx()); // claim ได้ทีละไม่เกิน 3 งาน
    await drainJobRequests();
    await processJobRequests(ctx());
    await drainJobRequests();
    const rows = await handle.db.execute<{ status: string; result: string }>(
      sql`SELECT status, result FROM job_requests ORDER BY id`,
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["FAILED", "FAILED", "FAILED", "FAILED"]);
    expect(rows.rows[0]!.result).toContain("ไม่รู้จักงานประเภท");
  });

  it("a logo that temporarily can't be fetched keeps the previous one", async () => {
    const site = await addSite("logo", { url: "https://127.0.0.1:9/" }); // ดึงไม่ได้ (บล็อก IP ภายใน)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await handle.db.execute(sql`
      INSERT INTO website_icons (website_id, site_url, ok, content, content_type, source_url, fetched_at)
      VALUES (${site.id}, ${site.url}, true, ${png}, 'image/png', 'x', now() - interval '8 days')
    `);
    await refreshFavicons(ctx());
    const [row] = (
      await handle.db.execute<{ ok: boolean; len: number; due: boolean }>(sql`
        SELECT ok, length(content) AS len, fetched_at < now() - interval '6 days' AS due
        FROM website_icons WHERE website_id = ${site.id}
      `)
    ).rows;
    expect(row).toMatchObject({ ok: true, len: 8, due: true }); // ยังมีโลโก้เดิม และจะลองใหม่ใน 6 ชม.
  });

  it("RECOVERY goes only to people who were told it was down", async () => {
    const site = await addSite("rcp", { alertEmails: ["a@example.com"] });
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), site, outcome(s));
    // ระหว่างล่ม: เพิ่มผู้รับ b และเอา a ออก
    const [fresh] = await handle.db
      .update(websites)
      .set({ alertEmails: ["b@example.com"] })
      .where(eq(websites.id, site.id))
      .returning();
    for (const s of ["UP", "UP"] as const) await recordOutcome(ctx(), fresh!, outcome(s));
    const rows = await handle.db.select().from(notificationEvents);
    expect(rows.map((r) => `${r.eventType}:${r.recipient}`).sort()).toEqual([
      "DOWN:a@example.com",
      "RECOVERY:a@example.com",
    ]);
  });

  it("two failures hours apart (with only UNKNOWN between) don't open a backdated incident", async () => {
    const site = await addSite("gapdown"); // รอบตรวจ 300 วินาที, ยืนยันล่ม 2 ครั้ง
    const t0 = new Date(Date.now() - 6 * 3_600_000);
    await recordOutcome(ctx(), site, outcome("DOWN", { startedAt: t0, finishedAt: t0 }));
    const tu = new Date(t0.getTime() + 3_600_000);
    await recordOutcome(ctx(), site, outcome("UNKNOWN", { startedAt: tu, finishedAt: tu }));
    await recordOutcome(ctx(), site, outcome("DOWN")); // 6 ชม. ต่อมา
    expect(await openIncidents(site.id)).toHaveLength(0); // เป็นความล้มเหลวครั้งแรกของรอบใหม่
    await recordOutcome(ctx(), site, outcome("DOWN"));
    const [inc] = await openIncidents(site.id);
    expect(Date.now() - inc!.startedAt.getTime()).toBeLessThan(60_000); // ไม่ย้อนไปเริ่มเมื่อ 6 ชม. ก่อน
  });

  it("days covered only by an incident (worker down, no checks) still get a daily summary", async () => {
    const site = await addSite("dark");
    await handle.db.execute(
      sql`UPDATE websites SET created_at = now() - interval '30 days' WHERE id = ${site.id}`,
    );
    // Incident คร่อม 5–3 วันก่อน ไม่มีผลตรวจเลยในช่วงนั้น
    await handle.db.execute(sql`
      INSERT INTO incidents (website_id, started_at, confirmed_at, recovered_at, cause, failed_check_count)
      VALUES (${site.id}, now() - interval '5 days', now() - interval '5 days', now() - interval '3 days', 'HTTP 503', 2)
    `);
    await rollupRecent(handle.db, "Asia/Bangkok", { forceStaleScan: true });
    const day = dayKey(new Date(Date.now() - 4 * 86_400_000), "Asia/Bangkok");
    const rows = await handle.db.execute<{ downtime_seconds: number }>(
      sql`SELECT downtime_seconds FROM daily_summaries WHERE website_id = ${site.id} AND day = ${day}::date`,
    );
    expect(Number(rows.rows[0]?.downtime_seconds)).toBe(86_400); // ล่มทั้งวัน
  });

  it("a check that finishes after the URL was changed is discarded", async () => {
    const site = await addSite("moving");
    await handle.db
      .update(websites)
      .set({ url: "https://moving-new.example.com" })
      .where(eq(websites.id, site.id));
    for (const s of ["DOWN", "DOWN"] as const) await recordOutcome(ctx(), site, outcome(s)); // site = ค่าเก่า
    expect(await openIncidents(site.id)).toHaveLength(0);
    const n = await handle.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM check_results WHERE website_id = ${site.id}`,
    );
    expect(n.rows[0]!.n).toBe("0");
  });

  it("AI job fails cleanly when AI is not configured", async () => {
    const site = await addSite("ai");
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await recordOutcome(ctx(), site, outcome("DOWN"));
    const [inc] = await openIncidents(site.id);
    // provider = none → ไม่สร้างงานอัตโนมัติ; สั่งเองแล้วต้อง FAILED พร้อมเหตุผล
    expect(await handle.db.select().from(aiAnalyses)).toHaveLength(0);
    await handle.db.insert(aiAnalyses).values({ incidentId: inc!.id });
    await processAiJobs(ctx());
    const [a] = await handle.db.select().from(aiAnalyses);
    expect(a!.status).toBe("FAILED");
    expect(a!.error).toContain("ยังไม่ได้ตั้งค่า AI");
  });

  it("rollup writes today's daily summary", async () => {
    const site = await addSite("rollup");
    await recordOutcome(ctx(), site, outcome("UP", { responseTimeMs: 100 }));
    await recordOutcome(ctx(), site, outcome("UP", { responseTimeMs: 300 }));
    await recordOutcome(ctx(), site, outcome("DOWN"));
    await rollupRecent(handle.db, "Asia/Bangkok");
    const [row] = await handle.db.select().from(dailySummaries).where(eq(dailySummaries.websiteId, site.id));
    expect(row).toMatchObject({ totalChecks: 3, upChecks: 2, downChecks: 1 });
    expect(row!.avgResponseMs).toBe(200);
  });

  it("rollup re-summarises an older day that was summarised before it ended (worker down across days)", async () => {
    const site = await addSite("gap");
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    // เว็บต้องมีอยู่แล้วในวันนั้น (rollup ไม่นับวันก่อนสร้างเว็บ)
    await handle.db.execute(
      sql`UPDATE websites SET created_at = now() - interval '30 days' WHERE id = ${site.id}`,
    );
    for (let i = 0; i < 4; i++)
      await recordOutcome(
        ctx(),
        site,
        outcome(i === 3 ? "DOWN" : "UP", { startedAt: new Date(fiveDaysAgo.getTime() + i * 60_000) }),
      );
    // สรุปไว้ตอนวันนั้นยังไม่จบ (เหลือ 1 ผลตรวจ) แล้ว worker ก็หยุดไป
    const day = dayKey(fiveDaysAgo, "Asia/Bangkok");
    await handle.db.execute(sql`
      INSERT INTO daily_summaries (website_id, day, total_checks, up_checks, down_checks, unknown_checks, downtime_seconds, incident_count, updated_at)
      VALUES (${site.id}, ${day}::date, 1, 1, 0, 0, 0, 0, ${fiveDaysAgo})
    `);
    // รอบปกติ (ภายใน 1 ชม. หลังสแกนล่าสุด) ไม่สแกนหาวันเก่า — สแกนตอนเริ่ม Worker / ทุกชั่วโมง
    await rollupRecent(handle.db, "Asia/Bangkok", { forceStaleScan: true });
    await rollupRecent(handle.db, "Asia/Bangkok");
    const [row] = await handle.db
      .execute<{ total_checks: number; down_checks: number }>(
        sql`SELECT total_checks, down_checks FROM daily_summaries WHERE website_id = ${site.id} AND day = ${day}::date`,
      )
      .then((r) => r.rows);
    expect(row).toMatchObject({ total_checks: 4, down_checks: 1 });
  });

  it("anomaly detection runs on real data and reuses the 14-day baseline within the hour", async () => {
    const site = await addSite("steady");
    const base = Date.now() - 3 * 86_400_000;
    for (let i = 0; i < 30; i++)
      await recordOutcome(
        ctx(),
        site,
        outcome("UP", { responseTimeMs: 100 + (i % 5), startedAt: new Date(base + i * 3_600_000) }),
      );
    settings = { ...settings, insights: { ...settings.insights, anomalyEnabled: true } };
    resetAnomalyBaselineCache();
    const first = await anomalyBaselines(ctx(), "Asia/Bangkok");
    expect(first.get(site.id)?.a_samples).toBe(30);
    expect(await anomalyBaselines(ctx(), "Asia/Bangkok")).toBe(first); // ไม่สแกนซ้ำ
    await runAnomalyDetection(ctx()); // SQL ทั้งหมดรันได้จริง
    resetAnomalyBaselineCache();
    expect(await anomalyBaselines(ctx(), "Asia/Bangkok")).not.toBe(first);
  });
});
