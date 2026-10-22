import "server-only";
import type { DiagnosisVerdict, Edge } from "@app/core";
import { getState, sql, type JourneyStep } from "@app/db";
import { getDb } from "../db";
import type { DisplayStatus } from "./websites";

export interface DiagnosisStepRow {
  key: string;
  label: string;
  status: "ok" | "fail" | "warn" | "skip";
  detail: string;
  ms: number | null;
}

export interface DiagnosisRow {
  id: number;
  websiteId: number;
  incidentId: number | null;
  trigger: "auto" | "manual";
  createdAt: Date;
  durationMs: number | null;
  verdict: DiagnosisVerdict;
  steps: DiagnosisStepRow[];
}

type DiagnosisRaw = {
  id: number;
  website_id: number;
  incident_id: number | null;
  trigger: "auto" | "manual";
  created_at: Date;
  duration_ms: number | null;
  verdict: DiagnosisVerdict;
  steps: DiagnosisStepRow[];
};

const mapDiagnosis = (r: DiagnosisRaw): DiagnosisRow => ({
  id: Number(r.id),
  websiteId: Number(r.website_id),
  incidentId: r.incident_id === null ? null : Number(r.incident_id),
  trigger: r.trigger,
  createdAt: new Date(r.created_at),
  durationMs: r.duration_ms,
  verdict: { ...r.verdict, actions: r.verdict.actions ?? [], healthy: r.verdict.healthy ?? [] },
  steps: r.steps ?? [],
});

export async function latestDiagnosis(websiteId: number): Promise<DiagnosisRow | null> {
  const r = await getDb().execute<DiagnosisRaw>(sql`
    SELECT id, website_id, incident_id, trigger, created_at, duration_ms, verdict, steps
    FROM diagnoses WHERE website_id = ${websiteId} ORDER BY created_at DESC LIMIT 1
  `);
  return r.rows[0] ? mapDiagnosis(r.rows[0]) : null;
}

/** ผลวินิจฉัยของ incident (อันแรก = ตอนเกิดเหตุ ข้อมูลตรงที่สุด) */
export async function incidentDiagnoses(incidentId: number): Promise<DiagnosisRow[]> {
  const r = await getDb().execute<DiagnosisRaw>(sql`
    SELECT id, website_id, incident_id, trigger, created_at, duration_ms, verdict, steps
    FROM diagnoses WHERE incident_id = ${incidentId} ORDER BY created_at LIMIT 5
  `);
  return r.rows.map(mapDiagnosis);
}

export interface SiteChangeRow {
  id: number;
  at: Date;
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
  severity: "high" | "medium" | "low" | "info";
}

type ChangeRaw = {
  id: number;
  at: Date;
  field: string;
  label: string;
  old_value: string | null;
  new_value: string | null;
  severity: SiteChangeRow["severity"];
};
const mapChange = (r: ChangeRaw): SiteChangeRow => ({
  id: Number(r.id),
  at: new Date(r.at),
  field: r.field,
  label: r.label,
  oldValue: r.old_value,
  newValue: r.new_value,
  severity: r.severity,
});

export async function siteChangeList(websiteId: number, limit = 30): Promise<SiteChangeRow[]> {
  const r = await getDb().execute<ChangeRaw>(sql`
    SELECT id, at, field, label, old_value, new_value, severity
    FROM site_changes WHERE website_id = ${websiteId} ORDER BY at DESC LIMIT ${limit}
  `);
  return r.rows.map(mapChange);
}

/** สิ่งที่เปลี่ยนในช่วงก่อนเว็บล่ม (ตัวช่วยตอบ "ล่มเพราะใครไปแก้อะไร") */
export async function changesBefore(websiteId: number, at: Date, hours = 72): Promise<SiteChangeRow[]> {
  const r = await getDb().execute<ChangeRaw>(sql`
    SELECT id, at, field, label, old_value, new_value, severity
    FROM site_changes
    WHERE website_id = ${websiteId} AND at <= ${new Date(at.getTime() + 10 * 60_000)}
      AND at > ${new Date(at.getTime() - hours * 3_600_000)}
    ORDER BY at DESC LIMIT 20
  `);
  return r.rows.map(mapChange);
}

export async function fingerprintTakenAt(websiteId: number): Promise<Date | null> {
  const r = await getDb().execute<{ taken_at: Date }>(
    sql`SELECT taken_at FROM site_fingerprints WHERE website_id = ${websiteId}`,
  );
  return r.rows[0] ? new Date(r.rows[0].taken_at) : null;
}

export interface JourneyRunRow {
  id: number;
  startedAt: Date;
  ok: boolean;
  durationMs: number;
  failedStep: number | null;
  error: string | null;
  stepMs: number[];
  hasScreenshot: boolean;
}

export interface JourneyInfo {
  enabled: boolean;
  intervalMinutes: number;
  steps: JourneyStep[];
  updatedAt: Date;
  runs: JourneyRunRow[];
}

export async function journeyInfo(websiteId: number): Promise<JourneyInfo | null> {
  const db = getDb();
  const [cfg] = (
    await db.execute<{ enabled: boolean; interval_minutes: number; steps: JourneyStep[]; updated_at: Date }>(
      sql`SELECT enabled, interval_minutes, steps, updated_at FROM journeys WHERE website_id = ${websiteId}`,
    )
  ).rows;
  if (!cfg) return null;
  const runs = await db.execute<{
    id: number;
    started_at: Date;
    ok: boolean;
    duration_ms: number;
    failed_step: number | null;
    error: string | null;
    step_ms: number[] | null;
    has_shot: boolean;
  }>(sql`
    SELECT id, started_at, ok, duration_ms, failed_step, error, step_ms, screenshot IS NOT NULL AS has_shot
    FROM journey_runs WHERE website_id = ${websiteId} ORDER BY started_at DESC LIMIT 20
  `);
  return {
    enabled: cfg.enabled,
    intervalMinutes: cfg.interval_minutes,
    steps: cfg.steps,
    updatedAt: new Date(cfg.updated_at),
    runs: runs.rows.map((r) => ({
      id: Number(r.id),
      startedAt: new Date(r.started_at),
      ok: r.ok,
      durationMs: r.duration_ms,
      failedStep: r.failed_step,
      error: r.error,
      stepMs: r.step_ms ?? [],
      hasScreenshot: r.has_shot,
    })),
  };
}

export interface MapNode {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  status: DisplayStatus;
  failing: boolean;
  /** incident ที่เปิดอยู่ล่มเพราะเว็บไหน (ถ้ามี) */
  rootCauseId: number | null;
}

export interface DependencyGraph {
  nodes: MapNode[];
  edges: Edge[];
}

export async function dependencyGraph(): Promise<DependencyGraph> {
  const db = getDb();
  const [nodes, edges] = await Promise.all([
    db.execute<{
      id: number;
      name: string;
      url: string;
      enabled: boolean;
      status: DisplayStatus;
      failing: boolean;
      root_cause: number | null;
    }>(sql`
      SELECT w.id, w.name, w.url, w.enabled,
        (CASE WHEN s.last_checked_at IS NULL THEN 'PENDING' ELSE s.status::text END) AS status,
        (s.status = 'UP' AND s.consecutive_failures > 0) AS failing,
        (SELECT i.root_cause_website_id FROM incidents i WHERE i.website_id = w.id AND i.recovered_at IS NULL LIMIT 1) AS root_cause
      FROM websites w JOIN website_state s ON s.website_id = w.id
      WHERE w.archived_at IS NULL ORDER BY w.name
    `),
    db.execute<{ website_id: number; depends_on_id: number }>(sql`
      SELECT d.website_id, d.depends_on_id FROM website_dependencies d
      JOIN websites a ON a.id = d.website_id AND a.archived_at IS NULL
      JOIN websites b ON b.id = d.depends_on_id AND b.archived_at IS NULL
    `),
  ]);
  return {
    nodes: nodes.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      url: r.url,
      enabled: r.enabled,
      status: r.status,
      failing: Boolean(r.failing),
      rootCauseId: r.root_cause === null ? null : Number(r.root_cause),
    })),
    edges: edges.rows.map((r) => [Number(r.website_id), Number(r.depends_on_id)] as const),
  };
}

export interface AnomalySiteState {
  learning: boolean;
  samples: number;
  median: number | null;
  active: string[];
}

export async function anomalyState(): Promise<{
  checkedAt: string;
  sites: Record<string, AnomalySiteState>;
} | null> {
  return getState(getDb(), "anomaly");
}

/** แจ้งเตือนเชิงการทำงาน (เตือนล่วงหน้า / ทดสอบใช้งานจริงไม่ผ่าน) ที่ยังเปิดอยู่ */
export const OPERATIONAL_TYPES = ["ANOMALY_SLOW", "ANOMALY_UNSTABLE", "JOURNEY_FAILED"] as const;

export interface OperationalAlert {
  id: number;
  websiteId: number | null;
  websiteName: string | null;
  type: string;
  title: string;
  detail: string | null;
  createdAt: Date;
}

export async function openOperationalAlerts(websiteId?: number): Promise<OperationalAlert[]> {
  const r = await getDb().execute<{
    id: number;
    website_id: number | null;
    name: string | null;
    type: string;
    title: string;
    detail: Record<string, unknown> | null;
    created_at: Date;
  }>(sql`
    SELECT a.id, a.website_id, w.name, a.type, a.title, a.detail, a.created_at
    FROM security_alerts a LEFT JOIN websites w ON w.id = a.website_id
    WHERE a.acknowledged_at IS NULL
      AND a.type IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE', 'JOURNEY_FAILED')
      ${websiteId ? sql`AND a.website_id = ${websiteId}` : sql``}
    ORDER BY a.created_at DESC LIMIT 20
  `);
  return r.rows.map((a) => ({
    id: Number(a.id),
    websiteId: a.website_id === null ? null : Number(a.website_id),
    websiteName: a.name,
    type: a.type,
    title: a.title,
    detail: typeof a.detail?.detail === "string" ? a.detail.detail : null,
    createdAt: new Date(a.created_at),
  }));
}
