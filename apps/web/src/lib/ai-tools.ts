import "server-only";
import { correlateOutages, formatDateTime, formatPercent } from "@app/core";
import type { AskTool } from "@app/core/server";
import { sql } from "@app/db";
import { loadOutages } from "@app/db/queries";
import { z } from "zod";
import { getDb } from "./db";
import { lookalikeList, securityAlertsList, securityOverview } from "./data/security";
import { canaryHealth, loadSettings, outboxHealth, workerHealth } from "./data/system";
import { uptimeHistory } from "./data/uptime";
import { siteStatusList } from "./data/websites";

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("วันที่รูปแบบ YYYY-MM-DD ตามเวลาท้องถิ่น");

/** ช่วงวันที่ (เวลาท้องถิ่น) → ช่วงเวลา UTC */
function dayBounds(from: string | undefined, to: string | undefined, tz: string, defaultDays: number) {
  return sql`(${from ?? null}::date IS NULL OR i.started_at >= (${from ?? null}::date::timestamp AT TIME ZONE ${tz}))
    AND (${to ?? null}::date IS NULL OR i.started_at < ((${to ?? null}::date + 1)::timestamp AT TIME ZONE ${tz}))
    AND (${from ?? null}::date IS NOT NULL OR ${to ?? null}::date IS NOT NULL OR i.started_at >= now() - make_interval(days => ${defaultDays}))`;
}

/**
 * เครื่องมืออ่านข้อมูลสำหรับ AI — ทุกตัวเป็น SELECT อย่างเดียว คืนข้อมูลที่ย่อแล้ว
 * (ไม่มี SQL อิสระ, ไม่มี secret, ไม่มีอีเมลผู้รับ)
 */
export function monitoringTools(tz: string): AskTool[] {
  const fmt = (d: Date | null) => (d ? formatDateTime(d, tz) : null);
  return [
    defineTool({
      name: "list_websites",
      description:
        "รายชื่อเว็บไซต์ทั้งหมดที่เฝ้าดู พร้อม id, URL, สถานะล่าสุด (UP/DOWN/UNKNOWN/PENDING), เปิด/ปิดการตรวจ, response ล่าสุด และ uptime 24 ชม. ใช้เพื่อหา websiteId ก่อนเรียกเครื่องมืออื่น",
      input: z.object({
        status: z.enum(["all", "UP", "DOWN", "UNKNOWN", "PENDING", "disabled"]).default("all"),
      }),
      async run({ status }) {
        const sites = await siteStatusList();
        const up = await getDb().execute<{ website_id: number; up: string; down: string }>(sql`
          SELECT website_id, count(*) FILTER (WHERE status = 'UP')::text AS up, count(*) FILTER (WHERE status = 'DOWN')::text AS down
          FROM check_results WHERE checked_at >= now() - interval '24 hours' GROUP BY website_id
        `);
        const byId = new Map(up.rows.map((r) => [Number(r.website_id), r]));
        return sites
          .filter(
            (s) =>
              status === "all" || (status === "disabled" ? !s.enabled : s.enabled && s.status === status),
          )
          .map((s) => {
            const u = byId.get(s.id);
            const total = u ? Number(u.up) + Number(u.down) : 0;
            return {
              id: s.id,
              name: s.name,
              url: s.url,
              enabled: s.enabled,
              status: s.status,
              lastResponseMs: s.responseMs,
              uptime24h: total > 0 ? formatPercent(Number(u!.up) / total) : null,
            };
          });
      },
    }),
    defineTool({
      name: "get_uptime",
      description:
        "uptime ย้อนหลังรายวัน (สูงสุด 90 วัน) ของเว็บที่ระบุ หรือทุกเว็บถ้าไม่ระบุ — คืน uptime รวม, เวลาล่มรวม, จำนวน incident และเฉพาะวันที่มีปัญหา",
      input: z.object({
        websiteIds: z.array(z.number().int()).max(50).optional().describe("ไม่ระบุ = ทุกเว็บที่เปิดตรวจ"),
        days: z.number().int().min(1).max(90).default(30),
      }),
      async run({ websiteIds, days }) {
        const sites = (await siteStatusList()).filter((s) =>
          websiteIds?.length ? websiteIds.includes(s.id) : s.enabled,
        );
        const hist = await uptimeHistory(
          sites.map((s) => s.id),
          tz,
          days,
        );
        return sites.map((s) => {
          const h = hist.get(s.id);
          const badDays = (h?.days ?? []).filter(
            (d) => d.downtimeSeconds > 0 || (d.uptime !== null && d.uptime < 1),
          );
          return {
            id: s.id,
            name: s.name,
            days,
            uptime: h ? formatPercent(h.overall) : null,
            totalDowntimeMinutes: Math.round(badDays.reduce((n, d) => n + d.downtimeSeconds, 0) / 60),
            incidents: badDays.reduce((n, d) => n + d.incidents, 0),
            daysWithProblems: badDays.map((d) => ({
              day: d.day,
              uptime: formatPercent(d.uptime),
              downtimeMinutes: Math.round(d.downtimeSeconds / 60),
              incidents: d.incidents,
            })),
          };
        });
      },
    }),
    defineTool({
      name: "list_incidents",
      description:
        "รายการ Incident (เว็บล่ม) พร้อมเวลาเริ่ม/กลับมา, ระยะเวลา, สาเหตุ และสรุปจาก AI ถ้ามี — กรองตามเว็บ, ช่วงวันที่ และสถานะได้ (ค่าเริ่มต้น 30 วันล่าสุด)",
      input: z.object({
        websiteId: z.number().int().optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        status: z.enum(["all", "open", "closed"]).default("all"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      async run({ websiteId, from, to, status, limit }) {
        const res = await getDb().execute<{
          id: number;
          name: string;
          started_at: Date;
          recovered_at: Date | null;
          cause: string;
          failed_check_count: number;
          summary: string | null;
        }>(sql`
          SELECT i.id, w.name, i.started_at, i.recovered_at, i.cause, i.failed_check_count, a.summary
          FROM incidents i JOIN websites w ON w.id = i.website_id
          LEFT JOIN ai_analyses a ON a.incident_id = i.id AND a.status = 'DONE'
          WHERE (${websiteId ?? null}::int IS NULL OR i.website_id = ${websiteId ?? null})
            AND (${status} = 'all' OR (${status} = 'open' AND i.recovered_at IS NULL) OR (${status} = 'closed' AND i.recovered_at IS NOT NULL))
            AND ${dayBounds(from, to, tz, 30)}
          ORDER BY i.started_at DESC LIMIT ${limit}
        `);
        return res.rows.map((r) => {
          const start = new Date(r.started_at);
          const end = r.recovered_at ? new Date(r.recovered_at) : null;
          return {
            incidentId: Number(r.id),
            website: r.name,
            startedAt: fmt(start),
            recoveredAt: fmt(end),
            ongoing: !end,
            durationMinutes: Math.round(((end ?? new Date()).getTime() - start.getTime()) / 60_000),
            cause: r.cause,
            failedChecks: r.failed_check_count,
            aiSummary: r.summary,
          };
        });
      },
    }),
    defineTool({
      name: "get_response_stats",
      description:
        "สถิติ response time ของผลตรวจที่สำเร็จ (เฉลี่ย, p95, สูงสุด) และจำนวนผลตรวจล้มเหลว ในช่วงชั่วโมงที่ระบุ — ใช้ตอบว่าเว็บไหนช้า",
      input: z.object({
        websiteId: z.number().int().optional(),
        hours: z.number().int().min(1).max(720).default(24),
      }),
      async run({ websiteId, hours }) {
        const res = await getDb().execute<{
          name: string;
          avg: string | null;
          p95: string | null;
          max: number | null;
          checks: string;
          failed: string;
        }>(sql`
          SELECT w.name,
                 avg(c.response_time_ms) FILTER (WHERE c.status = 'UP')::text AS avg,
                 (percentile_cont(0.95) WITHIN GROUP (ORDER BY c.response_time_ms) FILTER (WHERE c.status = 'UP'))::text AS p95,
                 max(c.response_time_ms) FILTER (WHERE c.status = 'UP') AS max,
                 count(*)::text AS checks,
                 count(*) FILTER (WHERE c.status = 'DOWN')::text AS failed
          FROM check_results c JOIN websites w ON w.id = c.website_id
          WHERE c.checked_at >= now() - make_interval(hours => ${hours}) AND w.archived_at IS NULL
            AND (${websiteId ?? null}::int IS NULL OR c.website_id = ${websiteId ?? null})
          GROUP BY w.name ORDER BY avg(c.response_time_ms) FILTER (WHERE c.status = 'UP') DESC NULLS LAST
        `);
        return res.rows.map((r) => ({
          website: r.name,
          hours,
          avgMs: r.avg ? Math.round(Number(r.avg)) : null,
          p95Ms: r.p95 ? Math.round(Number(r.p95)) : null,
          maxMs: r.max,
          checks: Number(r.checks),
          failedChecks: Number(r.failed),
        }));
      },
    }),
    defineTool({
      name: "get_outage_groups",
      description:
        "หาเว็บที่ล่มพร้อมกันและน่าจะมีต้นเหตุร่วม (เซิร์ฟเวอร์ IP เดียวกัน, โดเมนเดียวกัน, DNS, เครือข่าย) ในช่วงวันที่ระบุ (ค่าเริ่มต้น 7 วัน)",
      input: z.object({ from: dateStr.optional(), to: dateStr.optional() }),
      async run({ from, to }) {
        // ขอบวันตาม timezone ที่ตั้ง (APP_TIMEZONE) ไม่ใช่ +07:00 ตายตัว
        const b = (
          await getDb().execute<{ s: Date | null; e: Date | null }>(sql`
            SELECT (${from ?? null}::date::timestamp AT TIME ZONE ${tz}) AS s,
                   ((${to ?? null}::date + 1)::timestamp AT TIME ZONE ${tz}) AS e
          `)
        ).rows[0];
        const start = b?.s ? new Date(b.s) : new Date(Date.now() - 7 * 86_400_000);
        const end = b?.e ? new Date(b.e) : new Date();
        const groups = correlateOutages(await loadOutages(getDb(), { from: start, to: end }));
        return groups.map((g) => ({
          title: g.title,
          hint: g.hint,
          startedAt: fmt(g.startedAt),
          websites: g.members.map((m) => m.name),
        }));
      },
    }),
    defineTool({
      name: "get_security_overview",
      description:
        "สรุปความปลอดภัย: เกรดความปลอดภัยรายเว็บ (A–F) และจำนวนปัญหา, วันหมดอายุ SSL, ผลเทียบภาพหน้าเว็บ, การแจ้งเตือนที่ยังไม่รับทราบ และโดเมนเลียนแบบที่พบ",
      input: z.object({}),
      async run() {
        const [sites, alerts, domains] = await Promise.all([
          securityOverview(),
          securityAlertsList({ open: true, limit: 20 }),
          lookalikeList(20),
        ]);
        return {
          websites: sites.map((s) => ({
            name: s.name,
            grade: s.grade,
            score: s.score,
            issues: { high: s.high, medium: s.medium, low: s.low },
            sslExpires: s.tlsValidTo ? formatDateTime(s.tlsValidTo, tz) : null,
            pageChangePct: s.visualDiffPct,
            suspiciousKeywords: s.visualKeywords,
          })),
          openAlerts: alerts.map((a) => ({
            type: a.type,
            severity: a.severity,
            title: a.title,
            at: fmt(a.createdAt),
          })),
          lookalikeDomains: domains
            .filter((d) => d.status === "NEW")
            .map((d) => ({ domain: d.domain, similarTo: d.matchedKeyword, kind: d.similarity })),
        };
      },
    }),
    defineTool({
      name: "get_system_status",
      description: "สถานะของระบบตรวจเอง: Worker ทำงานอยู่ไหม, Canary (เน็ตขาออก), คิวอีเมลค้าง",
      input: z.object({}),
      async run() {
        const settings = await loadSettings();
        const [worker, canary, outbox] = await Promise.all([
          workerHealth(),
          canaryHealth(),
          outboxHealth(settings),
        ]);
        return {
          worker: { health: worker.health, lastHeartbeat: fmt(worker.lastSeenAt) },
          canary: canary.health,
          emailQueue: {
            health: outbox.health,
            pending: outbox.pending,
            failed: outbox.failed,
            smtpConfigured: outbox.smtpConfigured,
          },
        };
      },
    }),
  ];
}

/** คง type ของ input ต่อเครื่องมือ (เช่น websiteIds เป็น number[]) */
function defineTool<S extends z.ZodObject>(tool: AskTool<S>): AskTool {
  return tool as unknown as AskTool;
}
