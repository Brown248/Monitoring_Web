import "server-only";
import { sql } from "@app/db";
import { getDb } from "../db";

export interface IncidentFilter {
  status: "all" | "open" | "closed";
  websiteId?: number;
  from?: string; // YYYY-MM-DD
  to?: string;
  page: number;
  pageSize: number;
}

export interface EmailSummary {
  type: "DOWN" | "RECOVERY";
  sent: number;
  total: number;
  failed: number;
  dead: number;
}

export async function incidentStats() {
  const res = await getDb().execute<{
    open: string;
    last7: string;
    avg_min: string | null;
    top_name: string | null;
    top_count: string | null;
  }>(sql`
    SELECT (SELECT count(*) FROM incidents WHERE recovered_at IS NULL)::text AS open,
           (SELECT count(*) FROM incidents WHERE started_at >= now() - interval '7 days')::text AS last7,
           (SELECT avg(extract(epoch FROM (recovered_at - started_at)) / 60) FROM incidents
              WHERE recovered_at IS NOT NULL AND recovered_at >= now() - interval '30 days')::text AS avg_min,
           t.name AS top_name, t.n::text AS top_count
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT w.name, count(*) AS n FROM incidents i JOIN websites w ON w.id = i.website_id
      WHERE i.started_at >= now() - interval '30 days' GROUP BY w.id, w.name ORDER BY n DESC, w.name, w.id LIMIT 1
    ) t ON true
  `);
  const r = res.rows[0]!;
  return {
    open: Number(r.open),
    last7: Number(r.last7),
    avgRecoveryMin: r.avg_min ? Math.round(Number(r.avg_min)) : null,
    top: r.top_name ? { name: r.top_name, count: Number(r.top_count) } : null,
  };
}

export async function listIncidents(f: IncidentFilter, tz: string) {
  const where = [sql`true`];
  if (f.status === "open") where.push(sql`i.recovered_at IS NULL`);
  if (f.status === "closed") where.push(sql`i.recovered_at IS NOT NULL`);
  if (f.websiteId) where.push(sql`i.website_id = ${f.websiteId}`);
  if (f.from) where.push(sql`i.started_at >= (${f.from}::date::timestamp AT TIME ZONE ${tz})`);
  if (f.to) where.push(sql`i.started_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE ${tz})`);
  const w = sql.join(where, sql` AND `);
  const db = getDb();
  const total = Number(
    (await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM incidents i WHERE ${w}`)).rows[0]
      ?.n ?? 0,
  );
  const rows = await db.execute<{
    id: number;
    website_id: number;
    name: string;
    started_at: Date;
    recovered_at: Date | null;
    cause: string;
    ai_status: string | null;
    ai_error: string | null;
    emails: Array<{ type: "DOWN" | "RECOVERY"; status: string }> | null;
  }>(sql`
    SELECT i.id, i.website_id, w.name, i.started_at, i.recovered_at, i.cause,
           a.status AS ai_status, a.error AS ai_error,
           (SELECT json_agg(json_build_object('type', n.event_type, 'status', n.status)) FROM notification_events n WHERE n.incident_id = i.id) AS emails
    FROM incidents i
    JOIN websites w ON w.id = i.website_id
    LEFT JOIN ai_analyses a ON a.incident_id = i.id
    WHERE ${w}
    ORDER BY i.started_at DESC
    LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}
  `);
  return {
    total,
    items: rows.rows.map((r) => ({
      id: Number(r.id),
      websiteId: Number(r.website_id),
      websiteName: r.name,
      startedAt: new Date(r.started_at),
      recoveredAt: r.recovered_at ? new Date(r.recovered_at) : null,
      cause: r.cause,
      aiStatus: r.ai_status,
      aiError: r.ai_error,
      emails: summarizeEmails(r.emails ?? []),
    })),
  };
}

export function summarizeEmails(list: Array<{ type: "DOWN" | "RECOVERY"; status: string }>): EmailSummary[] {
  const out: EmailSummary[] = [];
  for (const type of ["DOWN", "RECOVERY"] as const) {
    const items = list.filter((e) => e.type === type);
    if (items.length === 0) continue;
    out.push({
      type,
      total: items.length,
      sent: items.filter((e) => e.status === "SENT").length,
      failed: items.filter((e) => e.status === "FAILED" || e.status === "PENDING").length,
      dead: items.filter((e) => e.status === "DEAD").length,
    });
  }
  return out;
}

export async function incidentDetail(id: number) {
  const db = getDb();
  const res = await db.execute<{
    id: number;
    website_id: number;
    name: string;
    url: string;
    send_recovery: boolean;
    alert_emails: string[];
    started_at: Date;
    confirmed_at: Date;
    recovered_at: Date | null;
    cause: string;
    error_code: string | null;
    failed_check_count: number;
    confirm_check_id: number | null;
    root_cause_website_id: number | null;
    root_name: string | null;
    recovery_check_id: number | null;
    site_active: boolean;
    site_archived: boolean;
  }>(sql`
    SELECT i.id, i.website_id, w.name, w.url, w.send_recovery, w.alert_emails, i.started_at, i.confirmed_at,
           i.recovered_at, i.cause, i.error_code, i.failed_check_count, i.confirm_check_id,
           i.root_cause_website_id, rw.name AS root_name, i.recovery_check_id,
           (w.enabled AND w.archived_at IS NULL) AS site_active, (w.archived_at IS NOT NULL) AS site_archived
    FROM incidents i JOIN websites w ON w.id = i.website_id
    LEFT JOIN websites rw ON rw.id = i.root_cause_website_id
    WHERE i.id = ${id}
  `);
  const inc = res.rows[0];
  if (!inc) return null;

  const [ai, notifications, timeline, evidence, lastCheck] = await Promise.all([
    db.execute<{
      status: string;
      provider: string | null;
      model: string | null;
      summary: string | null;
      facts: string[] | null;
      possible_causes: string[] | null;
      next_steps: string[] | null;
      error: string | null;
      completed_at: Date | null;
      input_check_count: number | null;
    }>(
      sql`SELECT status, provider, model, summary, facts, possible_causes, next_steps, error, completed_at, input_check_count FROM ai_analyses WHERE incident_id = ${id}`,
    ),
    db.execute<{
      id: number;
      event_type: "DOWN" | "RECOVERY";
      recipient: string;
      status: string;
      attempts: number;
      sent_at: Date | null;
      created_at: Date;
      last_error: string | null;
      next_attempt_at: Date;
    }>(
      sql`SELECT id, event_type, recipient, status, attempts, sent_at, created_at, last_error, next_attempt_at FROM notification_events WHERE incident_id = ${id} ORDER BY event_type, recipient`,
    ),
    db.execute<{ at: Date; level: string; type: string; message: string; detail: string | null }>(sql`
      SELECT at, level, type, message, detail FROM events WHERE incident_id = ${id} ORDER BY at DESC, id DESC LIMIT 100
    `),
    inc.confirm_check_id
      ? db.execute<{
          id: number;
          checked_at: Date;
          finished_at: Date | null;
          remote_ip: string | null;
          dns_ms: number | null;
          connect_ms: number | null;
          tls_ms: number | null;
          response_time_ms: number | null;
          retries: number;
          error_code: string | null;
          error_message: string | null;
          http_status: number | null;
        }>(
          sql`SELECT id, checked_at, finished_at, remote_ip, dns_ms, connect_ms, tls_ms, response_time_ms, retries, error_code, error_message, http_status FROM check_results WHERE id = ${inc.confirm_check_id}`,
        )
      : Promise.resolve({ rows: [] }),
    db.execute<{ checked_at: Date; status: string }>(sql`
      SELECT checked_at, status FROM check_results WHERE website_id = ${inc.website_id} ORDER BY checked_at DESC LIMIT 1
    `),
  ]);

  const a = ai.rows[0];
  const ev = evidence.rows[0];
  return {
    id: Number(inc.id),
    websiteId: Number(inc.website_id),
    websiteName: inc.name,
    url: inc.url,
    sendRecovery: inc.send_recovery,
    alertEmails: inc.alert_emails,
    startedAt: new Date(inc.started_at),
    confirmedAt: new Date(inc.confirmed_at),
    recoveredAt: inc.recovered_at ? new Date(inc.recovered_at) : null,
    cause: inc.cause,
    errorCode: inc.error_code,
    failedCheckCount: inc.failed_check_count,
    /** ปิดเพราะหยุดตรวจ/archive (ไม่มีผลตรวจที่ยืนยันว่ากลับมา) */
    closedByStop: inc.recovered_at !== null && inc.recovery_check_id === null,
    siteActive: Boolean(inc.site_active),
    siteArchived: Boolean(inc.site_archived),
    rootCause:
      inc.root_cause_website_id === null
        ? null
        : {
            websiteId: Number(inc.root_cause_website_id),
            name: inc.root_name ?? `#${inc.root_cause_website_id}`,
          },
    lastCheck: lastCheck.rows[0]
      ? { at: new Date(lastCheck.rows[0].checked_at), status: lastCheck.rows[0].status }
      : null,
    ai: a
      ? {
          status: a.status,
          provider: a.provider,
          model: a.model,
          summary: a.summary,
          facts: a.facts ?? [],
          possibleCauses: a.possible_causes ?? [],
          nextSteps: a.next_steps ?? [],
          error: a.error,
          completedAt: a.completed_at ? new Date(a.completed_at) : null,
          inputCheckCount: a.input_check_count,
        }
      : null,
    notifications: notifications.rows.map((n) => ({
      id: Number(n.id),
      type: n.event_type,
      recipient: n.recipient,
      status: n.status,
      attempts: n.attempts,
      sentAt: n.sent_at ? new Date(n.sent_at) : null,
      createdAt: new Date(n.created_at),
      lastError: n.last_error,
      nextAttemptAt: new Date(n.next_attempt_at),
    })),
    timeline: timeline.rows.map((t) => ({
      at: new Date(t.at),
      level: t.level,
      type: t.type,
      message: t.message,
      detail: t.detail,
    })),
    evidence: ev
      ? {
          id: Number(ev.id),
          checkedAt: new Date(ev.checked_at),
          finishedAt: ev.finished_at ? new Date(ev.finished_at) : null,
          remoteIp: ev.remote_ip,
          dnsMs: ev.dns_ms,
          connectMs: ev.connect_ms,
          tlsMs: ev.tls_ms,
          responseTimeMs: ev.response_time_ms,
          retries: ev.retries,
          errorCode: ev.error_code,
          errorMessage: ev.error_message,
          httpStatus: ev.http_status,
        }
      : null,
  };
}

export async function openIncidents() {
  const res = await getDb().execute<{
    id: number;
    website_id: number;
    name: string;
    url: string;
    started_at: Date;
    cause: string;
    retries: number | null;
  }>(sql`
    SELECT i.id, i.website_id, w.name, w.url, i.started_at, i.cause,
           (SELECT c.retries FROM check_results c WHERE c.website_id = i.website_id ORDER BY c.checked_at DESC LIMIT 1) AS retries
    FROM incidents i JOIN websites w ON w.id = i.website_id
    WHERE i.recovered_at IS NULL ORDER BY i.started_at
  `);
  return res.rows.map((r) => ({
    id: Number(r.id),
    websiteId: Number(r.website_id),
    name: r.name,
    url: r.url,
    startedAt: new Date(r.started_at),
    cause: r.cause,
    retries: r.retries === null ? null : Number(r.retries),
  }));
}
