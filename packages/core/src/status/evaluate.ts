import { INDETERMINATE_ERROR_CODES, NETWORK_ERROR_CODES, PRIVATE_TARGET_CODES } from "../errors";
import type { AttemptResult, CheckOutcome, CheckStatus, IncidentTransition } from "../types";

export interface EvaluateOptions {
  degradedThresholdMs: number | null;
  /** canary ล้มเหลวอยู่ = เน็ตขาออกของ Worker มีปัญหา */
  canaryFailing: boolean;
  startedAt: Date;
  finishedAt: Date;
}

/** รวมผลทุก attempt ในรอบเดียวเป็น UP / DOWN / UNKNOWN */
export function evaluateAttempts(attempts: AttemptResult[], opts: EvaluateOptions): CheckOutcome {
  if (attempts.length === 0) throw new Error("evaluateAttempts requires at least one attempt");
  const successIndex = attempts.findIndex((a) => a.ok);
  const chosen = successIndex >= 0 ? attempts[successIndex]! : attempts[attempts.length - 1]!;

  let status: CheckStatus;
  if (successIndex >= 0) status = "UP";
  else if (chosen.errorCode && INDETERMINATE_ERROR_CODES.has(chosen.errorCode)) status = "UNKNOWN";
  else if (
    opts.canaryFailing &&
    chosen.errorCode &&
    (NETWORK_ERROR_CODES.has(chosen.errorCode) || PRIVATE_TARGET_CODES.has(chosen.errorCode))
  )
    status = "UNKNOWN";
  else status = "DOWN";

  const degraded =
    status === "UP" &&
    opts.degradedThresholdMs !== null &&
    chosen.responseTimeMs !== null &&
    chosen.responseTimeMs > opts.degradedThresholdMs;

  return {
    status,
    degraded,
    retries: successIndex >= 0 ? successIndex : attempts.length - 1,
    httpStatus: chosen.httpStatus,
    firstHttpStatus: chosen.firstHttpStatus,
    responseTimeMs: chosen.responseTimeMs,
    errorCode: status === "UP" ? null : chosen.errorCode,
    errorMessage: status === "UP" ? null : chosen.errorMessage,
    finalUrl: chosen.finalUrl,
    redirectCount: chosen.redirectCount,
    remoteIp: chosen.remoteIp,
    dnsMs: chosen.dnsMs,
    connectMs: chosen.connectMs,
    tlsMs: chosen.tlsMs,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
  };
}

export interface StreakState {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  hasOpenIncident: boolean;
}

export interface Thresholds {
  confirmDownCount: number;
  confirmRecoveryCount: number;
}

export interface TransitionResult {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  transition: IncidentTransition;
  /** สถานะที่แสดงบนหน้าเว็บ: DOWN เมื่อมี incident เปิดอยู่ */
  displayStatus: CheckStatus;
}

/**
 * กฎเปิด/ปิด Incident
 * - DOWN: นับล้มเหลวต่อเนื่อง ครบ confirmDownCount และยังไม่มี incident → open
 * - UP: นับสำเร็จต่อเนื่อง ครบ confirmRecoveryCount และมี incident → close
 * - UNKNOWN: ไม่นับทั้งสองฝั่ง (ไม่รู้ว่าปลายทางล่มจริงหรือไม่)
 */
export function nextTransition(state: StreakState, result: CheckStatus, t: Thresholds): TransitionResult {
  let failures = state.consecutiveFailures;
  let successes = state.consecutiveSuccesses;
  let transition: IncidentTransition = "none";

  if (result === "DOWN") {
    failures += 1;
    successes = 0;
    if (!state.hasOpenIncident && failures >= t.confirmDownCount) transition = "open";
  } else if (result === "UP") {
    successes += 1;
    failures = 0;
    if (state.hasOpenIncident && successes >= t.confirmRecoveryCount) transition = "close";
  }

  const openAfter = transition === "open" || (state.hasOpenIncident && transition !== "close");
  const displayStatus: CheckStatus = openAfter ? "DOWN" : result === "UNKNOWN" ? "UNKNOWN" : "UP";
  return { consecutiveFailures: failures, consecutiveSuccesses: successes, transition, displayStatus };
}
