import {
  mergeRecipients,
  causeLabel,
  errorLabel,
  formatMs,
  NETWORK_ERROR_CODES,
  nextTransition,
  PRIVATE_TARGET_CODES,
  type CheckOutcome,
} from "@app/core";
import { isAiReady, isBlockedIp, publicLookup, runCheck } from "@app/core/server";
import {
  aiAnalyses,
  checkResults,
  eq,
  events,
  incidents,
  inArray,
  isNull,
  logEvent,
  notificationEvents,
  openRootCause,
  releaseDependentIncidents,
  recheckRootCauses,
  closeIncidentsOfInactiveSite,
  type Database,
  sql,
  websites,
  websiteState,
  and,
  type DbOrTx,
  type Website,
} from "@app/db";
import { canaryFailing, type WorkerContext } from "../context";
import { runCanary } from "./canary";

type PublicLookup = (host: string) => Promise<{ addresses: string[] }>;

/**
 * ก่อนตัดสินว่าเว็บล่ม ตรวจว่าไม่ใช่ปัญหาฝั่งเราเอง:
 * 1) ล้มเพราะเครือข่าย/ปลายทางกลายเป็น IP ภายใน แต่ผล canary เก่ากว่า 20 วินาที → ตรวจ canary ใหม่ก่อน
 *    (canary ตรวจทุก 60 วินาที — ช่วงแรกที่เน็ตออฟฟิศหลุด หรือถูกจับไปหน้า login ของเราเตอร์ (captive portal)
 *    ทุกเว็บจะดูเหมือนล่มพร้อมกัน)
 * 2) DNS ของเครือข่ายชี้ไป IP ภายใน แต่ DNS สาธารณะชี้ IP จริง = DNS ภายในชี้เอง (เว็บที่โฮสต์ในบริษัท /
 *    split-horizon DNS) ผู้ใช้ภายนอกเข้าได้ปกติ → ไม่รู้ผลจากเครื่องนี้ (UNKNOWN) ไม่ใช่ล่ม
 */
export async function confirmNotOurNetwork(
  ctx: WorkerContext,
  o: CheckOutcome,
  url: string,
  lookupPublic: PublicLookup = publicLookup,
): Promise<CheckOutcome> {
  if (o.status !== "DOWN" || !o.errorCode) return o;
  if (!NETWORK_ERROR_CODES.has(o.errorCode) && !PRIVATE_TARGET_CODES.has(o.errorCode)) return o;
  if (canaryFailing(ctx.canary)) return { ...o, status: "UNKNOWN" };
  const age = ctx.canary.checkedAt ? Date.now() - ctx.canary.checkedAt.getTime() : Infinity;
  if (age > 20_000)
    await runCanary(ctx).catch((err: unknown) => ctx.log.warn("canary recheck failed", { err }));
  if (canaryFailing(ctx.canary)) return { ...o, status: "UNKNOWN" };
  if (o.errorCode === "PRIVATE_TARGET") {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return o;
    }
    const pub = await lookupPublic(host).catch(() => ({ addresses: [] as string[] }));
    const publicIp = pub.addresses.find((ip) => !isBlockedIp(ip));
    if (publicIp)
      return {
        ...o,
        status: "UNKNOWN",
        errorMessage: `DNS ของเครือข่ายชี้ ${host} ไป IP ภายใน แต่ DNS สาธารณะชี้ ${publicIp} — ผู้ใช้ภายนอกน่าจะเข้าได้ปกติ ตรวจจากเครื่องนี้ไม่ได้`,
      };
  }
  return o;
}

/**
 * ดึงงานที่ถึงเวลาด้วย FOR UPDATE SKIP LOCKED แล้วเลื่อน next_check_at ไปข้างหน้าในทรานแซกชันเดียว (lease)
 * → commit ก่อนยิง HTTP เพื่อไม่ถือ row lock ระหว่างรอเครือข่าย; ถ้า worker ตาย งานนั้นจะถูกตรวจในรอบถัดไป
 */
export async function claimDueChecks(db: DbOrTx, limit: number): Promise<Website[]> {
  if (limit <= 0) return [];
  const claimed = await db.execute<{ website_id: number }>(sql`
    WITH due AS (
      SELECT ws.website_id
      FROM website_state ws
      JOIN websites w ON w.id = ws.website_id
      WHERE ws.next_check_at <= now() AND w.enabled AND w.archived_at IS NULL
      ORDER BY ws.next_check_at
      LIMIT ${limit}
      FOR UPDATE OF ws SKIP LOCKED
    )
    UPDATE website_state ws
    SET next_check_at = now() + make_interval(secs => w.check_interval_seconds), updated_at = now()
    FROM due, websites w
    WHERE ws.website_id = due.website_id AND w.id = ws.website_id
    RETURNING ws.website_id
  `);
  const ids = claimed.rows.map((r) => Number(r.website_id));
  if (ids.length === 0) return [];
  return db.select().from(websites).where(inArray(websites.id, ids));
}

/** ตรวจเว็บหนึ่งรายการแล้วบันทึกผล */
export async function checkWebsite(ctx: WorkerContext, site: Website): Promise<CheckOutcome> {
  const { outcome } = await runCheck(
    {
      url: site.url,
      timeoutMs: site.timeoutMs,
      followRedirects: site.followRedirects,
      maxRedirects: site.maxRedirects,
      treatAuthAsUp: site.treatAuthAsUp,
      upStatusCodes: site.upStatusCodes,
      retryCount: site.retryCount,
      retryDelayMs: site.retryDelayMs,
      degradedThresholdMs: site.degradedThresholdMs,
    },
    { canaryFailing: canaryFailing(ctx.canary) },
  );
  const final = await confirmNotOurNetwork(ctx, outcome, site.url);
  try {
    await recordOutcome(ctx, site, final);
  } catch (err) {
    // deadlock/serialization (หลายเว็บเปิด-ปิด Incident พร้อมกัน) — ฐานข้อมูลยกเลิกให้ฝั่งหนึ่ง ลองใหม่ครั้งเดียวพอ
    const code =
      (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code !== "40P01" && code !== "40001") throw err;
    ctx.log.warn("recordOutcome retried after deadlock", { websiteId: site.id });
    await recordOutcome(ctx, site, final);
  }
  return final;
}

/**
 * บันทึกผลตรวจ + อัปเดตสถานะ + เปิด/ปิด Incident + สร้างงานอีเมลใน outbox — ทั้งหมดในทรานแซกชันเดียว
 * partial unique index (incident เปิดได้ 1 รายการต่อเว็บ) และ unique ของ outbox กันงานซ้ำแม้มีหลาย worker
 */
export async function recordOutcome(ctx: WorkerContext, site: Website, o: CheckOutcome): Promise<void> {
  const settings = await ctx.settings();
  const aiReady = isAiReady(settings.ai, { apiKey: ctx.env.AI_API_KEY, baseUrl: ctx.env.AI_BASE_URL });

  await ctx.db.transaction(async (tx) => {
    // เว็บถูกปิดตรวจ/archive ระหว่างที่กำลังตรวจ → ทิ้งผลนี้ ไม่เปิด Incident/ส่งอีเมลหลังผู้ดูแลสั่งหยุดแล้ว
    // แก้ URL ระหว่างตรวจ → ผลนี้เป็นของ URL เดิม ไม่ใช่เว็บที่ตั้งไว้ตอนนี้ (ทิ้ง ไม่ให้เปิด Incident ด้วยผลของ URL เก่า)
    const [live] = (
      await tx.execute<{ active: boolean; url: string }>(
        sql`SELECT (enabled AND archived_at IS NULL) AS active, url FROM websites WHERE id = ${site.id} FOR SHARE`,
      )
    ).rows;
    if (!live?.active || live.url !== site.url) return;
    const [row] = await tx
      .insert(checkResults)
      .values({
        websiteId: site.id,
        checkedAt: o.startedAt,
        finishedAt: o.finishedAt,
        status: o.status,
        degraded: o.degraded,
        httpStatus: o.httpStatus,
        firstHttpStatus: o.firstHttpStatus,
        responseTimeMs: o.responseTimeMs,
        retries: o.retries,
        errorCode: o.errorCode,
        errorMessage: o.errorMessage,
        finalUrl: o.finalUrl,
        redirectCount: o.redirectCount,
        remoteIp: o.remoteIp,
        dnsMs: o.dnsMs,
        connectMs: o.connectMs,
        tlsMs: o.tlsMs,
        workerId: ctx.workerId,
      })
      .returning({ id: checkResults.id });
    const checkId = row!.id;

    const [state] = await tx
      .select()
      .from(websiteState)
      .where(eq(websiteState.websiteId, site.id))
      .for("update");
    if (!state) throw new Error(`website_state missing for website ${site.id}`);

    const [open] = await tx
      .select()
      .from(incidents)
      .where(and(eq(incidents.websiteId, site.id), isNull(incidents.recoveredAt)));

    const prevDegraded = state.lastResultId
      ? (
          await tx
            .select({ d: checkResults.degraded })
            .from(checkResults)
            .where(eq(checkResults.id, state.lastResultId))
        )[0]?.d
      : false;

    // ผลล้มเหลวที่ค้างใน streak เก่ามาก (มีช่วง "ไม่ทราบผล" คั่นยาว เช่น เน็ตของ Worker ล่มเป็นชั่วโมง)
    // ไม่ใช่ความล้มเหลวต่อเนื่อง — เริ่มนับใหม่ ไม่งั้น Incident เปิดโดยย้อนเวลาเริ่มไปหลายชั่วโมง/วัน
    const streakIsStale =
      o.status === "DOWN" &&
      !open &&
      state.consecutiveFailures > 0 &&
      state.failureStreakStartedAt !== null &&
      o.startedAt.getTime() - state.failureStreakStartedAt.getTime() >
        (state.consecutiveFailures + 1) * site.checkIntervalSeconds * 2_000 + 15 * 60_000;
    const failuresSoFar = streakIsStale ? 0 : state.consecutiveFailures;

    const next = nextTransition(
      {
        consecutiveFailures: failuresSoFar,
        consecutiveSuccesses: state.consecutiveSuccesses,
        hasOpenIncident: Boolean(open),
      },
      o.status,
      { confirmDownCount: site.confirmDownCount, confirmRecoveryCount: site.confirmRecoveryCount },
    );

    const cause = causeLabel(o.errorCode, o.httpStatus);
    let streakStartedAt = state.failureStreakStartedAt;
    let streakFirstCheckId = state.failureStreakFirstCheckId;

    if (o.status === "DOWN" && failuresSoFar === 0 && !open) {
      streakStartedAt = o.startedAt;
      streakFirstCheckId = checkId;
      await logEvent(tx, {
        type: "FIRST_FAILURE",
        level: "WARN",
        websiteId: site.id,
        at: o.startedAt,
        message: `${site.name} ตรวจล้มเหลวรอบแรก (${cause})`,
        detail: `${o.retries > 0 ? `${cause} หลัง retry ${o.retries} ครั้ง` : cause} · ยังไม่เปิด Incident`,
      });
    } else if (o.status === "UP") {
      streakStartedAt = null;
      streakFirstCheckId = null;
    }

    if (o.status === "UP" && o.degraded && !prevDegraded) {
      await logEvent(tx, {
        type: "SLOW",
        level: "WARN",
        websiteId: site.id,
        incidentId: open?.id ?? null,
        at: o.startedAt,
        message: `${site.name} ตอบช้ากว่าเกณฑ์`,
        detail: `HTTP ${o.httpStatus} · ${formatMs(o.responseTimeMs)}`,
      });
    }

    if (o.status === "UNKNOWN" && state.status !== "UNKNOWN" && !open) {
      await logEvent(tx, {
        type: "UNKNOWN",
        level: "WARN",
        websiteId: site.id,
        at: o.startedAt,
        message: `${site.name} ผลตรวจเป็น UNKNOWN — ${errorLabel(o.errorCode)}`,
        detail: o.errorMessage,
      });
    }

    if (next.transition === "open") {
      if (streakFirstCheckId !== null && streakFirstCheckId !== checkId) {
        const [exists] = (
          await tx.execute<{ ok: number }>(
            sql`SELECT 1 AS ok FROM check_results WHERE id = ${streakFirstCheckId}`,
          )
        ).rows;
        if (!exists) streakFirstCheckId = checkId;
      }
      const startedAt = streakStartedAt ?? o.startedAt;
      const rootCause = await openRootCause(tx, site.id);
      const recipients = mergeRecipients(site.alertEmails, settings.smtp.alertEmails);
      const inserted = await tx
        .insert(incidents)
        .values({
          websiteId: site.id,
          startedAt,
          confirmedAt: o.finishedAt,
          cause,
          errorCode: o.errorCode,
          failedCheckCount: next.consecutiveFailures,
          firstFailureCheckId: streakFirstCheckId ?? checkId,
          confirmCheckId: checkId,
          rootCauseWebsiteId: rootCause?.id ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: incidents.id });
      const incidentId = inserted[0]?.id;
      if (incidentId) {
        // ผูกเหตุการณ์ "ล้มเหลวรอบแรก/ตอบช้า" ก่อนหน้าเข้ากับ incident นี้
        await tx
          .update(events)
          .set({ incidentId })
          .where(
            and(
              eq(events.websiteId, site.id),
              isNull(events.incidentId),
              sql`${events.at} >= ${new Date(startedAt.getTime() - 15 * 60_000)}`,
              inArray(events.type, ["FIRST_FAILURE", "SLOW"]),
            ),
          );
        await logEvent(tx, {
          type: "INCIDENT_OPENED",
          level: "ERROR",
          websiteId: site.id,
          incidentId,
          at: o.finishedAt,
          message: `${site.name} เปลี่ยนเป็น DOWN (${cause} ติดกัน ${next.consecutiveFailures} รอบ) · เปิด Incident #${incidentId}`,
          detail: `ยืนยัน DOWN ตามเกณฑ์ล้มเหลวติดกัน ${site.confirmDownCount} รอบ`,
        });
        if (rootCause) {
          await logEvent(tx, {
            type: "ALERT_SUPPRESSED",
            level: "WARN",
            websiteId: site.id,
            incidentId,
            at: o.finishedAt,
            message: `${site.name} ล่มเพราะ ${rootCause.name} ล่มอยู่ — ไม่ส่งอีเมลซ้ำ`,
            detail: `${site.name} พึ่งพา ${rootCause.name} (ตามแผนผังความเชื่อมโยง) ซึ่งมี Incident เปิดอยู่แล้ว`,
          });
        } else if (recipients.length > 0) {
          await tx
            .insert(notificationEvents)
            .values(recipients.map((recipient) => ({ incidentId, eventType: "DOWN" as const, recipient })))
            .onConflictDoNothing();
          await logEvent(tx, {
            type: "OUTBOX_CREATED",
            websiteId: site.id,
            incidentId,
            at: o.finishedAt,
            message: `สร้างงานอีเมล DOWN ${recipients.length} รายการใน Outbox`,
            detail: "อยู่ในทรานแซกชันเดียวกับการเปิด Incident",
          });
        } else {
          await logEvent(tx, {
            type: "NO_RECIPIENTS",
            level: "WARN",
            websiteId: site.id,
            incidentId,
            message: `${site.name} ไม่มีผู้รับอีเมล — ไม่ได้ส่งแจ้งเตือน`,
          });
        }
        if (!rootCause && site.aiAutoAnalyze && settings.ai.autoAnalyze && aiReady) {
          await tx.insert(aiAnalyses).values({ incidentId }).onConflictDoNothing();
        }
      }
    } else if (open && o.status === "DOWN") {
      await tx
        .update(incidents)
        .set({ failedCheckCount: sql`${incidents.failedCheckCount} + 1` })
        .where(eq(incidents.id, open.id));
    } else if (open && next.transition === "close") {
      await tx
        .update(incidents)
        .set({ recoveredAt: o.finishedAt, recoveryCheckId: checkId })
        .where(eq(incidents.id, open.id));
      const minutes = Math.max(1, Math.round((o.finishedAt.getTime() - open.startedAt.getTime()) / 60_000));
      await logEvent(tx, {
        type: "INCIDENT_CLOSED",
        level: "SUCCESS",
        websiteId: site.id,
        incidentId: open.id,
        at: o.finishedAt,
        message: `${site.name} กลับมา UP · ปิด Incident #${open.id} (ล่ม ${minutes} นาที)`,
        detail: `สำเร็จติดกัน ${next.consecutiveSuccesses} รอบตามเกณฑ์`,
      });
      // เว็บที่ "ล่มตามกัน" เพราะเว็บนี้ → ถ้ายังล่มอยู่ด้วยตัวเอง ต้องแจ้งเตือนตอนนี้ (และให้ AI วิเคราะห์)
      const released = await releaseDependentIncidents(tx, site.id);
      if (settings.ai.autoAnalyze && aiReady) await queueAiForReleased(tx, released);
      // ส่ง RECOVERY ถึง "คนที่ได้แจ้ง DOWN ของ Incident นี้" เท่านั้น — ผู้รับที่เพิ่มระหว่างล่มไม่ได้รับ "กลับมาแล้ว"
      // ของเรื่องที่ไม่เคยรู้ · ผู้รับที่ถูกเอาออกระหว่างล่มยังได้รับ (เคยได้ DOWN ไปแล้ว)
      // (ล่มตามระบบอื่นแล้วไม่ได้แจ้ง หรือ DOWN ถูกยกเลิกเพราะเก่า → ไม่มีใครได้ RECOVERY)
      if (site.sendRecovery) {
        const queued = await tx.execute<{ recipient: string }>(sql`
          INSERT INTO notification_events (incident_id, event_type, recipient)
          SELECT DISTINCT incident_id, 'RECOVERY'::notification_event_type, recipient FROM notification_events
          WHERE incident_id = ${open.id} AND event_type = 'DOWN'
            AND NOT (status = 'DEAD' AND sent_at IS NULL)
          ON CONFLICT DO NOTHING
          RETURNING recipient
        `);
        if (queued.rows.length > 0)
          await logEvent(tx, {
            type: "OUTBOX_CREATED",
            websiteId: site.id,
            incidentId: open.id,
            at: o.finishedAt,
            message: `สร้างงานอีเมล RECOVERY ${queued.rows.length} รายการใน Outbox`,
          });
      }
      // incident ปิดก่อน AI เริ่มวิเคราะห์ → ข้าม
      await tx
        .update(aiAnalyses)
        .set({ status: "SKIPPED", error: "Incident ปิดก่อนเริ่มวิเคราะห์", completedAt: new Date() })
        .where(and(eq(aiAnalyses.incidentId, open.id), eq(aiAnalyses.status, "PENDING")));
    }

    const statusChanged = next.displayStatus !== state.status;
    await tx
      .update(websiteState)
      .set({
        status: next.displayStatus,
        consecutiveFailures: next.consecutiveFailures,
        consecutiveSuccesses: next.consecutiveSuccesses,
        failureStreakStartedAt: streakStartedAt,
        failureStreakFirstCheckId: streakFirstCheckId,
        lastCheckedAt: o.startedAt,
        lastResultId: checkId,
        lastStatusChangeAt: statusChanged ? o.finishedAt : state.lastStatusChangeAt,
      })
      .where(eq(websiteState.websiteId, site.id));
  });
}

/** สร้างแถว website_state ให้เว็บที่ยังไม่มี (กันกรณีเพิ่มเว็บผ่านช่องทางอื่น) */
export async function ensureStates(db: DbOrTx): Promise<void> {
  await db.execute(sql`
    INSERT INTO website_state (website_id)
    SELECT id FROM websites w WHERE NOT EXISTS (SELECT 1 FROM website_state s WHERE s.website_id = w.id)
  `);
}

/**
 * เว็บที่หยุดตรวจ/archive แต่ยังมี Incident เปิดค้าง (ข้อมูลก่อนมีการปิดอัตโนมัติ หรือแก้ฐานข้อมูลตรง)
 * → ปิดให้ ไม่งั้นหน้าภาพรวมขึ้น "ล่ม" ตลอด และเว็บที่พึ่งพามันจะไม่ได้อีเมลเลย
 */
/** Incident ที่เพิ่งพ้นสถานะ "ล่มตาม" — ตอนเปิดไม่ได้สร้างงาน AI (ไม่ใช่ต้นเหตุ) จึงสร้างให้ตอนนี้ */
async function queueAiForReleased(
  tx: DbOrTx,
  released: Array<{ incidentId: number; websiteId: number }>,
): Promise<void> {
  if (released.length === 0) return;
  await tx.execute(sql`
    INSERT INTO ai_analyses (incident_id)
    SELECT i.id FROM incidents i JOIN websites w ON w.id = i.website_id
    WHERE i.id IN (${sql.join(
      released.map((r) => sql`${r.incidentId}`),
      sql`, `,
    )}) AND w.ai_auto_analyze
    ON CONFLICT DO NOTHING
  `);
}

/** คิดต้นเหตุของ Incident ที่ "ล่มตามกัน" ใหม่ทุกรอบ maintenance — ต้นเหตุกลับมาแล้ว/เลิกพึ่งพาแล้วแต่หลุดการปล่อย */
export async function sweepStaleRootCauses(ctx: WorkerContext): Promise<number> {
  const settings = await ctx.settings();
  const aiReady = isAiReady(settings.ai, { apiKey: ctx.env.AI_API_KEY, baseUrl: ctx.env.AI_BASE_URL });
  const released = await ctx.db.transaction(async (tx) => {
    const r = await recheckRootCauses(tx);
    if (settings.ai.autoAnalyze && aiReady) await queueAiForReleased(tx, r);
    return r;
  });
  if (released.length > 0)
    ctx.log.warn("released incidents pointing at a recovered root cause", { count: released.length });
  return released.length;
}

export async function closeOrphanIncidents(db: Database): Promise<number> {
  const orphans = await db.execute<{ website_id: number; name: string; archived: boolean }>(sql`
    SELECT DISTINCT i.website_id, w.name, (w.archived_at IS NOT NULL) AS archived
    FROM incidents i JOIN websites w ON w.id = i.website_id
    WHERE i.recovered_at IS NULL AND (NOT w.enabled OR w.archived_at IS NOT NULL)
  `);
  for (const o of orphans.rows)
    await db.transaction((tx) =>
      closeIncidentsOfInactiveSite(
        tx,
        Number(o.website_id),
        o.archived ? `archive ${o.name}` : `ปิดการตรวจ ${o.name}`,
      ),
    );
  // แจ้งเตือนเชิงการทำงานของเว็บที่หยุดตรวจแล้ว ไม่มีอะไรมาปิดให้อัตโนมัติ
  await db.execute(sql`
    UPDATE security_alerts a SET acknowledged_at = now(), detail = coalesce(a.detail, '{}'::jsonb) || '{"autoResolved": true}'::jsonb
    FROM websites w
    WHERE w.id = a.website_id AND a.acknowledged_at IS NULL
      AND a.type IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE', 'JOURNEY_FAILED')
      AND (NOT w.enabled OR w.archived_at IS NOT NULL)
  `);
  return orphans.rows.length;
}
