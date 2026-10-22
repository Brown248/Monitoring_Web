import { causeLabel, urlForAi } from "@app/core";
import { AiError, analyze, buildIncidentPrompt, effectiveModel, isAiReady } from "@app/core/server";
import {
  aiAnalyses,
  canaryResults,
  checkResults,
  desc,
  eq,
  finishAiCall,
  gte,
  incidents,
  logEvent,
  reserveAiCall,
  sql,
  websites,
  and,
  lte,
} from "@app/db";
import type { WorkerContext } from "../context";

const MAX_AI_ATTEMPTS = 3;

export async function monthlyAiCalls(ctx: WorkerContext): Promise<number> {
  const res = await ctx.db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ai_calls WHERE at >= date_trunc('month', now())`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** วิเคราะห์ incident ที่รอคิว (ทีละรายการ) */
export async function processAiJobs(ctx: WorkerContext): Promise<void> {
  // งานที่ค้าง RUNNING นานเกิน 10 นาที (worker ตายระหว่างทำ) → กลับไปรอคิว
  await ctx.db.execute(
    sql`UPDATE ai_analyses SET status = 'PENDING' WHERE status = 'RUNNING' AND requested_at < now() - interval '10 minutes'`,
  );

  const claimed = await ctx.db.execute<{ id: number; incident_id: number; attempts: number }>(sql`
    WITH next AS (
      SELECT id FROM ai_analyses WHERE status = 'PENDING' AND requested_at <= now()
      ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE ai_analyses a SET status = 'RUNNING', attempts = a.attempts + 1, requested_at = now()
    FROM next WHERE a.id = next.id
    RETURNING a.id, a.incident_id, a.attempts
  `);
  const job = claimed.rows[0];
  if (!job) return;
  const jobId = Number(job.id);
  const incidentId = Number(job.incident_id);
  const attempt = Number(job.attempts);

  const settings = await ctx.settings();
  const aiEnv = { apiKey: ctx.env.AI_API_KEY, baseUrl: ctx.env.AI_BASE_URL };
  const fail = async (message: string, retry: boolean) => {
    const again = retry && attempt < MAX_AI_ATTEMPTS;
    await ctx.db
      .update(aiAnalyses)
      .set(
        again
          ? { status: "PENDING", error: message, requestedAt: new Date(Date.now() + 2 * 60_000 * attempt) }
          : { status: "FAILED", error: message, completedAt: new Date() },
      )
      .where(eq(aiAnalyses.id, jobId));
    if (!again) {
      await logEvent(ctx.db, {
        type: "AI_FAILED",
        level: "ERROR",
        incidentId,
        message: "AI วิเคราะห์ไม่สำเร็จ",
        detail: message,
      });
    }
  };

  if (!isAiReady(settings.ai, aiEnv))
    return fail("ยังไม่ได้ตั้งค่า AI (provider / model / AI_API_KEY)", false);
  if (settings.ai.monthlyLimit > 0 && (await monthlyAiCalls(ctx)) >= settings.ai.monthlyLimit)
    return fail(`ใช้ครบโควตาเดือนนี้แล้ว (${settings.ai.monthlyLimit} ครั้ง)`, false);

  const [inc] = await ctx.db
    .select({
      id: incidents.id,
      websiteId: incidents.websiteId,
      startedAt: incidents.startedAt,
      confirmedAt: incidents.confirmedAt,
      recoveredAt: incidents.recoveredAt,
      cause: incidents.cause,
      failedCheckCount: incidents.failedCheckCount,
      name: websites.name,
      url: websites.url,
    })
    .from(incidents)
    .innerJoin(websites, eq(websites.id, incidents.websiteId))
    .where(eq(incidents.id, incidentId));
  if (!inc) return fail("ไม่พบ Incident", false);

  const until = inc.recoveredAt ?? new Date();
  const checks = await ctx.db
    .select()
    .from(checkResults)
    .where(and(eq(checkResults.websiteId, inc.websiteId), lte(checkResults.checkedAt, until)))
    .orderBy(desc(checkResults.checkedAt))
    .limit(12);
  const avg = await ctx.db.execute<{ avg: string | null }>(sql`
    SELECT avg(response_time_ms)::text AS avg FROM check_results
    WHERE website_id = ${inc.websiteId} AND status = 'UP' AND checked_at >= ${new Date(inc.startedAt.getTime() - 86_400_000)} AND checked_at < ${inc.startedAt}
  `);
  const canary = await ctx.db
    .select({ ok: canaryResults.ok })
    .from(canaryResults)
    .where(
      and(
        gte(canaryResults.at, new Date(inc.startedAt.getTime() - 10 * 60_000)),
        lte(canaryResults.at, until),
      ),
    );
  const canaryOk = canary.filter((c) => c.ok).length;

  const prompt = buildIncidentPrompt(
    {
      websiteName: inc.name,
      url: urlForAi(inc.url),
      cause: inc.cause,
      startedAt: inc.startedAt.toISOString(),
      confirmedAt: inc.confirmedAt.toISOString(),
      recoveredAt: inc.recoveredAt?.toISOString() ?? null,
      failedCheckCount: inc.failedCheckCount,
      canarySummary:
        canary.length === 0
          ? "no canary data"
          : `${canaryOk}/${canary.length} canary probes succeeded during the incident window`,
      avgResponseMs24h: avg.rows[0]?.avg ? Math.round(Number(avg.rows[0].avg)) : null,
      checks: checks.map((c) => ({
        at: c.checkedAt.toISOString(),
        status: c.degraded ? "DEGRADED" : c.status,
        httpStatus: c.httpStatus,
        responseTimeMs: c.responseTimeMs,
        retries: c.retries,
        errorCode: c.errorCode ? causeLabel(c.errorCode, c.httpStatus) : null,
        errorMessage: c.errorMessage,
        dnsMs: c.dnsMs,
        connectMs: c.connectMs,
        tlsMs: c.tlsMs,
        redirectCount: c.redirectCount,
      })),
    },
    settings.ai.thai,
  );

  const model = effectiveModel(settings.ai);
  // จองโควตาตอนจะเรียกจริง (ตรวจด้านบนเป็นแค่ทางลัด) — นับรวมกับคำถามจากหน้าเว็บที่เกิดพร้อมกัน
  const callId = await reserveAiCall(ctx.db, {
    provider: settings.ai.provider,
    model: model || null,
    monthlyLimit: settings.ai.monthlyLimit,
  });
  if (callId === null) return fail(`ใช้ครบโควตาเดือนนี้แล้ว (${settings.ai.monthlyLimit} ครั้ง)`, false);
  let result: Awaited<ReturnType<typeof analyze>>;
  try {
    result = await analyze(settings.ai, aiEnv, prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishAiCall(ctx.db, callId, { success: false, error: message });
    ctx.log.warn("ai analysis failed", { incidentId, attempt, error: message });
    return fail(message, err instanceof AiError ? err.retryable : true);
  }
  // เรียกสำเร็จแล้ว — บันทึกผลครั้งเดียว (เดิม: บันทึกผลลัพธ์ล้ม → นับเป็นการเรียกที่ล้มเหลวซ้ำอีกแถว)
  await finishAiCall(ctx.db, callId, { success: true });
  try {
    await ctx.db
      .update(aiAnalyses)
      .set({
        status: "DONE",
        provider: settings.ai.provider,
        model,
        summary: result.summary,
        facts: result.facts,
        possibleCauses: result.possibleCauses,
        nextSteps: result.nextSteps,
        inputCheckCount: checks.length,
        error: null,
        completedAt: new Date(),
      })
      .where(eq(aiAnalyses.id, jobId));
    await logEvent(ctx.db, {
      type: "AI_DONE",
      level: "INFO",
      incidentId,
      websiteId: inc.websiteId,
      message: "AI วิเคราะห์เสร็จ",
      detail: `ส่งข้อมูลผลตรวจ ${checks.length} รายการล่าสุด (กรอง secret แล้ว)`,
    });
  } catch (err) {
    // AI ตอบแล้ว แต่บันทึกผลไม่ได้ (ฐานข้อมูลมีปัญหา) — ไม่นับการเรียก AI ซ้ำ
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.warn("ai analysis save failed", { incidentId, attempt, error: message });
    // ไม่ลองใหม่: ลองใหม่ = เรียก AI ซ้ำและใช้โควตาซ้ำทั้งที่ได้คำตอบมาแล้ว
    await fail(`บันทึกผลวิเคราะห์ไม่สำเร็จ: ${message}`, false);
  }
}
