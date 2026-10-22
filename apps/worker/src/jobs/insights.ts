import {
  detectAnomalies,
  diffFingerprints,
  isFingerprint,
  isLearning,
  type AnomalyBaseline,
  type Fingerprint,
} from "@app/core";
import { collectFingerprint, runDiagnosis } from "@app/core/server";
import { diagnoses, logEvent, securityAlerts, setState, siteChanges, sql } from "@app/db";
import { canaryFailing, type WorkerContext } from "../context";

const FINGERPRINT_BATCH = 3;
/** แจ้งเตือนเรื่องเดิม (เว็บ + หัวข้อเดียวกัน) ซ้ำได้ไม่ถี่กว่านี้ — กันใบรับรองที่สลับไปมาส่งอีเมลรัว ๆ */
const SITE_CHANGE_REALERT_HOURS = 24;

/** ส่วนที่เก็บไม่ได้รอบนี้ (error) ให้ใช้ค่าเดิม — ไม่งั้นรอบถัดไปจะเทียบกับค่าว่างแล้วพลาดการเปลี่ยนแปลง */
export function mergeFingerprint(prev: Fingerprint | null, next: Fingerprint): Fingerprint {
  if (!prev) return next;
  const dns = next.dns.error && !prev.dns.error ? prev.dns : next.dns;
  return {
    // CNAME / NS ถามไม่ทัน → ใช้ค่าเดิม (ส่วนอื่นของ DNS ใช้ค่าใหม่ได้)
    // NS ว่างรอบหนึ่งแล้วเก็บไว้ = รอบหน้าไม่มีค่าเดิมให้เทียบ → ถูกเปลี่ยน NS (ยึดโดเมน) ก็ไม่แจ้งเตือน
    dns: {
      ...dns,
      ...(dns.cnameError && !prev.dns.cnameError ? { cname: prev.dns.cname, cnameError: null } : {}),
      ...(dns.nsError && prev.dns.ns.length ? { ns: prev.dns.ns, nsError: null } : {}),
    },
    tls: next.tls?.error && prev.tls && !prev.tls.error ? prev.tls : next.tls,
    http: next.http.error && !prev.http.error ? prev.http : next.http,
  };
}

/** เก็บลายนิ้วมือของเว็บตามรอบ แล้วบันทึกสิ่งที่เปลี่ยนลงไทม์ไลน์ */
export async function runFingerprints(ctx: WorkerContext): Promise<void> {
  const { insights } = await ctx.settings();
  if (insights.fingerprintMinutes === 0) return;
  const due = await ctx.db.execute<{ id: number; name: string; url: string; data: Fingerprint | null }>(sql`
    SELECT w.id, w.name, w.url, f.data
    FROM websites w
    LEFT JOIN site_fingerprints f ON f.website_id = w.id
    WHERE w.enabled AND w.archived_at IS NULL
      AND (f.taken_at IS NULL OR f.taken_at < now() - make_interval(mins => ${insights.fingerprintMinutes}))
    ORDER BY f.taken_at NULLS FIRST, w.id
    LIMIT ${FINGERPRINT_BATCH}
  `);
  for (const site of due.rows) {
    const id = Number(site.id);
    try {
      const next = await collectFingerprint(site.url);
      // ข้อมูลเดิมเสียหาย/รูปแบบเก่า → เริ่มเก็บใหม่ (ไม่ crash แล้วค้างไม่เก็บอีกเลย)
      const prev = isFingerprint(site.data) ? site.data : null;
      const changes = prev ? diffFingerprints(prev, next) : [];
      const stored = mergeFingerprint(prev, next);
      await ctx.db.transaction(async (tx) => {
        if (changes.length) {
          await tx.insert(siteChanges).values(changes.map((c) => ({ websiteId: id, ...c })));
          const important = changes.filter((c) => c.severity === "high" || c.severity === "medium");
          if (important.length) {
            await logEvent(tx, {
              type: "SITE_CHANGED",
              level: important.some((c) => c.severity === "high") ? "WARN" : "INFO",
              websiteId: id,
              message: `${site.name} มีการเปลี่ยนแปลง: ${important.map((c) => c.label).join(", ")}`,
              detail: important
                .map((c) => `${c.label}: ${c.oldValue ?? "—"} → ${c.newValue ?? "—"}`)
                .join("\n")
                .slice(0, 1_000),
            });
          }
          // Nameserver/ใบรับรองไม่ถูกต้อง เปลี่ยนกะทันหัน = สัญญาณโดเมนถูกยึด/ตั้งค่าผิด → แจ้งเตือนทันที
          for (const c of changes.filter((x) => x.severity === "high")) {
            // ใบรับรองกลับมาถูกต้อง = แก้แล้ว → ปิดแจ้งเตือนเดิมเอง ไม่ต้องเตือนใหม่
            if (c.field === "tls.valid" && c.newValue === "ถูกต้อง") {
              await tx.execute(sql`
                UPDATE security_alerts SET acknowledged_at = now(),
                  detail = coalesce(detail, '{}'::jsonb) || '{"autoResolved": true}'::jsonb
                WHERE website_id = ${id} AND type = 'SITE_CHANGE' AND acknowledged_at IS NULL
                  AND detail->>'field' = 'tls.valid'
              `);
              continue;
            }
            const [recent] = (
              await tx.execute<{ ok: number }>(sql`
                SELECT 1 AS ok FROM security_alerts
                WHERE website_id = ${id} AND type = 'SITE_CHANGE' AND detail->>'field' = ${c.field}
                  AND (acknowledged_at IS NULL OR created_at > now() - make_interval(hours => ${SITE_CHANGE_REALERT_HOURS}))
                LIMIT 1
              `)
            ).rows;
            if (recent) continue;
            await tx.insert(securityAlerts).values({
              websiteId: id,
              type: "SITE_CHANGE",
              severity: "high",
              title: `${site.name}: ${c.label}เปลี่ยน`,
              detail: { field: c.field, oldValue: c.oldValue, newValue: c.newValue },
            });
          }
        }
        await tx.execute(sql`
          INSERT INTO site_fingerprints (website_id, data, taken_at)
          VALUES (${id}, ${JSON.stringify(stored)}::jsonb, now())
          ON CONFLICT (website_id) DO UPDATE SET data = EXCLUDED.data, taken_at = EXCLUDED.taken_at
        `);
      });
      if (changes.length) ctx.log.info("site changes", { websiteId: id, count: changes.length });
    } catch (err) {
      ctx.log.warn("fingerprint failed", {
        websiteId: id,
        err: err instanceof Error ? err.message : String(err),
      });
      // เลื่อนเวลาไว้ ไม่ให้เว็บเดียวที่ error วนกินคิวทุกรอบ · ยังไม่มีข้อมูลเดิม = เก็บ JSON null
      // (ไม่ใช่ {} ที่ดูเหมือนมีข้อมูลแล้วทำให้รอบถัดไป crash)
      await ctx.db.execute(sql`
        INSERT INTO site_fingerprints (website_id, data, taken_at)
        VALUES (${id}, 'null'::jsonb, now())
        ON CONFLICT (website_id) DO UPDATE SET taken_at = now()
      `);
    }
  }
}

async function lastGoodIp(ctx: WorkerContext, websiteId: number): Promise<string | null> {
  const r = await ctx.db.execute<{ remote_ip: string | null }>(sql`
    SELECT remote_ip FROM check_results
    WHERE website_id = ${websiteId} AND status = 'UP' AND remote_ip IS NOT NULL
    ORDER BY checked_at DESC LIMIT 1
  `);
  return r.rows[0]?.remote_ip ?? null;
}

/** วินิจฉัยเว็บ 1 เว็บแล้วบันทึกผล (ผูกกับ incident ที่เปิดอยู่ถ้ามี) */
export async function diagnoseWebsite(
  ctx: WorkerContext,
  websiteId: number,
  trigger: "auto" | "manual",
  incidentId?: number | null,
): Promise<string> {
  const [site] = (
    await ctx.db.execute<{
      id: number;
      url: string;
      degraded_threshold_ms: number | null;
      open_incident: number | null;
    }>(sql`
      SELECT w.id, w.url, w.degraded_threshold_ms,
        (SELECT i.id FROM incidents i WHERE i.website_id = w.id AND i.recovered_at IS NULL LIMIT 1) AS open_incident
      FROM websites w WHERE w.id = ${websiteId} AND w.archived_at IS NULL
    `)
  ).rows;
  if (!site) throw new Error("ไม่พบเว็บไซต์");
  const settings = await ctx.settings();
  const result = await runDiagnosis(site.url, {
    canaryFailing: canaryFailing(ctx.canary),
    lastGoodIp: await lastGoodIp(ctx, websiteId),
    slowMs: site.degraded_threshold_ms ?? settings.check_defaults.slowThresholdMs,
  });
  await ctx.db.insert(diagnoses).values({
    websiteId,
    incidentId: incidentId ?? (site.open_incident === null ? null : Number(site.open_incident)),
    trigger,
    durationMs: result.durationMs,
    verdict: result.verdict as unknown as Record<string, unknown>,
    steps: result.steps as unknown as Array<Record<string, unknown>>,
  });
  return `${result.verdict.title} (${(result.durationMs / 1000).toFixed(1)} วินาที)`;
}

/** วินิจฉัยอัตโนมัติทันทีที่เปิด incident — ตอนที่ปัญหายังเกิดอยู่ ข้อมูลจึงตรงที่สุด */
export async function runAutoDiagnosis(ctx: WorkerContext): Promise<void> {
  const { insights } = await ctx.settings();
  if (!insights.autoDiagnose) return;
  const due = await ctx.db.execute<{ id: number; website_id: number }>(sql`
    SELECT i.id, i.website_id FROM incidents i
    WHERE i.recovered_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM diagnoses d WHERE d.incident_id = i.id)
    ORDER BY i.confirmed_at LIMIT 3
  `);
  for (const inc of due.rows) {
    try {
      const msg = await diagnoseWebsite(ctx, Number(inc.website_id), "auto", Number(inc.id));
      ctx.log.info("auto diagnosis", { incidentId: Number(inc.id), result: msg });
    } catch (err) {
      ctx.log.warn("auto diagnosis failed", {
        incidentId: Number(inc.id),
        err: err instanceof Error ? err.message : String(err),
      });
      // บันทึกผลว่าวินิจฉัยไม่ได้ ไม่ให้วนลองซ้ำทุกรอบ
      await ctx.db.insert(diagnoses).values({
        websiteId: Number(inc.website_id),
        incidentId: Number(inc.id),
        trigger: "auto",
        verdict: {
          layer: "unknown",
          severity: "warn",
          title: "วินิจฉัยไม่สำเร็จ",
          explanation: err instanceof Error ? err.message.slice(0, 300) : "ไม่ทราบสาเหตุ",
          actions: ["กดวินิจฉัยใหม่อีกครั้งจากหน้าเว็บไซต์"],
          healthy: [],
        },
        steps: [],
      });
    }
  }
}

export interface AnomalyStatus {
  learning: boolean;
  samples: number;
  median: number | null;
  active: string[];
}

const ANOMALY_TYPES = { slow: "ANOMALY_SLOW", unstable: "ANOMALY_UNSTABLE" } as const;

type BaselineRow = {
  h_median: number | null;
  h_p90: number | null;
  h_samples: number;
  h_flaky: number | null;
  a_median: number | null;
  a_p90: number | null;
  a_samples: number;
  a_flaky: number | null;
};

/**
 * baseline = สถิติ 14 วัน (ไม่รวม 2 ชม. ล่าสุด) — ต้องอ่านผลตรวจหลายล้านแถว แต่เปลี่ยนช้ามาก
 * จึงคำนวณใหม่เมื่อขึ้นชั่วโมงใหม่ (ช่วง "ชั่วโมงเดียวกัน" เปลี่ยน) หรือเก่ากว่า 1 ชม. เท่านั้น
 * แทนที่จะสแกนทุก 5 นาที (ลดงานฐานข้อมูลลง ~12 เท่า)
 */
let baselineCache: { key: string; at: number; rows: Map<number, BaselineRow> } | null = null;
const BASELINE_MAX_AGE_MS = 3_600_000;

export async function anomalyBaselines(ctx: WorkerContext, tz: string): Promise<Map<number, BaselineRow>> {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
    new Date(),
  );
  const key = `${tz}:${hour}`;
  if (baselineCache && baselineCache.key === key && Date.now() - baselineCache.at < BASELINE_MAX_AGE_MS)
    return baselineCache.rows;
  const res = await ctx.db.execute<BaselineRow & { website_id: number }>(sql`
    WITH hist AS (
      SELECT c.website_id, c.status, c.retries, c.response_time_ms,
        ((extract(hour from c.checked_at AT TIME ZONE ${tz})::int
          - extract(hour from now() AT TIME ZONE ${tz})::int + 24) % 24) IN (0, 1, 23) AS same_hour
      FROM check_results c
      WHERE c.checked_at > now() - interval '14 days' AND c.checked_at < now() - interval '2 hours'
        AND c.status IN ('UP', 'DOWN')
    )
    SELECT website_id,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE status = 'UP' AND same_hour) AS h_median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE status = 'UP' AND same_hour) AS h_p90,
      count(*) FILTER (WHERE status = 'UP' AND same_hour)::int AS h_samples,
      avg(CASE WHEN status = 'DOWN' OR retries > 0 THEN 1.0 ELSE 0 END) FILTER (WHERE same_hour) AS h_flaky,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE status = 'UP') AS a_median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE status = 'UP') AS a_p90,
      count(*) FILTER (WHERE status = 'UP')::int AS a_samples,
      avg(CASE WHEN status = 'DOWN' OR retries > 0 THEN 1.0 ELSE 0 END) AS a_flaky
    FROM hist GROUP BY website_id
  `);
  const rows = new Map(res.rows.map(({ website_id, ...b }) => [Number(website_id), b]));
  baselineCache = { key, at: Date.now(), rows };
  return rows;
}

/** สำหรับเทสต์ */
export function resetAnomalyBaselineCache(): void {
  baselineCache = null;
}

/**
 * เทียบผลตรวจชั่วโมงล่าสุดกับ "ปกติของเว็บนี้ในช่วงเวลาเดียวกันของวัน" (14 วันย้อนหลัง ±1 ชม.)
 * แจ้งเตือนล่วงหน้าก่อนเว็บล่มจริง และปิดการแจ้งเตือนเองเมื่อกลับมาปกติ
 */
export async function runAnomalyDetection(ctx: WorkerContext): Promise<void> {
  const { insights } = await ctx.settings();
  if (!insights.anomalyEnabled) {
    // ปิดฟีเจอร์ → ปิดการแจ้งเตือนที่ค้างอยู่ (ไม่มีอะไรมาปิดให้อัตโนมัติแล้ว)
    await ctx.db.execute(sql`
      UPDATE security_alerts SET acknowledged_at = now()
      WHERE type IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE') AND acknowledged_at IS NULL
    `);
    return;
  }
  const tz = ctx.env.APP_TIMEZONE;
  const baselines = await anomalyBaselines(ctx, tz);
  const current = await ctx.db.execute<{
    id: number;
    name: string;
    has_incident: boolean;
    recent_up: number[] | null;
    recent_total: number;
    recent_flaky: number;
  }>(sql`
    WITH recent AS (
      SELECT website_id,
        array_agg(response_time_ms ORDER BY checked_at) FILTER (WHERE status = 'UP' AND response_time_ms IS NOT NULL) AS recent_up,
        count(*)::int AS recent_total,
        count(*) FILTER (WHERE status = 'DOWN' OR retries > 0)::int AS recent_flaky
      FROM check_results c
      WHERE c.checked_at > now() - interval '1 hour' AND c.status IN ('UP', 'DOWN')
        -- ไม่นับผลตรวจช่วงที่ล่มเป็น Incident อยู่ (ปิดไปแล้วในชั่วโมงนี้) — ไม่งั้นเว็บเพิ่งกลับมา
        -- ก็ถูกเตือน "เริ่มไม่เสถียร อาจกำลังจะล่ม" ซ้ำกับ Incident ที่เพิ่งจบ
        AND c.checked_at > coalesce(
          (SELECT max(i.recovered_at) FROM incidents i
           WHERE i.website_id = c.website_id AND i.recovered_at > now() - interval '1 hour'),
          '-infinity'::timestamptz)
      GROUP BY website_id
    )
    SELECT w.id, w.name,
      EXISTS (SELECT 1 FROM incidents i WHERE i.website_id = w.id AND i.recovered_at IS NULL) AS has_incident,
      r.recent_up, coalesce(r.recent_total, 0) AS recent_total, coalesce(r.recent_flaky, 0) AS recent_flaky
    FROM websites w
    LEFT JOIN recent r ON r.website_id = w.id
    WHERE w.enabled AND w.archived_at IS NULL
  `);
  const NO_BASELINE: BaselineRow = {
    h_median: null,
    h_p90: null,
    h_samples: 0,
    h_flaky: null,
    a_median: null,
    a_p90: null,
    a_samples: 0,
    a_flaky: null,
  };
  const stats = {
    rows: current.rows.map((r) => ({ ...(baselines.get(Number(r.id)) ?? NO_BASELINE), ...r })),
  };

  const open = await ctx.db.execute<{ id: number; website_id: number; type: string }>(sql`
    SELECT id, website_id, type FROM security_alerts
    WHERE type IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE') AND acknowledged_at IS NULL
  `);
  const recentlyRaised = await ctx.db.execute<{ website_id: number; type: string }>(sql`
    SELECT DISTINCT website_id, type FROM security_alerts
    WHERE type IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE') AND created_at > now() - interval '3 hours'
  `);
  const openKey = new Map(open.rows.map((a) => [`${a.website_id}:${a.type}`, Number(a.id)]));
  const raisedKey = new Set(recentlyRaised.rows.map((a) => `${a.website_id}:${a.type}`));
  const status: Record<string, AnomalyStatus> = {};

  for (const s of stats.rows) {
    const id = Number(s.id);
    // ใช้ช่วงเวลาเดียวกันของวันถ้ามีข้อมูลพอ ไม่งั้นใช้ทั้งวัน
    const sameHour = Number(s.h_samples) >= 30;
    const baseline: AnomalyBaseline = {
      median:
        (sameHour ? s.h_median : s.a_median) === null ? null : Number(sameHour ? s.h_median : s.a_median),
      p90: (sameHour ? s.h_p90 : s.a_p90) === null ? null : Number(sameHour ? s.h_p90 : s.a_p90),
      samples: Number(sameHour ? s.h_samples : s.a_samples),
      flakyRate: Number((sameHour ? s.h_flaky : s.a_flaky) ?? 0),
    };
    // กำลังล่มอยู่ = แจ้งเตือนไปแล้วผ่าน incident → ไม่ซ้ำ
    const found = s.has_incident
      ? []
      : detectAnomalies(
          baseline,
          {
            upMs: (s.recent_up ?? []).map(Number),
            total: Number(s.recent_total),
            flaky: Number(s.recent_flaky),
          },
          insights.anomalySensitivity,
        );
    status[id] = {
      learning: isLearning(baseline),
      samples: baseline.samples,
      median: baseline.median === null ? null : Math.round(baseline.median),
      active: found.map((a) => a.kind),
    };

    for (const kind of ["slow", "unstable"] as const) {
      const type = ANOMALY_TYPES[kind];
      const key = `${id}:${type}`;
      const anomaly = found.find((a) => a.kind === kind);
      if (anomaly && !openKey.has(key) && !raisedKey.has(key)) {
        await ctx.db.insert(securityAlerts).values({
          websiteId: id,
          type,
          severity: "medium",
          title: `${s.name}: ${anomaly.title}`,
          detail: {
            detail: anomaly.detail,
            factor: Number(anomaly.factor.toFixed(2)),
            baselineMs: status[id].median,
          },
        });
        await logEvent(ctx.db, {
          type: "ANOMALY",
          level: "WARN",
          websiteId: id,
          message: `${s.name} ${anomaly.title}`,
          detail: anomaly.detail,
        });
      } else if (!anomaly && openKey.has(key) && !s.has_incident) {
        // กลับมาปกติ → ปิดการแจ้งเตือนเอง (acknowledged_by = null หมายถึงระบบปิด)
        await ctx.db.execute(sql`
          UPDATE security_alerts
          SET acknowledged_at = now(), detail = coalesce(detail, '{}'::jsonb) || '{"autoResolved": true}'::jsonb
          WHERE id = ${openKey.get(key)!}
        `);
        await logEvent(ctx.db, {
          type: "ANOMALY_RESOLVED",
          level: "SUCCESS",
          websiteId: id,
          message: `${s.name} กลับมาทำงานตามปกติแล้ว`,
        });
      }
    }
  }
  await setState(ctx.db, "anomaly", { checkedAt: new Date().toISOString(), sites: status });
}
