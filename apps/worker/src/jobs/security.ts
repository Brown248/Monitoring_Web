import { extractLookalikes, runSecurityScan, searchCertificates, typoVariants } from "@app/core/server";
import { getState, logEvent, lookalikeDomains, securityAlerts, securityScans, setState, sql } from "@app/db";
import type { WorkerContext } from "../context";

const SCAN_BATCH = 2;

async function scanOne(ctx: WorkerContext, site: { id: number; name: string; url: string }): Promise<string> {
  const prev = (
    await ctx.db.execute<{ findings: Array<{ id: string; severity: string }> }>(sql`
      SELECT findings FROM security_scans WHERE website_id = ${site.id} AND error IS NULL
      ORDER BY scanned_at DESC LIMIT 1
    `)
  ).rows[0];
  try {
    const r = await runSecurityScan(site.url);
    await ctx.db.insert(securityScans).values({
      websiteId: site.id,
      score: r.score,
      grade: r.grade,
      findings: r.findings,
      tlsValidTo: r.tlsValidTo,
    });
    // ปัญหาร้ายแรงที่เพิ่งพบ (ไม่มีในรอบก่อน และยังไม่มี alert ที่เปิดค้างของเรื่องเดียวกัน) → แจ้งเตือน
    // (รอบก่อนอาจสแกนไม่สำเร็จ/หาไม่เจอชั่วคราว — ถ้าเทียบแค่รอบก่อนจะแจ้งเรื่องเดิมซ้ำ)
    const before = new Set((prev?.findings ?? []).filter((f) => f.severity === "high").map((f) => f.id));
    const open = new Set(
      (
        await ctx.db.execute<{ finding_id: string }>(sql`
          SELECT detail->>'findingId' AS finding_id FROM security_alerts
          WHERE website_id = ${site.id} AND type = 'SECURITY_FINDING' AND acknowledged_at IS NULL
        `)
      ).rows.map((a) => a.finding_id),
    );
    const fresh = r.findings.filter((f) => f.severity === "high" && !before.has(f.id) && !open.has(f.id));
    for (const f of fresh) {
      await ctx.db.insert(securityAlerts).values({
        websiteId: site.id,
        type: "SECURITY_FINDING",
        severity: "high",
        title: `${site.name}: ${f.title}`,
        detail: { findingId: f.id, detail: f.detail, fix: f.fix, url: site.url, grade: r.grade },
      });
    }
    return `เกรด ${r.grade} (${r.score}) · พบ ${r.findings.length} รายการ`;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    await ctx.db.insert(securityScans).values({ websiteId: site.id, findings: [], error: message });
    return `สแกนไม่สำเร็จ: ${message}`;
  }
}

/** สแกนความปลอดภัยวันละครั้งต่อเว็บ (ทีละไม่กี่เว็บต่อรอบ) */
export async function runSecurityScans(ctx: WorkerContext): Promise<void> {
  const { security } = await ctx.settings();
  if (!security.scanEnabled) return;
  const due = await ctx.db.execute<{ id: number; name: string; url: string }>(sql`
    SELECT w.id, w.name, w.url FROM websites w
    LEFT JOIN website_state st ON st.website_id = w.id
    WHERE w.enabled AND w.archived_at IS NULL
      -- เว็บล่มอยู่ = สแกนได้แต่หน้า error → รอให้กลับมาก่อน
      AND st.status IS DISTINCT FROM 'DOWN'
      AND NOT EXISTS (
        SELECT 1 FROM security_scans s WHERE s.website_id = w.id
          AND s.scanned_at > now() - CASE WHEN s.error IS NULL THEN interval '24 hours' ELSE interval '2 hours' END
      )
    ORDER BY (SELECT max(scanned_at) FROM security_scans s WHERE s.website_id = w.id) NULLS FIRST, w.id
    LIMIT ${SCAN_BATCH}
  `);
  for (const site of due.rows) {
    const msg = await scanOne(ctx, { ...site, id: Number(site.id) });
    ctx.log.info("security scan", { websiteId: Number(site.id), result: msg });
  }
}

export async function runSecurityScanNow(ctx: WorkerContext, websiteId: number): Promise<string> {
  const [site] = (
    await ctx.db.execute<{ id: number; name: string; url: string }>(
      sql`SELECT id, name, url FROM websites WHERE id = ${websiteId} AND archived_at IS NULL`,
    )
  ).rows;
  if (!site) throw new Error("ไม่พบเว็บไซต์");
  return scanOne(ctx, { ...site, id: Number(site.id) });
}

const CT_INTERVAL_MS = 12 * 3_600_000;
const LOOKALIKE_BUDGET_MS = 10 * 60_000;
const RECENT_MS = 14 * 86_400_000;

/**
 * เฝ้า Certificate Transparency (crt.sh) ทุก 12 ชม.: ค้นชื่อแบรนด์ + ตัวสะกดคล้าย
 * โดเมนใหม่ที่ออกใบรับรองภายใน 14 วัน → แจ้งเตือน
 */
export async function runLookalikeWatch(ctx: WorkerContext, force = false): Promise<string> {
  const { security } = await ctx.settings();
  if (!security.ctEnabled || security.brandKeywords.length === 0) return "ยังไม่ได้ตั้งชื่อแบรนด์";
  const state = await getState<{ lastRunAt: string }>(ctx.db, "lookalike");
  if (!force && state && Date.now() - new Date(state.lastRunAt).getTime() < CT_INTERVAL_MS)
    return "ยังไม่ถึงรอบ";
  await setState(ctx.db, "lookalike", { lastRunAt: new Date().toISOString(), status: "running" });

  const terms = security.brandKeywords
    .filter((k) => k.length >= 4)
    .flatMap((k) => [
      { query: k, keyword: k, similarity: "contains" as const },
      ...typoVariants(k, 8).map((v) => ({ query: v, keyword: k, similarity: "typo" as const })),
    ]);
  let found = 0;
  let alerted = 0;
  const errors: string[] = [];
  // crt.sh ล่ม = แต่ละคำรอได้หลายนาที × หลายสิบคำ → จำกัดเวลารวม (คำที่เหลือค้นรอบถัดไป)
  const began = Date.now();
  for (const [i, term] of terms.entries()) {
    if (Date.now() - began > LOOKALIKE_BUDGET_MS) {
      errors.push(
        `หมดเวลา ${LOOKALIKE_BUDGET_MS / 60_000} นาที — ค้นได้ ${i}/${terms.length} คำ ที่เหลือค้นรอบถัดไป`,
      );
      break;
    }
    try {
      const rows = await searchCertificates(term.query);
      const hits = extractLookalikes(rows, term, security.ownDomains).slice(0, 300);
      for (const h of hits) {
        const inserted = await ctx.db
          .insert(lookalikeDomains)
          .values({
            domain: h.domain,
            matchedKeyword: h.keyword,
            similarity: h.similarity,
            certId: h.certId,
            issuer: h.issuer,
            notBefore: h.notBefore,
          })
          .onConflictDoNothing()
          .returning({ domain: lookalikeDomains.domain });
        if (inserted.length === 0) continue;
        found++;
        if (h.notBefore && Date.now() - h.notBefore.getTime() < RECENT_MS) {
          alerted++;
          await ctx.db.insert(securityAlerts).values({
            type: "LOOKALIKE_DOMAIN",
            severity: h.similarity === "typo" ? "high" : "medium",
            title: `พบโดเมนเลียนแบบ ${h.domain} (คล้าย "${h.keyword}")`,
            detail: {
              domain: h.domain,
              keyword: h.keyword,
              similarity: h.similarity,
              issuer: h.issuer,
              certId: h.certId,
            },
          });
        }
      }
    } catch (err) {
      errors.push(`${term.query}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 3_000)); // เกรงใจบริการฟรี
  }
  const summary = `ค้น ${terms.length} คำ · โดเมนใหม่ ${found} · แจ้งเตือน ${alerted}${errors.length ? ` · ผิดพลาด ${errors.length}` : ""}`;
  await setState(ctx.db, "lookalike", {
    lastRunAt: new Date().toISOString(),
    status: errors.length === terms.length && terms.length > 0 ? "failed" : "ok",
    summary,
    errors: errors.slice(0, 5),
  });
  if (alerted > 0) {
    await logEvent(ctx.db, {
      type: "LOOKALIKE_DOMAIN",
      level: "WARN",
      message: `พบโดเมนเลียนแบบใหม่ ${alerted} โดเมน`,
    });
  }
  return summary;
}
