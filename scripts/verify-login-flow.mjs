// ขั้นตอนจริงของผู้ดูแล (ใช้กับ server ที่ scripts/verify-env.mjs serve เปิดไว้):
//   login → เพิ่มเว็บไซต์ → เห็นในหน้า "เว็บไซต์" · เพิ่ม URL ภายใน (SSRF) ต้องถูกปฏิเสธ · รหัสผิดต้อง login ไม่ได้
// พิมพ์ "flow ok" เมื่อผ่านทุกขั้น · ล้มเหลว = exit 1 พร้อมบอกขั้นที่พัง
import { TEST_PASSWORD, TEST_USER } from "./verify-env.mjs";

const base = (process.env.BASE_URL || "http://127.0.0.1:3999").replace(/\/+$/, "");
const origin = new URL(base).origin;

function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}`);
  process.exit(1);
}

async function call(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + pathname, {
    method,
    redirect: "manual",
    headers: {
      origin,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(cookie && { cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { res, text: await res.text() };
}

const wrong = await call("/api/auth/login", {
  method: "POST",
  body: { username: TEST_USER, password: "not-the-password" },
});
if (wrong.res.status !== 401) fail("login with a wrong password", `status ${wrong.res.status}, expected 401`);

const login = await call("/api/auth/login", {
  method: "POST",
  body: { username: TEST_USER, password: TEST_PASSWORD },
});
if (login.res.status !== 200) fail("login", `status ${login.res.status}: ${login.text.slice(0, 200)}`);
const session = login.res.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .find((c) => c.startsWith("wm_session="));
if (!session) fail("login", "no wm_session cookie in the response");

const name = `verify-site-${Date.now()}`;
const form = {
  name,
  url: "https://example.com/",
  enabled: false,
  checkIntervalSeconds: 300,
  timeoutSeconds: 10,
  retryCount: 1,
  retryDelaySeconds: 5,
  confirmDownCount: 2,
  confirmRecoveryCount: 2,
  upStatusCodes: "200-399",
  degradedThresholdMs: null,
  treatAuthAsUp: false,
  followRedirects: true,
  alertEmails: [],
  sendRecovery: true,
  aiAutoAnalyze: false,
};
const created = await call("/api/websites", { method: "POST", body: form, cookie: session });
if (created.res.status !== 201)
  fail("add website", `status ${created.res.status}: ${created.text.slice(0, 300)}`);

const internal = await call("/api/websites", {
  method: "POST",
  body: { ...form, name: `${name}-internal`, url: "http://127.0.0.1/" },
  cookie: session,
});
if (internal.res.status !== 400)
  fail("add an internal-IP website (SSRF guard)", `status ${internal.res.status}, expected 400`);

const list = await call("/websites", { cookie: session });
if (list.res.status !== 200) fail("open the websites page", `status ${list.res.status}`);
if (!list.text.includes(name)) fail("open the websites page", `the new website ${name} is not listed`);

console.log("flow ok");
