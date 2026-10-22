import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => tstz("created_at").notNull().defaultNow();
const updatedAt = () =>
  tstz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// หมายเหตุ: ใน check constraint / partial index ใช้ชื่อคอลัมน์ตรง ๆ ใน sql`` เพื่อเลี่ยงชื่อแบบ table-qualified

// ---------- Enums ----------
export const checkStatus = pgEnum("check_status", ["UP", "DOWN", "UNKNOWN"]);
export const userRole = pgEnum("user_role", ["ADMIN", "VIEWER"]);
export const notificationEventType = pgEnum("notification_event_type", ["DOWN", "RECOVERY"]);
/** FAILED = ล้มเหลวแต่ยังจะ retry · DEAD = ครบจำนวนครั้งแล้ว เลิกส่งอัตโนมัติ */
export const notificationStatus = pgEnum("notification_status", ["PENDING", "SENT", "FAILED", "DEAD"]);
export const aiAnalysisStatus = pgEnum("ai_analysis_status", [
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "SKIPPED",
]);
export const syncStatus = pgEnum("sync_status", ["SUCCESS", "FAILED"]);
export const eventLevel = pgEnum("event_level", ["INFO", "SUCCESS", "WARN", "ERROR"]);
export const jobStatus = pgEnum("job_status", ["PENDING", "RUNNING", "DONE", "FAILED"]);

// ---------- Users & Sessions ----------
export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  username: varchar("username", { length: 64 }).notNull().unique("users_username_unique"), // lowercase เสมอ
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("VIEWER"),
  isActive: boolean("is_active").notNull().default(true),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: tstz("locked_until"),
  lastLoginAt: tstz("last_login_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(), // sha256 hex ของ token ใน cookie
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId), index("sessions_expires_at_idx").on(t.expiresAt)],
);

// ---------- Settings (ค่าที่ไม่ใช่ secret — secret อยู่ใน .env เท่านั้น) ----------
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// ---------- Websites ----------
export const websites = pgTable(
  "websites",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: varchar("name", { length: 200 }).notNull(),
    url: text("url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    archivedAt: tstz("archived_at"),
    checkIntervalSeconds: integer("check_interval_seconds").notNull().default(300),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    retryCount: smallint("retry_count").notNull().default(2),
    retryDelayMs: integer("retry_delay_ms").notNull().default(3_000),
    confirmDownCount: smallint("confirm_down_count").notNull().default(2),
    confirmRecoveryCount: smallint("confirm_recovery_count").notNull().default(2),
    upStatusCodes: varchar("up_status_codes", { length: 200 }).notNull().default("200-399"),
    degradedThresholdMs: integer("degraded_threshold_ms"),
    treatAuthAsUp: boolean("treat_auth_as_up").notNull().default(false),
    followRedirects: boolean("follow_redirects").notNull().default(true),
    maxRedirects: smallint("max_redirects").notNull().default(3),
    alertEmails: text("alert_emails")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sendRecovery: boolean("send_recovery").notNull().default(true),
    aiAutoAnalyze: boolean("ai_auto_analyze").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("websites_url_active_unique")
      .on(t.url)
      .where(sql`archived_at IS NULL`),
    check("websites_check_interval_min", sql`check_interval_seconds >= 60`),
    check("websites_timeout_range", sql`timeout_ms BETWEEN 1000 AND 60000`),
    check("websites_retry_range", sql`retry_count BETWEEN 0 AND 5`),
    check("websites_confirm_range", sql`confirm_down_count >= 1 AND confirm_recovery_count >= 1`),
  ],
);

/** สถานะปัจจุบัน 1:1 กับ websites — worker claim งานจากตารางนี้ */
export const websiteState = pgTable(
  "website_state",
  {
    websiteId: integer("website_id")
      .primaryKey()
      .references(() => websites.id, { onDelete: "cascade" }),
    status: checkStatus("status").notNull().default("UNKNOWN"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
    failureStreakStartedAt: tstz("failure_streak_started_at"),
    failureStreakFirstCheckId: bigint("failure_streak_first_check_id", { mode: "number" }),
    nextCheckAt: tstz("next_check_at").notNull().defaultNow(),
    lastCheckedAt: tstz("last_checked_at"),
    lastStatusChangeAt: tstz("last_status_change_at"),
    lastResultId: bigint("last_result_id", { mode: "number" }),
    updatedAt: updatedAt(),
  },
  // รองรับ: WHERE next_check_at <= now() ORDER BY next_check_at FOR UPDATE SKIP LOCKED
  (t) => [index("website_state_next_check_at_idx").on(t.nextCheckAt)],
);

// ---------- Check results ----------
export const checkResults = pgTable(
  "check_results",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    checkedAt: tstz("checked_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    status: checkStatus("status").notNull(),
    degraded: boolean("degraded").notNull().default(false),
    httpStatus: smallint("http_status"),
    firstHttpStatus: smallint("first_http_status"), // status ของ hop แรก (เช่น 302 → 200)
    responseTimeMs: integer("response_time_ms"),
    retries: smallint("retries").notNull().default(0),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"), // ห้ามมี secret/header
    finalUrl: text("final_url"),
    redirectCount: smallint("redirect_count").notNull().default(0),
    remoteIp: varchar("remote_ip", { length: 64 }),
    dnsMs: integer("dns_ms"),
    connectMs: integer("connect_ms"),
    tlsMs: integer("tls_ms"),
    workerId: varchar("worker_id", { length: 100 }),
  },
  (t) => [
    index("check_results_website_checked_idx").on(t.websiteId, t.checkedAt.desc()),
    index("check_results_checked_at_idx").on(t.checkedAt),
  ],
);

// ---------- Incidents ----------
export const incidents = pgTable(
  "incidents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    startedAt: tstz("started_at").notNull(), // เวลาที่ล้มเหลวรอบแรกของ streak
    confirmedAt: tstz("confirmed_at").notNull(), // เวลาที่ยืนยัน DOWN และเปิด incident
    recoveredAt: tstz("recovered_at"),
    cause: text("cause").notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    failedCheckCount: integer("failed_check_count").notNull().default(0),
    firstFailureCheckId: bigint("first_failure_check_id", { mode: "number" }).references(
      () => checkResults.id,
      { onDelete: "set null" },
    ),
    confirmCheckId: bigint("confirm_check_id", { mode: "number" }).references(() => checkResults.id, {
      onDelete: "set null",
    }),
    recoveryCheckId: bigint("recovery_check_id", { mode: "number" }).references(() => checkResults.id, {
      onDelete: "set null",
    }),
    /** ล่มเพราะระบบที่พึ่งพาล่มอยู่ก่อน (จากแผนผังความเชื่อมโยง) — ไม่ส่งอีเมลซ้ำ */
    rootCauseWebsiteId: integer("root_cause_website_id").references(() => websites.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // incident ที่ยังเปิดอยู่ได้แค่ 1 รายการต่อเว็บไซต์
    uniqueIndex("incidents_one_open_per_website")
      .on(t.websiteId)
      .where(sql`recovered_at IS NULL`),
    index("incidents_website_started_idx").on(t.websiteId, t.startedAt.desc()),
    index("incidents_started_idx").on(t.startedAt.desc()),
    // FK ไป check_results แบบ ON DELETE SET NULL: ไม่มี index = ลบผลตรวจเก่าแต่ละแถวต้องสแกน incidents ทั้งตาราง
    index("incidents_first_failure_check_idx")
      .on(t.firstFailureCheckId)
      .where(sql`first_failure_check_id IS NOT NULL`),
    index("incidents_confirm_check_idx")
      .on(t.confirmCheckId)
      .where(sql`confirm_check_id IS NOT NULL`),
    index("incidents_recovery_check_idx")
      .on(t.recoveryCheckId)
      .where(sql`recovery_check_id IS NOT NULL`),
    check("incidents_recovered_after_start", sql`recovered_at IS NULL OR recovered_at >= started_at`),
  ],
);

// ---------- Event log (เหตุการณ์ล่าสุด + timeline ของ incident) ----------
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz("at").notNull().defaultNow(),
    level: eventLevel("level").notNull().default("INFO"),
    type: varchar("type", { length: 64 }).notNull(),
    message: text("message").notNull(),
    detail: text("detail"),
    websiteId: integer("website_id").references(() => websites.id, { onDelete: "cascade" }),
    incidentId: integer("incident_id").references(() => incidents.id, { onDelete: "cascade" }),
  },
  (t) => [index("events_at_idx").on(t.at.desc()), index("events_incident_idx").on(t.incidentId, t.at.desc())],
);

// ---------- Notification outbox ----------
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    // NOT NULL เพื่อให้ unique กันซ้ำได้จริง (NULL ไม่ชนกันใน unique)
    incidentId: integer("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    eventType: notificationEventType("event_type").notNull(),
    recipient: varchar("recipient", { length: 320 }).notNull(),
    status: notificationStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    smtpResponse: text("smtp_response"),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("notification_events_dedupe").on(t.incidentId, t.eventType, t.recipient),
    index("notification_events_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`status IN ('PENDING', 'FAILED')`),
  ],
);

// ---------- AI analyses ----------
export const aiAnalyses = pgTable(
  "ai_analyses",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    incidentId: integer("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    status: aiAnalysisStatus("status").notNull().default("PENDING"),
    provider: varchar("provider", { length: 50 }),
    model: varchar("model", { length: 100 }),
    summary: text("summary"),
    facts: jsonb("facts").$type<string[]>(),
    possibleCauses: jsonb("possible_causes").$type<string[]>(),
    nextSteps: jsonb("next_steps").$type<string[]>(),
    inputCheckCount: integer("input_check_count"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    requestedAt: tstz("requested_at").notNull().defaultNow(),
    completedAt: tstz("completed_at"),
  },
  (t) => [
    unique("ai_analyses_incident_unique").on(t.incidentId), // 1 analysis ต่อ incident (วิเคราะห์ใหม่ = update)
    index("ai_analyses_pending_idx")
      .on(t.requestedAt)
      .where(sql`status = 'PENDING'`),
  ],
);

/** นับโควตารายเดือน — 1 แถวต่อการเรียก provider หนึ่งครั้ง */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz("at").notNull().defaultNow(),
    provider: varchar("provider", { length: 50 }).notNull(),
    model: varchar("model", { length: 100 }),
    success: boolean("success").notNull(),
    error: text("error"),
  },
  (t) => [index("ai_calls_at_idx").on(t.at.desc())],
);

// ---------- Daily summaries (เก็บนานกว่าผลตรวจละเอียด) ----------
export const dailySummaries = pgTable(
  "daily_summaries",
  {
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(), // วันตาม APP_TIMEZONE
    totalChecks: integer("total_checks").notNull().default(0),
    upChecks: integer("up_checks").notNull().default(0),
    downChecks: integer("down_checks").notNull().default(0),
    unknownChecks: integer("unknown_checks").notNull().default(0),
    avgResponseMs: real("avg_response_ms"),
    p95ResponseMs: real("p95_response_ms"),
    downtimeSeconds: integer("downtime_seconds").notNull().default(0),
    incidentCount: integer("incident_count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: "daily_summaries_pk", columns: [t.websiteId, t.day] })],
);

// ---------- Integration sync logs ----------
export const integrationSyncLogs = pgTable(
  "integration_sync_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    integration: varchar("integration", { length: 50 }).notNull(), // 'google_sheets'
    entityType: varchar("entity_type", { length: 50 }).notNull(), // 'incidents' | 'daily_uptime' | 'checks'
    status: syncStatus("status").notNull(),
    cursor: text("cursor"), // watermark ของรอบที่สำเร็จ
    rowsSynced: integer("rows_synced").notNull().default(0),
    message: text("message"),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
  },
  (t) => [index("integration_sync_logs_lookup_idx").on(t.integration, t.entityType, t.startedAt.desc())],
);

// ---------- Job requests (งานที่หน้าเว็บสั่งให้ worker ทำ) ----------
export const jobRequests = pgTable(
  "job_requests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    type: varchar("type", { length: 64 }).notNull(), // SHEETS_SYNC | SHEETS_EXPORT_CHECKS
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: jobStatus("status").notNull().default("PENDING"),
    result: text("result"),
    requestedBy: integer("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
  },
  (t) => [
    index("job_requests_pending_idx")
      .on(t.createdAt)
      .where(sql`status = 'PENDING'`),
  ],
);

// ---------- Canary ----------
export const canaryResults = pgTable(
  "canary_results",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz("at").notNull().defaultNow(),
    target: text("target").notNull(),
    ok: boolean("ok").notNull(),
    responseTimeMs: integer("response_time_ms"),
    error: text("error"),
  },
  (t) => [index("canary_results_at_idx").on(t.at.desc())],
);

// ---------- Worker ----------
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 100 }).primaryKey(),
  hostname: varchar("hostname", { length: 255 }).notNull(),
  pid: integer("pid").notNull(),
  version: varchar("version", { length: 50 }),
  startedAt: tstz("started_at").notNull(),
  lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
  lastCycleAt: tstz("last_cycle_at"),
  lastCycleChecks: integer("last_cycle_checks"),
  lastCycleMs: integer("last_cycle_ms"),
});

/** ช่องละ 5 นาที — ช่องที่ไม่มีแถว = ไม่มี heartbeat ในช่วงนั้น */
export const heartbeatSlots = pgTable("heartbeat_slots", {
  slot: tstz("slot").primaryKey(),
  beats: integer("beats").notNull().default(1),
});

// ---------- Favicon ของแต่ละเว็บ (worker ดึงผ่าน SSRF guard แล้วเก็บไว้ที่นี่) ----------
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const websiteIcons = pgTable("website_icons", {
  websiteId: integer("website_id")
    .primaryKey()
    .references(() => websites.id, { onDelete: "cascade" }),
  /** URL ของเว็บตอนที่ดึง — ถ้าเว็บเปลี่ยน URL จะดึงใหม่ */
  siteUrl: text("site_url").notNull(),
  ok: boolean("ok").notNull(),
  content: bytea("content"),
  contentType: varchar("content_type", { length: 50 }),
  sourceUrl: text("source_url"),
  fetchedAt: tstz("fetched_at").notNull().defaultNow(),
});

// ---------- ความปลอดภัยของเว็บ ----------
export interface SecurityFinding {
  id: string;
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  fix: string;
}

/** ผลสแกนความปลอดภัยแบบ passive (header, TLS, ไฟล์หลุด ฯลฯ) — เก็บเป็นประวัติ */
export const securityScans = pgTable(
  "security_scans",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    scannedAt: tstz("scanned_at").notNull().defaultNow(),
    score: smallint("score"),
    grade: varchar("grade", { length: 2 }),
    findings: jsonb("findings").$type<SecurityFinding[]>().notNull().default([]),
    tlsValidTo: tstz("tls_valid_to"),
    error: text("error"),
  },
  (t) => [
    index("security_scans_website_idx").on(t.websiteId, t.scannedAt.desc()),
    // retention ลบตามเวลาอย่างเดียว (ทุกเว็บ)
    index("security_scans_scanned_idx").on(t.scannedAt),
  ],
);

/** ภาพหน้าเว็บ: baseline (ต้นแบบที่ยอมรับแล้ว) / latest (ล่าสุด) / diff (ภาพไฮไลต์ส่วนที่เปลี่ยน) */
export const visualSnapshots = pgTable(
  "visual_snapshots",
  {
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 10 }).notNull(),
    image: bytea("image"),
    capturedAt: tstz("captured_at").notNull().defaultNow(),
    /** สัดส่วนพิกเซลที่ต่างจาก baseline (0–1) */
    diffRatio: real("diff_ratio"),
    /** คำต้องห้ามที่พบในหน้าเว็บ */
    keywords: jsonb("keywords").$type<string[]>(),
    pageTitle: text("page_title"),
    error: text("error"),
  },
  (t) => [primaryKey({ name: "visual_snapshots_pk", columns: [t.websiteId, t.kind] })],
);

/** การแจ้งเตือนด้านความปลอดภัย (หน้าเว็บเปลี่ยน, พบคำต้องห้าม, โดเมนเลียนแบบ) */
export const securityAlerts = pgTable(
  "security_alerts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id").references(() => websites.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 40 }).notNull(), // VISUAL_CHANGE | DEFACE_KEYWORD | LOOKALIKE_DOMAIN
    severity: varchar("severity", { length: 10 }).notNull(), // high | medium | low
    title: text("title").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    acknowledgedAt: tstz("acknowledged_at"),
    acknowledgedBy: integer("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    notifiedAt: tstz("notified_at"),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    notifyError: text("notify_error"),
  },
  (t) => [
    index("security_alerts_created_idx").on(t.createdAt.desc()),
    index("security_alerts_notify_idx")
      .on(t.createdAt)
      .where(sql`notified_at IS NULL`),
  ],
);

/** โดเมนที่พบใน Certificate Transparency ซึ่งคล้ายชื่อแบรนด์ */
export const lookalikeDomains = pgTable(
  "lookalike_domains",
  {
    domain: varchar("domain", { length: 253 }).primaryKey(),
    matchedKeyword: varchar("matched_keyword", { length: 100 }).notNull(),
    similarity: varchar("similarity", { length: 20 }).notNull(), // contains | typo
    certId: bigint("cert_id", { mode: "number" }),
    issuer: text("issuer"),
    notBefore: tstz("not_before"),
    firstSeenAt: tstz("first_seen_at").notNull().defaultNow(),
    status: varchar("status", { length: 12 }).notNull().default("NEW"), // NEW | IGNORED | REPORTED
    updatedAt: updatedAt(),
  },
  (t) => [index("lookalike_domains_seen_idx").on(t.firstSeenAt.desc())],
);

/** รายงานสรุปเหตุ (postmortem) ที่ AI ร่างให้ — 1 ฉบับต่อ incident */
export interface PostmortemContent {
  title: string;
  summary: string;
  impact: string;
  timeline: Array<{ time: string; event: string }>;
  rootCause: string;
  rootCauseConfidence: "low" | "medium" | "high";
  contributingFactors: string[];
  whatWentWell: string[];
  actionItems: Array<{ action: string; priority: "high" | "medium" | "low" }>;
}

export const postmortems = pgTable(
  "postmortems",
  {
    incidentId: integer("incident_id")
      .primaryKey()
      .references(() => incidents.id, { onDelete: "cascade" }),
    status: aiAnalysisStatus("status").notNull().default("PENDING"),
    content: jsonb("content").$type<PostmortemContent>(),
    provider: varchar("provider", { length: 50 }),
    model: varchar("model", { length: 100 }),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    requestedAt: tstz("requested_at").notNull().defaultNow(),
    completedAt: tstz("completed_at"),
  },
  (t) => [
    index("postmortems_pending_idx")
      .on(t.requestedAt)
      .where(sql`status = 'PENDING'`),
  ],
);

// ---------- Insights: วินิจฉัย / ลายนิ้วมือ / การเปลี่ยนแปลง / แผนผัง / ทดสอบหลัง login ----------

/** ผลวินิจฉัยว่าพังที่ชั้นไหน (DNS → TCP → TLS → HTTP → CDN/ต้นทาง) */
export const diagnoses = pgTable(
  "diagnoses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    incidentId: integer("incident_id").references(() => incidents.id, { onDelete: "cascade" }),
    trigger: varchar("trigger", { length: 10 }).notNull(), // auto | manual
    createdAt: createdAt(),
    durationMs: integer("duration_ms"),
    verdict: jsonb("verdict").$type<Record<string, unknown>>().notNull(),
    steps: jsonb("steps").$type<Array<Record<string, unknown>>>().notNull(),
  },
  (t) => [
    index("diagnoses_website_idx").on(t.websiteId, t.createdAt.desc()),
    index("diagnoses_created_idx").on(t.createdAt),
    index("diagnoses_incident_idx").on(t.incidentId),
  ],
);

/** ลายนิ้วมือล่าสุดของเว็บ (IP, DNS, ใบรับรอง, header ฯลฯ) ใช้เทียบหาการเปลี่ยนแปลง */
export const siteFingerprints = pgTable("site_fingerprints", {
  websiteId: integer("website_id")
    .primaryKey()
    .references(() => websites.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  takenAt: tstz("taken_at").notNull().defaultNow(),
});

/** ไทม์ไลน์การเปลี่ยนแปลงของเว็บ */
export const siteChanges = pgTable(
  "site_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    at: tstz("at").notNull().defaultNow(),
    field: varchar("field", { length: 40 }).notNull(),
    label: text("label").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    severity: varchar("severity", { length: 10 }).notNull(), // high | medium | low | info
  },
  (t) => [
    index("site_changes_website_idx").on(t.websiteId, t.at.desc()),
    index("site_changes_at_idx").on(t.at),
  ],
);

/** แผนผังความเชื่อมโยง: website_id พึ่งพา depends_on_id */
export const websiteDependencies = pgTable(
  "website_dependencies",
  {
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    dependsOnId: integer("depends_on_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "website_dependencies_pk", columns: [t.websiteId, t.dependsOnId] }),
    check("website_dependencies_not_self", sql`website_id <> depends_on_id`),
  ],
);

export interface JourneyStep {
  action: "goto" | "fill" | "click" | "waitFor" | "expectText" | "expectNoText";
  selector?: string;
  value?: string;
}

/** การทดสอบใช้งานจริงด้วย browser (เช่น login → เห็น dashboard) — 1 ชุดต่อเว็บ */
export const journeys = pgTable("journeys", {
  websiteId: integer("website_id")
    .primaryKey()
    .references(() => websites.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: integer("interval_minutes").notNull().default(15),
  steps: jsonb("steps").$type<JourneyStep[]>().notNull(),
  updatedAt: updatedAt(),
});

export const journeyRuns = pgTable(
  "journey_runs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    websiteId: integer("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    startedAt: tstz("started_at").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    durationMs: integer("duration_ms").notNull(),
    failedStep: integer("failed_step"),
    error: text("error"),
    stepMs: jsonb("step_ms").$type<number[]>(),
    screenshot: bytea("screenshot"),
  },
  (t) => [
    index("journey_runs_website_idx").on(t.websiteId, t.startedAt.desc()),
    index("journey_runs_started_idx").on(t.startedAt),
  ],
);

// ---------- Backup (สคริปต์ backup บน host บันทึกผลลงตารางนี้) ----------
export const backupRuns = pgTable("backup_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  startedAt: tstz("started_at").notNull().defaultNow(),
  finishedAt: tstz("finished_at"),
  ok: boolean("ok").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  destination: text("destination"),
  message: text("message"),
});

// ---------- Types ----------
export type Website = typeof websites.$inferSelect;
export type NewWebsite = typeof websites.$inferInsert;
export type WebsiteState = typeof websiteState.$inferSelect;
export type CheckResult = typeof checkResults.$inferSelect;
export type NewCheckResult = typeof checkResults.$inferInsert;
export type Incident = typeof incidents.$inferSelect;
export type NotificationEvent = typeof notificationEvents.$inferSelect;
export type AiAnalysis = typeof aiAnalyses.$inferSelect;
export type User = typeof users.$inferSelect;
export type EventRow = typeof events.$inferSelect;
