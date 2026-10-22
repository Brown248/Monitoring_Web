import { describe, expect, it } from "vitest";
import type { AttemptResult } from "../types";
import { evaluateAttempts, nextTransition } from "./evaluate";
import { isUpStatus, parseUpStatusCodes } from "./up-codes";

const base: AttemptResult = {
  ok: false,
  httpStatus: null,
  firstHttpStatus: null,
  responseTimeMs: null,
  errorCode: null,
  errorMessage: null,
  finalUrl: null,
  redirectCount: 0,
  remoteIp: null,
  dnsMs: null,
  connectMs: null,
  tlsMs: null,
  tlsValidTo: null,
};
const opts = {
  degradedThresholdMs: 1500,
  canaryFailing: false,
  startedAt: new Date(),
  finishedAt: new Date(),
};

describe("parseUpStatusCodes", () => {
  it("parses ranges and singles", () => {
    const r = parseUpStatusCodes("200-299, 401");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isUpStatus(204, r.ranges, false)).toBe(true);
      expect(isUpStatus(401, r.ranges, false)).toBe(true);
      expect(isUpStatus(302, r.ranges, false)).toBe(false);
    }
  });
  it("rejects invalid input", () => {
    expect(parseUpStatusCodes("").ok).toBe(false);
    expect(parseUpStatusCodes("abc").ok).toBe(false);
    expect(parseUpStatusCodes("399-200").ok).toBe(false);
    expect(parseUpStatusCodes("700").ok).toBe(false);
  });
  it("treats 401/403 as up when enabled", () => {
    const r = parseUpStatusCodes("200-399");
    if (!r.ok) throw new Error("parse failed");
    expect(isUpStatus(403, r.ranges, true)).toBe(true);
    expect(isUpStatus(403, r.ranges, false)).toBe(false);
  });
});

describe("evaluateAttempts", () => {
  it("is UP when any attempt succeeds and records retries", () => {
    const out = evaluateAttempts(
      [
        { ...base, errorCode: "TIMEOUT" },
        { ...base, ok: true, httpStatus: 200, responseTimeMs: 200 },
      ],
      opts,
    );
    expect(out.status).toBe("UP");
    expect(out.retries).toBe(1);
    expect(out.errorCode).toBeNull();
    expect(out.degraded).toBe(false);
  });
  it("marks slow successes as degraded", () => {
    const out = evaluateAttempts([{ ...base, ok: true, httpStatus: 200, responseTimeMs: 1840 }], opts);
    expect(out.status).toBe("UP");
    expect(out.degraded).toBe(true);
  });
  it("is DOWN when every attempt fails", () => {
    const out = evaluateAttempts(
      [
        { ...base, errorCode: "HTTP_STATUS", httpStatus: 503 },
        { ...base, errorCode: "HTTP_STATUS", httpStatus: 503 },
      ],
      opts,
    );
    expect(out.status).toBe("DOWN");
    expect(out.retries).toBe(1);
    expect(out.httpStatus).toBe(503);
  });
  it("is UNKNOWN for network errors while the canary is failing", () => {
    const out = evaluateAttempts([{ ...base, errorCode: "DNS" }], { ...opts, canaryFailing: true });
    expect(out.status).toBe("UNKNOWN");
  });
  it("HTTP errors stay DOWN even when the canary fails", () => {
    const out = evaluateAttempts([{ ...base, errorCode: "HTTP_STATUS", httpStatus: 500 }], {
      ...opts,
      canaryFailing: true,
    });
    expect(out.status).toBe("DOWN");
  });
  it("is DOWN when the site points only at private IPs — but UNKNOWN while the canary fails (captive portal)", () => {
    expect(evaluateAttempts([{ ...base, errorCode: "PRIVATE_TARGET" }], opts).status).toBe("DOWN");
    expect(evaluateAttempts([{ ...base, errorCode: "PRIVATE_REDIRECT" }], opts).status).toBe("DOWN");
    // เน็ตของ Worker ถูกจับไปหน้า login ของเราเตอร์ → ทุกเว็บดูเหมือนชี้ไป 192.168.x — ไม่ใช่เว็บล่ม
    for (const code of ["PRIVATE_TARGET", "PRIVATE_REDIRECT"] as const)
      expect(evaluateAttempts([{ ...base, errorCode: code }], { ...opts, canaryFailing: true }).status).toBe(
        "UNKNOWN",
      );
  });
  it("is UNKNOWN when blocked by the SSRF guard", () => {
    expect(evaluateAttempts([{ ...base, errorCode: "SSRF_BLOCKED" }], opts).status).toBe("UNKNOWN");
  });
});

describe("nextTransition", () => {
  const t = { confirmDownCount: 2, confirmRecoveryCount: 2 };
  it("opens an incident only after N consecutive failures", () => {
    const s0 = { consecutiveFailures: 0, consecutiveSuccesses: 3, hasOpenIncident: false };
    const r1 = nextTransition(s0, "DOWN", t);
    expect(r1).toMatchObject({
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      transition: "none",
      displayStatus: "UP",
    });
    const r2 = nextTransition({ ...s0, ...r1 }, "DOWN", t);
    expect(r2).toMatchObject({ consecutiveFailures: 2, transition: "open", displayStatus: "DOWN" });
  });
  it("does not open twice", () => {
    const r = nextTransition(
      { consecutiveFailures: 5, consecutiveSuccesses: 0, hasOpenIncident: true },
      "DOWN",
      t,
    );
    expect(r.transition).toBe("none");
    expect(r.displayStatus).toBe("DOWN");
  });
  it("closes after N consecutive successes", () => {
    const s = { consecutiveFailures: 4, consecutiveSuccesses: 0, hasOpenIncident: true };
    const r1 = nextTransition(s, "UP", t);
    expect(r1).toMatchObject({ transition: "none", displayStatus: "DOWN", consecutiveSuccesses: 1 });
    const r2 = nextTransition({ ...s, ...r1 }, "UP", t);
    expect(r2).toMatchObject({ transition: "close", displayStatus: "UP" });
  });
  it("UNKNOWN keeps counters and does not transition", () => {
    const s = { consecutiveFailures: 1, consecutiveSuccesses: 0, hasOpenIncident: false };
    expect(nextTransition(s, "UNKNOWN", t)).toMatchObject({
      consecutiveFailures: 1,
      transition: "none",
      displayStatus: "UNKNOWN",
    });
  });
  it("a success in between resets the failure streak", () => {
    const s = { consecutiveFailures: 1, consecutiveSuccesses: 0, hasOpenIncident: false };
    const r = nextTransition(s, "UP", t);
    expect(nextTransition({ ...s, ...r }, "DOWN", t).transition).toBe("none");
  });
});
