import type { TLSSocket } from "node:tls";
import { Agent, buildConnector, request } from "undici";
import { checkTargetUrl } from "../ssrf/validate-url";
import { evaluateAttempts } from "../status/evaluate";
import { isUpStatus, parseUpStatusCodes, type StatusRange } from "../status/up-codes";
import type { AttemptResult, CheckErrorCode, CheckOutcome } from "../types";
import { createGuardedLookup } from "./guarded-lookup";

export const USER_AGENT = "WebMonitor/0.1 (+uptime-check)";
const MAX_DRAIN_BYTES = 64 * 1024;

export interface AttemptConfig {
  url: string;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  upRanges: StatusRange[];
  treatAuthAsUp: boolean;
  /** ใช้ในเทสต์เท่านั้น — อนุญาตปลายทาง private (worker/web ไม่ส่งค่านี้) */
  allowPrivate?: boolean;
}

export interface CheckConfig extends Omit<AttemptConfig, "upRanges"> {
  upStatusCodes: string;
  retryCount: number;
  retryDelayMs: number;
  degradedThresholdMs: number | null;
}

interface Timings {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  remoteIp: string | null;
  tlsValidTo: string | null;
}

/** Agent ใหม่ต่อ request: ไม่ reuse connection, ตรวจ IP ทุกครั้ง และเก็บ timing ของ DNS/TCP/TLS */
function createAgent(t: Timings, timeoutMs: number, allowPrivate: boolean): Agent {
  const lookup = createGuardedLookup({ allowPrivate, onResolved: (_a, ms) => (t.dnsMs = Math.round(ms)) });
  const base = buildConnector({ timeout: timeoutMs, lookup } as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (opts, cb) => {
    const t0 = performance.now();
    let tcpAt: number | null = null;
    const socket = base(opts, (err, sock) => {
      if (!err && sock) {
        const done = performance.now();
        t.remoteIp = sock.remoteAddress ?? null;
        if (opts.protocol === "https:") {
          t.tlsMs = Math.round(done - (tcpAt ?? t0));
          const cert = (sock as TLSSocket).getPeerCertificate?.();
          t.tlsValidTo = cert && cert.valid_to ? new Date(cert.valid_to).toISOString() : null;
        }
      }
      cb(err as Error, sock as never);
    });
    (socket as { once?: (ev: string, fn: () => void) => void } | undefined)?.once?.("connect", () => {
      tcpAt = performance.now();
      t.connectMs = Math.max(0, Math.round(tcpAt - t0 - (t.dnsMs ?? 0)));
    });
    return socket;
  };
  return new Agent({ connect, keepAliveTimeout: 1, connections: 1, pipelining: 0 });
}

/** หา error ใน cause chain (รวม AggregateError) ที่ตรงเงื่อนไข */
function findError(err: unknown, pred: (e: object) => boolean): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    if (pred(cur)) return true;
    const e = cur as { cause?: unknown; errors?: unknown };
    if (Array.isArray(e.errors) && e.errors.some((sub) => findError(sub, pred))) return true;
    cur = e.cause;
  }
  return false;
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const e = cur as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === "string") codes.push(e.code);
    if (typeof e.name === "string") codes.push(e.name);
    if (Array.isArray(e.errors)) for (const sub of e.errors) codes.push(...errorCodes(sub));
    cur = e.cause;
  }
  return codes;
}

function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[REDACTED]@").slice(0, 300);
}

export function classifyError(err: unknown, timeoutMs: number): { code: CheckErrorCode; message: string } {
  const codes = errorCodes(err);
  const has = (...c: string[]) => codes.some((x) => c.includes(x));
  const prefix = (...p: string[]) => codes.some((x) => p.some((pp) => x.startsWith(pp)));
  const secs = Math.round(timeoutMs / 1000);

  if (has("SSRF_BLOCKED")) {
    // DNS ชี้ไป IP ภายในทั้งหมด = ผู้ใช้ภายนอกเข้าเว็บไม่ได้จริง → นับเป็นล่ม (ไม่ใช่ "ไม่ทราบผล")
    const all = findError(err, (e) => (e as { allPrivate?: unknown }).allPrivate === true);
    return { code: all ? "PRIVATE_TARGET" : "SSRF_BLOCKED", message: safeMessage(err) };
  }
  if (has("UND_ERR_HEADERS_TIMEOUT"))
    return { code: "TIMEOUT", message: `HEADERS_TIMEOUT · ไม่ได้รับ response header ภายใน ${secs} วินาที` };
  if (has("UND_ERR_BODY_TIMEOUT"))
    return { code: "TIMEOUT", message: `BODY_TIMEOUT · อ่าน response ไม่เสร็จภายใน ${secs} วินาที` };
  if (has("UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"))
    return { code: "CONNECT_TIMEOUT", message: `CONNECT_TIMEOUT · เชื่อมต่อไม่สำเร็จภายใน ${secs} วินาที` };
  if (has("TimeoutError", "AbortError"))
    return { code: "TIMEOUT", message: `ไม่ได้รับ response ภายใน ${secs} วินาที` };
  if (has("ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA", "EAI_NONAME"))
    return { code: "DNS", message: codes.find((c) => c.startsWith("E")) ?? "resolve ไม่ได้" };
  if (has("ECONNREFUSED"))
    return { code: "CONNECTION_REFUSED", message: "ECONNREFUSED · ปลายทางปฏิเสธการเชื่อมต่อ" };
  if (
    prefix(
      "ERR_TLS",
      "ERR_SSL",
      "CERT_",
      "UNABLE_TO_",
      "DEPTH_ZERO",
      "SELF_SIGNED",
      "ERR_OSSL",
      "HOSTNAME_MISMATCH",
    )
  )
    return {
      code: "TLS",
      message: codes.find((c) => /TLS|SSL|CERT|UNABLE|SELF|DEPTH|OSSL/.test(c)) ?? safeMessage(err),
    };
  if (has("ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"))
    return { code: "CONNECTION_RESET", message: safeMessage(err) };
  return { code: "NETWORK", message: safeMessage(err) };
}

/** ยิง request หนึ่งครั้ง พร้อมตาม redirect แบบ manual และตรวจปลายทางทุก hop */
export async function runAttempt(cfg: AttemptConfig): Promise<AttemptResult> {
  const t: Timings = { dnsMs: null, connectMs: null, tlsMs: null, remoteIp: null, tlsValidTo: null };
  const started = performance.now();
  let current: URL;
  try {
    current = new URL(cfg.url);
  } catch {
    return fail("INTERNAL", "URL ไม่ถูกต้อง", null, 0, null);
  }
  let firstStatus: number | null = null;
  let hops = 0;

  function fail(
    code: CheckErrorCode,
    message: string,
    httpStatus: number | null,
    redirects: number,
    finalUrl: string | null,
    elapsed?: number,
  ): AttemptResult {
    return {
      ok: false,
      httpStatus,
      firstHttpStatus: firstStatus,
      responseTimeMs: elapsed ?? null,
      errorCode: code,
      errorMessage: message,
      finalUrl,
      redirectCount: redirects,
      ...t,
    };
  }

  for (;;) {
    const target = checkTargetUrl(current, { allowPrivate: cfg.allowPrivate });
    if (!target.ok) {
      const code: CheckErrorCode =
        hops === 0
          ? "SSRF_BLOCKED"
          : target.reason === "PRIVATE_IP" || target.reason === "LOCALHOST"
            ? // เว็บสาธารณะ redirect ไป localhost/IP ภายใน = ตั้งค่าเซิร์ฟเวอร์ผิด ผู้ใช้เข้าไม่ได้ → ล่ม
              "PRIVATE_REDIRECT"
            : "INVALID_REDIRECT";
      return fail(
        code,
        hops > 0 ? `Redirect hop ${hops}: ${target.message}` : target.message,
        firstStatus,
        hops,
        current.href,
      );
    }

    const agent = createAgent(t, cfg.timeoutMs, cfg.allowPrivate ?? false);
    try {
      const res = await request(current, {
        dispatcher: agent,
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
        headersTimeout: cfg.timeoutMs,
        bodyTimeout: cfg.timeoutMs,
        // เพดานรวมของ hop นี้ (connect + รอ header) — ปกติ undici จะ timeout ที่ headersTimeout ก่อน
        signal: AbortSignal.timeout(cfg.timeoutMs * 2),
      });
      const elapsed = Math.round(performance.now() - started);
      const status = res.statusCode;
      firstStatus ??= status;
      // ไม่ใช้ body — อ่านทิ้งแบบจำกัดขนาดเพื่อปิด connection ให้เรียบร้อย
      await res.body.dump({ limit: MAX_DRAIN_BYTES }).catch(() => undefined);

      const location = res.headers.location;
      if (cfg.followRedirects && status >= 300 && status < 400 && location) {
        hops += 1;
        if (hops > cfg.maxRedirects) {
          return fail(
            "TOO_MANY_REDIRECTS",
            `Redirect เกิน ${cfg.maxRedirects} hop`,
            status,
            hops - 1,
            current.href,
            elapsed,
          );
        }
        try {
          current = new URL(Array.isArray(location) ? location[0]! : location, current);
        } catch {
          return fail("INVALID_REDIRECT", "Location header ไม่ถูกต้อง", status, hops, current.href, elapsed);
        }
        continue;
      }

      const ok = isUpStatus(status, cfg.upRanges, cfg.treatAuthAsUp);
      return {
        ok,
        httpStatus: status,
        firstHttpStatus: firstStatus,
        responseTimeMs: elapsed,
        errorCode: ok ? null : "HTTP_STATUS",
        errorMessage: ok ? null : `HTTP ${status}`,
        finalUrl: current.href,
        redirectCount: hops,
        ...t,
      };
    } catch (err) {
      const { code, message } = classifyError(err, cfg.timeoutMs);
      const elapsed = Math.round(performance.now() - started);
      return fail(code, message, null, hops, current.href, code === "TIMEOUT" ? elapsed : undefined);
    } finally {
      agent.destroy().catch(() => undefined);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ตรวจหนึ่งรอบ: retry ภายในรอบ แล้วตัดสินเป็น UP / DOWN / UNKNOWN */
export async function runCheck(
  cfg: CheckConfig,
  opts: { canaryFailing: boolean },
): Promise<{ outcome: CheckOutcome; attempts: AttemptResult[] }> {
  const parsed = parseUpStatusCodes(cfg.upStatusCodes);
  const upRanges = parsed.ok ? parsed.ranges : [{ from: 200, to: 399 }];
  const startedAt = new Date();
  const attempts: AttemptResult[] = [];
  for (let i = 0; i <= cfg.retryCount; i++) {
    if (i > 0 && cfg.retryDelayMs > 0) await sleep(cfg.retryDelayMs);
    const a = await runAttempt({ ...cfg, upRanges });
    attempts.push(a);
    if (a.ok) break;
    // SSRF/URL ผิด ไม่มีประโยชน์ที่จะ retry
    if (
      a.errorCode === "SSRF_BLOCKED" ||
      a.errorCode === "PRIVATE_TARGET" ||
      a.errorCode === "PRIVATE_REDIRECT" ||
      a.errorCode === "INVALID_REDIRECT"
    )
      break;
  }
  const outcome = evaluateAttempts(attempts, {
    degradedThresholdMs: cfg.degradedThresholdMs,
    canaryFailing: opts.canaryFailing,
    startedAt,
    finishedAt: new Date(),
  });
  return { outcome, attempts };
}
