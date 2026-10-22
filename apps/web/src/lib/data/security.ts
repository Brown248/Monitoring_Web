import "server-only";
import { correlateOutages, type OutageGroup } from "@app/core";
import { getState, sql, type PostmortemContent, type SecurityFinding } from "@app/db";
import { loadOutages } from "@app/db/queries";
import { getDb } from "../db";
import { canaryHealth } from "./system";

export interface SiteSecurityRow {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  grade: string | null;
  score: number | null;
  scannedAt: Date | null;
  scanError: string | null;
  high: number;
  medium: number;
  low: number;
  tlsValidTo: Date | null;
  visualAt: Date | null;
  visualDiffPct: number | null;
  visualError: string | null;
  visualKeywords: string[];
  hasBaseline: boolean;
  openAlerts: number;
}

/** ภาพรวมความปลอดภัยรายเว็บ: เกรดล่าสุด + สถานะภาพหน้าเว็บ + alert ที่ยังไม่รับทราบ */
export async function securityOverview(): Promise<SiteSecurityRow[]> {
  const res = await getDb().execute<{
    id: number;
    name: string;
    url: string;
    enabled: boolean;
    grade: string | null;
    score: number | null;
    scanned_at: Date | null;
    scan_error: string | null;
    findings: SecurityFinding[] | null;
    tls_valid_to: Date | null;
    visual_at: Date | null;
    diff_ratio: number | null;
    visual_error: string | null;
    keywords: string[] | null;
    has_baseline: boolean;
    open_alerts: string;
  }>(sql`
    SELECT w.id, w.name, w.url, w.enabled,
           s.grade, s.score, s.scanned_at, s.error AS scan_error, s.findings, s.tls_valid_to,
           v.captured_at AS visual_at, v.diff_ratio, v.error AS visual_error, v.keywords,
           EXISTS (SELECT 1 FROM visual_snapshots b WHERE b.website_id = w.id AND b.kind = 'baseline' AND b.image IS NOT NULL) AS has_baseline,
           (SELECT count(*) FROM security_alerts a WHERE a.website_id = w.id AND a.acknowledged_at IS NULL)::text AS open_alerts
    FROM websites w
    LEFT JOIN LATERAL (
      SELECT grade, score, scanned_at, error, findings, tls_valid_to FROM security_scans
      WHERE website_id = w.id ORDER BY scanned_at DESC LIMIT 1
    ) s ON true
    LEFT JOIN visual_snapshots v ON v.website_id = w.id AND v.kind = 'latest'
    WHERE w.archived_at IS NULL
    ORDER BY (CASE s.grade WHEN 'F' THEN 0 WHEN 'D' THEN 1 WHEN 'C' THEN 2 WHEN 'B' THEN 3 WHEN 'A' THEN 4 ELSE 5 END), w.name
  `);
  return res.rows.map((r) => {
    const f = r.findings ?? [];
    return {
      id: Number(r.id),
      name: r.name,
      url: r.url,
      enabled: r.enabled,
      grade: r.grade,
      score: r.score === null ? null : Number(r.score),
      scannedAt: r.scanned_at ? new Date(r.scanned_at) : null,
      scanError: r.scan_error,
      high: f.filter((x) => x.severity === "high").length,
      medium: f.filter((x) => x.severity === "medium").length,
      low: f.filter((x) => x.severity === "low").length,
      tlsValidTo: r.tls_valid_to ? new Date(r.tls_valid_to) : null,
      visualAt: r.visual_at ? new Date(r.visual_at) : null,
      visualDiffPct: r.diff_ratio === null ? null : Math.round(Number(r.diff_ratio) * 1000) / 10,
      visualError: r.visual_error,
      visualKeywords: r.keywords ?? [],
      hasBaseline: r.has_baseline,
      openAlerts: Number(r.open_alerts),
    };
  });
}

export interface SecurityAlertRow {
  id: number;
  websiteId: number | null;
  websiteName: string | null;
  type: string;
  severity: string;
  title: string;
  detail: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  notifiedAt: Date | null;
  notifyError: string | null;
}

export async function securityAlertsList(opts: { open?: boolean; websiteId?: number; limit?: number } = {}) {
  // แจ้งเตือนเชิงการทำงาน (เตือนล่วงหน้า/ทดสอบใช้งานจริง) แสดงที่หน้าภาพรวมและหน้าเว็บไซต์แทน
  const where = [sql`a.type NOT IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE', 'JOURNEY_FAILED')`];
  if (opts.open) where.push(sql`a.acknowledged_at IS NULL`);
  if (opts.websiteId) where.push(sql`a.website_id = ${opts.websiteId}`);
  const res = await getDb().execute<{
    id: number;
    website_id: number | null;
    name: string | null;
    type: string;
    severity: string;
    title: string;
    detail: Record<string, unknown> | null;
    created_at: Date;
    acknowledged_at: Date | null;
    username: string | null;
    notified_at: Date | null;
    notify_error: string | null;
  }>(sql`
    SELECT a.id, a.website_id, w.name, a.type, a.severity, a.title, a.detail, a.created_at, a.acknowledged_at,
           u.username, a.notified_at, a.notify_error
    FROM security_alerts a
    LEFT JOIN websites w ON w.id = a.website_id
    LEFT JOIN users u ON u.id = a.acknowledged_by
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY (a.acknowledged_at IS NULL) DESC, a.created_at DESC
    LIMIT ${opts.limit ?? 50}
  `);
  return res.rows.map((r): SecurityAlertRow => ({
    id: Number(r.id),
    websiteId: r.website_id === null ? null : Number(r.website_id),
    websiteName: r.name,
    type: r.type,
    severity: r.severity,
    title: r.title,
    detail: r.detail ?? {},
    createdAt: new Date(r.created_at),
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at) : null,
    acknowledgedBy: r.username,
    notifiedAt: r.notified_at ? new Date(r.notified_at) : null,
    notifyError: r.notify_error,
  }));
}

export async function openSecurityAlertCount(): Promise<number> {
  const r = await getDb().execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM security_alerts WHERE acknowledged_at IS NULL AND type NOT IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE', 'JOURNEY_FAILED')`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export interface LookalikeRow {
  domain: string;
  matchedKeyword: string;
  similarity: string;
  issuer: string | null;
  notBefore: Date | null;
  firstSeenAt: Date;
  status: string;
}

export async function lookalikeList(limit = 100): Promise<LookalikeRow[]> {
  const res = await getDb().execute<{
    domain: string;
    matched_keyword: string;
    similarity: string;
    issuer: string | null;
    not_before: Date | null;
    first_seen_at: Date;
    status: string;
  }>(sql`
    SELECT domain, matched_keyword, similarity, issuer, not_before, first_seen_at, status FROM lookalike_domains
    ORDER BY (status = 'NEW') DESC, not_before DESC NULLS LAST LIMIT ${limit}
  `);
  return res.rows.map((r) => ({
    domain: r.domain,
    matchedKeyword: r.matched_keyword,
    similarity: r.similarity,
    issuer: r.issuer,
    notBefore: r.not_before ? new Date(r.not_before) : null,
    firstSeenAt: new Date(r.first_seen_at),
    status: r.status,
  }));
}

export interface WorkerFeatureState {
  visual: {
    available: boolean;
    browser?: string;
    /** เปิด browser ไม่ขึ้น (พบไฟล์แต่รันไม่ได้) */
    error?: string;
    checkedAt?: string;
    blocked?: string[];
  } | null;
  lookalike: { lastRunAt: string; status?: string; summary?: string; errors?: string[] } | null;
}

export async function securityFeatureStates(): Promise<WorkerFeatureState> {
  const db = getDb();
  const [visual, lookalike] = await Promise.all([
    getState<WorkerFeatureState["visual"]>(db, "visual"),
    getState<WorkerFeatureState["lookalike"]>(db, "lookalike"),
  ]);
  return { visual, lookalike };
}

/** ผลสแกนล่าสุดของเว็บเดียว (รายการปัญหาเต็ม) */
export async function siteSecurity(websiteId: number) {
  const db = getDb();
  const [scan, visual] = await Promise.all([
    db.execute<{
      grade: string | null;
      score: number | null;
      scanned_at: Date;
      findings: SecurityFinding[];
      tls_valid_to: Date | null;
      error: string | null;
    }>(sql`
      SELECT grade, score, scanned_at, findings, tls_valid_to, error FROM security_scans
      WHERE website_id = ${websiteId} ORDER BY scanned_at DESC LIMIT 1
    `),
    db.execute<{
      kind: string;
      captured_at: Date;
      diff_ratio: number | null;
      keywords: string[] | null;
      page_title: string | null;
      error: string | null;
      has_image: boolean;
    }>(sql`
      SELECT kind, captured_at, diff_ratio, keywords, page_title, error, image IS NOT NULL AS has_image
      FROM visual_snapshots WHERE website_id = ${websiteId}
    `),
  ]);
  const s = scan.rows[0];
  const byKind = new Map(visual.rows.map((v) => [v.kind, v]));
  const latest = byKind.get("latest");
  return {
    scan: s
      ? {
          grade: s.grade,
          score: s.score === null ? null : Number(s.score),
          scannedAt: new Date(s.scanned_at),
          findings: s.findings,
          tlsValidTo: s.tls_valid_to ? new Date(s.tls_valid_to) : null,
          error: s.error,
        }
      : null,
    visual: {
      hasBaseline: Boolean(byKind.get("baseline")?.has_image),
      baselineAt: byKind.get("baseline") ? new Date(byKind.get("baseline")!.captured_at) : null,
      hasLatest: Boolean(latest?.has_image),
      hasDiff: Boolean(byKind.get("diff")?.has_image),
      latestAt: latest ? new Date(latest.captured_at) : null,
      diffPct:
        latest?.diff_ratio === null || latest?.diff_ratio === undefined
          ? null
          : Math.round(Number(latest.diff_ratio) * 1000) / 10,
      keywords: latest?.keywords ?? [],
      pageTitle: latest?.page_title ?? null,
      error: latest?.error ?? null,
    },
  };
}

// ---------- ต้นเหตุร่วม ----------

/** กลุ่มของ Incident ที่เปิดอยู่ซึ่งน่าจะมีต้นเหตุเดียวกัน */
export async function openOutageGroups(): Promise<OutageGroup[]> {
  const [outages, canary] = await Promise.all([loadOutages(getDb(), { openOnly: true }), canaryHealth()]);
  if (outages.length < 2) return [];
  return correlateOutages(outages, { canaryFailing: canary.health === "error" });
}

/** กลุ่มที่ incident นี้อยู่ (ดูจาก incident ที่เริ่มในช่วง ±15 นาที) */
export async function outageGroupFor(incidentId: number, startedAt: Date): Promise<OutageGroup | null> {
  const around = await loadOutages(getDb(), {
    from: new Date(startedAt.getTime() - 15 * 60_000),
    to: new Date(startedAt.getTime() + 15 * 60_000),
  });
  return correlateOutages(around).find((g) => g.members.some((m) => m.incidentId === incidentId)) ?? null;
}

// ---------- Postmortem ----------

export async function postmortemFor(incidentId: number) {
  const r = await getDb().execute<{
    status: string;
    content: PostmortemContent | null;
    provider: string | null;
    model: string | null;
    error: string | null;
    completed_at: Date | null;
  }>(
    sql`SELECT status, content, provider, model, error, completed_at FROM postmortems WHERE incident_id = ${incidentId}`,
  );
  const p = r.rows[0];
  return p
    ? {
        status: p.status,
        content: p.content,
        provider: p.provider,
        model: p.model,
        error: p.error,
        completedAt: p.completed_at ? new Date(p.completed_at) : null,
      }
    : null;
}
