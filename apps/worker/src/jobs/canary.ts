import { runAttempt } from "@app/core/server";
import { canaryResults, logEvent } from "@app/db";
import type { WorkerContext } from "../context";

let inFlight: Promise<void> | null = null;

/**
 * ยิงปลายทางที่ "ต้องตอบได้เสมอ" เพื่อรู้ว่าเน็ตขาออกของ Worker ยังปกติ
 * เรียกพร้อมกันหลายที่ (รอบปกติ + ตรวจซ้ำก่อนตัดสินว่าเว็บล่ม) ใช้ผลรอบเดียวกัน — ไม่บันทึกเหตุการณ์ซ้ำ
 */
export function runCanary(ctx: WorkerContext): Promise<void> {
  inFlight ??= runCanaryOnce(ctx).finally(() => (inFlight = null));
  return inFlight;
}

async function runCanaryOnce(ctx: WorkerContext): Promise<void> {
  const urls = ctx.env.canaryUrls;
  if (urls.length === 0) {
    ctx.canary.failing = false;
    ctx.canary.checkedAt = new Date();
    return;
  }
  const results = await Promise.all(
    urls.map(async (url) => {
      const r = await runAttempt({
        url,
        timeoutMs: 5_000,
        followRedirects: true,
        maxRedirects: 3,
        upRanges: [{ from: 200, to: 499 }],
        treatAuthAsUp: true,
      });
      return {
        url,
        ok: r.httpStatus !== null,
        ms: r.responseTimeMs,
        error: r.httpStatus === null ? r.errorMessage : null,
      };
    }),
  );
  await ctx.db
    .insert(canaryResults)
    .values(results.map((r) => ({ target: r.url, ok: r.ok, responseTimeMs: r.ms, error: r.error })));
  const failing = results.every((r) => !r.ok);
  if (failing && !ctx.canary.failing) {
    await logEvent(ctx.db, {
      type: "CANARY_FAILED",
      level: "WARN",
      message: `Canary check ล้มเหลวทุกปลายทาง — ผลตรวจที่ล้มเหลวจากเครือข่ายจะเป็น UNKNOWN`,
      detail: results.map((r) => `${r.url}: ${r.error ?? "ok"}`).join("\n"),
    });
    ctx.log.warn("canary failing", { results: results.map((r) => ({ url: r.url, error: r.error })) });
  } else if (!failing && ctx.canary.failing) {
    await logEvent(ctx.db, {
      type: "CANARY_RECOVERED",
      level: "SUCCESS",
      message: "Canary check กลับมาผ่านแล้ว",
    });
  }
  ctx.canary.failing = failing;
  ctx.canary.checkedAt = new Date();
}
