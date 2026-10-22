import http from "node:http";
import type { AddressInfo } from "node:net";
import { startGuardedProxy, type GuardedProxy } from "@app/core/server";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeJourney } from "./journeys";
import { findChromium } from "./visual";

// เว็บ login จำลองในเครื่อง — ไม่ใช้รหัสผ่านจริงของระบบใด
const TEST_USER = "tester";
const TEST_PASS = "local-test-only-pw";

const page = (body: string) =>
  `<!doctype html><html><head><title>Mock</title></head><body>${body}</body></html>`;

function mockServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/login") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const f = new URLSearchParams(data);
        const ok = f.get("username") === TEST_USER && f.get("password") === TEST_PASS;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          page(
            ok ? `<h1 id="dash">Dashboard</h1><p>ยินดีต้อนรับ</p>` : `<p class="err">Invalid credentials</p>`,
          ),
        );
      });
      return;
    }
    if (req.url === "/hang") {
      // หน้าเว็บที่ JavaScript วนไม่จบหลังโหลดเสร็จ — renderer ค้าง คำสั่งที่ไม่มี timeout จะรอตลอดไป
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        page(`<p>loading</p><script>addEventListener("load",()=>setTimeout(()=>{for(;;){}},50))</script>`),
      );
      return;
    }
    if (req.url === "/broken") {
      res.writeHead(500, { "content-type": "text/html" });
      res.end(page("oops"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      page(`<form method="post" action="/login">
        <input name="username"><input type="password" name="password">
        <button type="submit">Sign in</button></form>`),
    );
  });
}

const chromiumPath = findChromium(process.env.CHROMIUM_PATH);

describe.skipIf(!chromiumPath)("executeJourney (browser จริง + เว็บจำลอง)", () => {
  let server: http.Server;
  let base: string;
  let proxy: GuardedProxy;
  let browser: Browser;

  beforeAll(async () => {
    server = mockServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // ทดสอบผ่าน guarded proxy เหมือนของจริง (อนุญาต IP ภายในเฉพาะในเทสต์)
    proxy = await startGuardedProxy({ allowPrivate: true });
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await proxy?.close();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
  }, 15_000);

  const steps = () => [
    { action: "goto" as const, value: `${base}/` },
    { action: "fill" as const, selector: 'input[name="username"]', value: "secret:T_USER" },
    { action: "fill" as const, selector: 'input[type="password"]', value: "secret:T_PASS" },
    { action: "click" as const, selector: 'button[type="submit"]' },
    { action: "expectText" as const, value: "Dashboard" },
    { action: "expectNoText" as const, value: "Invalid" },
  ];

  it("login ถูกต้อง → ผ่านทุกขั้นตอน", async () => {
    const secrets: Record<string, string> = { T_USER: TEST_USER, T_PASS: TEST_PASS };
    const r = await executeJourney(browser, steps(), (n) => secrets[n]);
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.stepMs).toHaveLength(6);
    expect(r.screenshot).toBeNull();
  }, 60_000);

  it("รหัสผ่านผิด → ไม่ผ่านที่ขั้นที่ 5 + มีภาพหน้าจอ + ไม่มีรหัสผ่านใน error", async () => {
    const secrets: Record<string, string> = { T_USER: TEST_USER, T_PASS: "wrong-password-xyz" };
    const r = await executeJourney(browser, steps(), (n) => secrets[n]);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe(4);
    expect(r.error).toContain("Dashboard");
    expect(r.error).not.toContain("wrong-password-xyz");
    expect(r.screenshot?.length ?? 0).toBeGreaterThan(1000);
  }, 60_000);

  it("ไม่ได้ตั้ง secret ใน .env → บอกชื่อตัวแปรที่ต้องตั้ง", async () => {
    const r = await executeJourney(browser, steps(), () => undefined);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe(1);
    expect(r.error).toContain("JOURNEY_T_USER");
  }, 60_000);

  it("หน้าเว็บตอบ 500 → ไม่ผ่านตั้งแต่เปิดหน้า", async () => {
    const r = await executeJourney(browser, [{ action: "goto", value: `${base}/broken` }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 500");
  }, 60_000);

  it("หา selector ไม่เจอ → ข้อความอ่านง่าย", async () => {
    const r = await executeJourney(browser, [
      { action: "goto", value: `${base}/` },
      { action: "click", selector: "#does-not-exist" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ไม่พบ #does-not-exist");
  }, 60_000);

  it("guarded proxy ปกติ (ไม่อนุญาต IP ภายใน) บล็อกการเปิดเว็บภายใน", async () => {
    const strict = await startGuardedProxy();
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      proxy: { server: strict.url, bypass: "<-loopback>" },
    });
    try {
      const r = await executeJourney(b, [
        { action: "goto", value: `${base}/` },
        { action: "expectText", value: "Sign in" },
      ]);
      expect(r.ok).toBe(false);
      expect(strict.blocked.length).toBeGreaterThan(0);
    } finally {
      await b.close();
      await strict.close();
    }
  }, 60_000);
  it("หน้าเว็บค้าง (JavaScript วนไม่จบ) → จบภายในเส้นตาย ไม่ทำให้ Worker ค้าง", async () => {
    const t0 = Date.now();
    const r = await executeJourney(
      browser,
      [
        { action: "goto", value: `${base}/hang` },
        { action: "expectText", value: "never-appears" },
      ],
      undefined,
      { deadlineMs: 8_000 },
    );
    const took = Date.now() - t0;
    expect(r.ok).toBe(false);
    // ถ้าไม่มีเส้นตาย page.goto รอถึง 30 วินาที — ต้องจบเพราะเส้นตาย 8 วินาที (เผื่อปิด browser)
    expect(took).toBeLessThan(15_000);
    expect(r.error).toContain("เกิน 8 วินาที");
  }, 60_000);

  it("ไม่กรอกค่า secret บนโดเมนอื่น (กันส่งรหัสผ่านให้เว็บที่ไม่ใช่เว็บที่ทดสอบ)", async () => {
    let asked = 0;
    const r = await executeJourney(
      browser,
      [
        { action: "goto", value: `${base}/` },
        { action: "fill", selector: 'input[type="password"]', value: "secret:T_PASS" },
      ],
      () => {
        asked++;
        return TEST_PASS;
      },
      { allowedDomains: ["example.com"] },
    );
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe(1);
    expect(r.error).toContain("ไม่กรอกค่าลับบนโดเมน");
    expect(r.error).not.toContain(TEST_PASS);
    expect(asked).toBe(1);
  }, 60_000);

  it("secret ต้องผูกกับโดเมนของเว็บใน .env — ไม่ผูก หรือผูกกับเว็บอื่น ใช้ไม่ได้", async () => {
    const secrets: Record<string, string> = { T_USER: TEST_USER, T_PASS: TEST_PASS };
    const unbound = await executeJourney(browser, steps(), (n) => secrets[n], {
      allowedDomains: ["127.0.0.1"],
      secretDomains: () => [],
    });
    expect(unbound.ok).toBe(false);
    expect(unbound.error).toContain("JOURNEY_T_DOMAIN");
    // ผู้ดูแลเว็บตั้ง journey บนเว็บของตัวเอง แต่ใช้ secret ที่ผูกกับเว็บอื่น → ไม่กรอก
    const other = await executeJourney(browser, steps(), (n) => secrets[n], {
      allowedDomains: ["127.0.0.1"],
      secretDomains: () => ["bank.example.com"],
    });
    expect(other.ok).toBe(false);
    expect(other.error).toContain("ผูกไว้กับ bank.example.com");
    expect(other.error).not.toContain(TEST_PASS);
    const ok = await executeJourney(browser, steps(), (n) => secrets[n], {
      allowedDomains: ["127.0.0.1"],
      secretDomains: () => ["127.0.0.1"],
    });
    expect(ok.error).toBeNull();
  }, 90_000);

  it("กรอกค่า secret ได้เมื่ออยู่บนโดเมนที่อนุญาต", async () => {
    const secrets: Record<string, string> = { T_USER: TEST_USER, T_PASS: TEST_PASS };
    const r = await executeJourney(browser, steps(), (n) => secrets[n], { allowedDomains: ["127.0.0.1"] });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
  }, 60_000);
});
