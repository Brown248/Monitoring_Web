import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAttempt, runCheck } from "./http-check";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname) {
      case "/ok":
        res.writeHead(200).end("ok");
        return;
      case "/503":
        res.writeHead(503).end("down");
        return;
      case "/401":
        res.writeHead(401).end();
        return;
      case "/redirect":
        res.writeHead(302, { location: "/ok" }).end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" }).end();
        return;
      case "/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
        return;
      case "/slow":
        setTimeout(() => res.writeHead(200).end("late"), 1500);
        return;
      case "/flaky": {
        const n = Number(url.searchParams.get("n") ?? 0);
        flakyCount += 1;
        if (flakyCount <= n) res.writeHead(500).end();
        else res.writeHead(200).end();
        return;
      }
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let flakyCount = 0;
const cfg = (path: string, extra: Partial<Parameters<typeof runAttempt>[0]> = {}) => ({
  url: base + path,
  timeoutMs: 3000,
  followRedirects: true,
  maxRedirects: 3,
  upRanges: [{ from: 200, to: 399 }],
  treatAuthAsUp: false,
  allowPrivate: true,
  ...extra,
});

describe("runAttempt", () => {
  it("UP on 200 with timings", async () => {
    const r = await runAttempt(cfg("/ok"));
    expect(r).toMatchObject({
      ok: true,
      httpStatus: 200,
      errorCode: null,
      redirectCount: 0,
      remoteIp: "127.0.0.1",
    });
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(r.connectMs).not.toBeNull();
  });
  it("HTTP_STATUS on 503", async () => {
    const r = await runAttempt(cfg("/503"));
    expect(r).toMatchObject({ ok: false, httpStatus: 503, errorCode: "HTTP_STATUS" });
  });
  it("401 is UP only when treatAuthAsUp", async () => {
    expect((await runAttempt(cfg("/401"))).ok).toBe(false);
    expect((await runAttempt(cfg("/401", { treatAuthAsUp: true }))).ok).toBe(true);
  });
  it("follows redirects and keeps the first status", async () => {
    const r = await runAttempt(cfg("/redirect"));
    expect(r).toMatchObject({ ok: true, httpStatus: 200, firstHttpStatus: 302, redirectCount: 1 });
    expect(r.finalUrl).toBe(`${base}/ok`);
  });
  it("does not follow when disabled (3xx judged by status rules)", async () => {
    const r = await runAttempt(cfg("/redirect", { followRedirects: false }));
    expect(r).toMatchObject({ ok: true, httpStatus: 302, redirectCount: 0 });
  });
  it("TOO_MANY_REDIRECTS on a loop", async () => {
    const r = await runAttempt(cfg("/loop"));
    expect(r.errorCode).toBe("TOO_MANY_REDIRECTS");
  });
  it("rejects a redirect to the metadata endpoint even when the first hop is allowed", async () => {
    const r = await runAttempt({ ...cfg("/to-metadata"), allowPrivate: false });
    // hop แรก 127.0.0.1 ถูกปฏิเสธก่อน (ไม่ allowPrivate)
    expect(r.errorCode).toBe("SSRF_BLOCKED");
  });
  it("TIMEOUT when headers arrive too late", async () => {
    const r = await runAttempt(cfg("/slow", { timeoutMs: 1000 }));
    expect(r.errorCode).toBe("TIMEOUT");
  });
  it("CONNECTION_REFUSED on a closed port", async () => {
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const r = await runAttempt({ ...cfg("/"), url: `http://127.0.0.1:${port}/` });
    expect(r.errorCode).toBe("CONNECTION_REFUSED");
  });
  it("SSRF_BLOCKED for loopback by default (literal IP)", async () => {
    const r = await runAttempt({ ...cfg("/ok"), allowPrivate: false });
    expect(r.errorCode).toBe("SSRF_BLOCKED");
  });
  it("PRIVATE_TARGET when a hostname resolves only to loopback (checked at connect time)", async () => {
    const port = new URL(base).port;
    // "localhost." ผ่านการตรวจชื่อ แต่ถูก guarded lookup ปฏิเสธตอน resolve
    // ทุก IP เป็น IP ภายใน = DNS ชี้ผิด ผู้ใช้เข้าไม่ได้จริง → นับเป็นล่ม (ไม่ใช่ UNKNOWN)
    const r = await runAttempt({ ...cfg("/ok"), url: `http://localhost.:${port}/ok`, allowPrivate: false });
    expect(r.errorCode).toBe("PRIVATE_TARGET");
  });
});

describe("runCheck", () => {
  it("retries within the round and reports UP with retry count", async () => {
    flakyCount = 0;
    const { outcome, attempts } = await runCheck(
      {
        url: `${base}/flaky?n=1`,
        timeoutMs: 2000,
        followRedirects: true,
        maxRedirects: 3,
        treatAuthAsUp: false,
        allowPrivate: true,
        upStatusCodes: "200-399",
        retryCount: 2,
        retryDelayMs: 10,
        degradedThresholdMs: null,
      },
      { canaryFailing: false },
    );
    expect(attempts).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "UP", retries: 1 });
  });
  it("DOWN after all retries fail", async () => {
    const { outcome, attempts } = await runCheck(
      {
        url: `${base}/503`,
        timeoutMs: 2000,
        followRedirects: true,
        maxRedirects: 3,
        treatAuthAsUp: false,
        allowPrivate: true,
        upStatusCodes: "200-399",
        retryCount: 2,
        retryDelayMs: 10,
        degradedThresholdMs: null,
      },
      { canaryFailing: false },
    );
    expect(attempts).toHaveLength(3);
    expect(outcome).toMatchObject({ status: "DOWN", retries: 2, httpStatus: 503, errorCode: "HTTP_STATUS" });
  });
});
