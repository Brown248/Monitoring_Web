import { isIP } from "node:net";
import tls from "node:tls";
import { checkTargetUrl } from "../ssrf/validate-url";
import { fetchBytesGuarded } from "./guarded-fetch";
import { createGuardedLookup } from "./guarded-lookup";

export type FindingSeverity = "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  fix: string;
}

export interface TlsInfo {
  validTo: Date | null;
  issuer: string | null;
  protocol: string | null;
  /** null = ใบรับรองถูกต้อง, ไม่งั้นเป็นรหัสปัญหา เช่น CERT_HAS_EXPIRED */
  authError: string | null;
  /** SHA-256 ของใบรับรอง — ใช้ตรวจว่ามีการเปลี่ยนใบรับรอง */
  fingerprint?: string | null;
}

export interface ScanInput {
  url: string;
  page: {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    finalUrl: string;
  } | null;
  pageError: string | null;
  /** ผลของ http:// (ไม่ตาม redirect) — null ถ้าเว็บเป็น http อยู่แล้วหรือเชื่อมต่อไม่ได้ */
  httpProbe: { status: number; location: string | null } | null;
  tls: TlsInfo | null;
  tlsError: string | null;
  exposed: Array<{ path: string; status: number; body: string }>;
  now: Date;
}

export interface ScanResult {
  score: number;
  grade: string;
  findings: Finding[];
}

/** ไฟล์/หน้าที่ไม่ควรเปิดสู่สาธารณะ — นับว่า "หลุด" เฉพาะเมื่อเนื้อหาตรงลักษณะจริง (กัน soft-404) */
export const EXPOSURE_PROBES: Array<{ path: string; label: string; match: (body: string) => boolean }> = [
  {
    path: "/.env",
    label: "ไฟล์ .env (มักมีรหัสผ่านฐานข้อมูล/API key)",
    match: (b) => !/<html|<!doctype/i.test(b) && /^[A-Z][A-Z0-9_]{2,}\s*=/m.test(b),
  },
  {
    path: "/.git/HEAD",
    label: "โฟลเดอร์ .git (ดาวน์โหลด source code ได้)",
    match: (b) => /^ref: refs\//.test(b.trim()),
  },
  { path: "/.git/config", label: "ไฟล์ .git/config", match: (b) => /^\[core\]/m.test(b) },
  { path: "/.DS_Store", label: "ไฟล์ .DS_Store (เปิดเผยรายชื่อไฟล์)", match: (b) => b.includes("Bud1") },
  {
    path: "/server-status",
    label: "หน้า Apache server-status",
    match: (b) => /Apache Server Status/i.test(b),
  },
  {
    path: "/phpinfo.php",
    label: "หน้า phpinfo()",
    match: (b) => /<title>\s*(phpinfo\(\)|PHP \d)/i.test(b) || /PHP Version \d+\.\d+/.test(b),
  },
  {
    path: "/wp-config.php.bak",
    label: "ไฟล์สำรอง wp-config (มีรหัสผ่านฐานข้อมูล)",
    match: (b) => /DB_PASSWORD/.test(b),
  },
];

const WEIGHT: Record<FindingSeverity, number> = { high: 25, medium: 10, low: 4, info: 0 };

function header(h: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = h[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(", ") : v;
}

export function gradeFor(score: number, hasHigh: boolean): string {
  const g = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  // มีปัญหาร้ายแรงอย่างน้อย 1 ข้อ → ได้ไม่เกิน C
  return hasHigh && (g === "A" || g === "B") ? "C" : g;
}

/** วิเคราะห์ผลที่เก็บมา → รายการปัญหา + คะแนน (ฟังก์ชันบริสุทธิ์ ทดสอบได้) */
export function analyzeSecurity(input: ScanInput): ScanResult {
  const f: Finding[] = [];
  const isHttps = new URL(input.page?.finalUrl ?? input.url).protocol === "https:";

  // ---- HTTPS / TLS ----
  if (!isHttps && !input.tls) {
    f.push({
      id: "NO_HTTPS",
      severity: "high",
      title: "ไม่รองรับ HTTPS",
      detail: "ข้อมูลระหว่างผู้ใช้กับเว็บถูกส่งแบบไม่เข้ารหัส ดักอ่าน/แก้ไขได้",
      fix: "ติดตั้งใบรับรอง SSL (เช่น Let's Encrypt ฟรี) แล้วบังคับใช้ HTTPS",
    });
  } else if (!isHttps) {
    f.push({
      id: "NOT_USING_HTTPS",
      severity: "medium",
      title: "เว็บรองรับ HTTPS แต่ยังเปิดหน้าแบบ HTTP",
      detail: "URL ที่ตั้งไว้/ปลายทางสุดท้ายยังเป็น http://",
      fix: "Redirect ทุกคำขอ http:// ไป https:// และอัปเดตลิงก์ให้เป็น https",
    });
  }
  if (input.httpProbe) {
    const loc = input.httpProbe.location ?? "";
    const redirectsToHttps =
      input.httpProbe.status >= 300 &&
      input.httpProbe.status < 400 &&
      loc.toLowerCase().startsWith("https://");
    if (!redirectsToHttps) {
      f.push({
        id: "HTTP_NO_REDIRECT",
        severity: "medium",
        title: "http:// ไม่ redirect ไป https://",
        detail: `เปิดด้วย http:// ได้ status ${input.httpProbe.status}${loc ? ` → ${loc}` : ""}`,
        fix: "ตั้ง web server ให้ตอบ 301 ไปยัง https:// ทุกคำขอ",
      });
    }
  }
  if (input.tls) {
    const t = input.tls;
    if (t.authError) {
      f.push({
        id: "TLS_INVALID",
        severity: "high",
        title: "ใบรับรอง SSL ไม่ถูกต้อง",
        detail: `browser จะขึ้นหน้าเตือน: ${t.authError}`,
        fix: "ตรวจว่าใบรับรองออกให้ชื่อโดเมนนี้, ครบ chain และยังไม่หมดอายุ",
      });
    }
    if (t.validTo) {
      const days = Math.floor((t.validTo.getTime() - input.now.getTime()) / 86_400_000);
      if (days < 0) {
        f.push({
          id: "TLS_EXPIRED",
          severity: "high",
          title: "ใบรับรอง SSL หมดอายุแล้ว",
          detail: `หมดอายุเมื่อ ${-days} วันก่อน`,
          fix: "ต่ออายุใบรับรองทันที และเปิดการต่ออายุอัตโนมัติ",
        });
      } else if (days < 30) {
        f.push({
          id: "TLS_EXPIRING",
          severity: days < 14 ? "high" : "medium",
          title: `ใบรับรอง SSL จะหมดอายุใน ${days} วัน`,
          detail: `หมดอายุ ${t.validTo.toISOString().slice(0, 10)}${t.issuer ? ` · ออกโดย ${t.issuer}` : ""}`,
          fix: "ต่ออายุใบรับรองก่อนหมดอายุ (หรือเปิด auto-renew)",
        });
      }
    }
    if (t.protocol && /^TLSv1(\.0|\.1)?$/.test(t.protocol)) {
      f.push({
        id: "TLS_OLD_PROTOCOL",
        severity: "medium",
        title: `ใช้โปรโตคอลเก่า ${t.protocol}`,
        detail: "TLS 1.0/1.1 ถูกเลิกใช้แล้วและมีช่องโหว่ที่รู้จัก",
        fix: "เปิดเฉพาะ TLS 1.2 และ 1.3",
      });
    }
  }

  // ---- Security headers ----
  if (input.page) {
    const h = input.page.headers;
    if (isHttps && !header(h, "strict-transport-security")) {
      f.push({
        id: "HSTS_MISSING",
        severity: "medium",
        title: "ไม่มี HSTS",
        detail: "browser อาจถูกหลอกให้เปิดเว็บผ่าน http:// ที่ไม่เข้ารหัส",
        fix: "เพิ่ม header Strict-Transport-Security: max-age=31536000; includeSubDomains",
      });
    }
    const csp = header(h, "content-security-policy");
    if (!csp) {
      f.push({
        id: "CSP_MISSING",
        severity: "low",
        title: "ไม่มี Content-Security-Policy",
        detail: "ไม่มีชั้นป้องกันเพิ่มเติมเมื่อมีช่องโหว่ XSS หรือสคริปต์ถูกฝัง",
        fix: "เพิ่ม Content-Security-Policy ที่จำกัดแหล่งสคริปต์ (เริ่มจาก Report-Only ก่อน)",
      });
    }
    if (header(h, "x-content-type-options")?.toLowerCase() !== "nosniff") {
      f.push({
        id: "XCTO_MISSING",
        severity: "low",
        title: "ไม่มี X-Content-Type-Options: nosniff",
        detail: "browser อาจเดาชนิดไฟล์เอง ทำให้ไฟล์ที่อัปโหลดถูกรันเป็นสคริปต์",
        fix: "เพิ่ม header X-Content-Type-Options: nosniff",
      });
    }
    if (!header(h, "x-frame-options") && !/frame-ancestors/i.test(csp ?? "")) {
      f.push({
        id: "CLICKJACKING",
        severity: "low",
        title: "หน้าเว็บถูกฝังใน iframe ของเว็บอื่นได้",
        detail: "เสี่ยงต่อ clickjacking (หลอกให้คลิกปุ่มในหน้าเว็บที่ซ่อนอยู่)",
        fix: "เพิ่ม X-Frame-Options: SAMEORIGIN หรือ CSP frame-ancestors 'self'",
      });
    }
    if (!header(h, "referrer-policy")) {
      f.push({
        id: "REFERRER_POLICY_MISSING",
        severity: "info",
        title: "ไม่มี Referrer-Policy",
        detail: "URL เต็ม (อาจมีข้อมูลใน query string) ถูกส่งต่อให้เว็บปลายทางที่ลิงก์ไป",
        fix: "เพิ่ม Referrer-Policy: strict-origin-when-cross-origin",
      });
    }
    const server = header(h, "server");
    const powered = header(h, "x-powered-by");
    if ((server && /\d/.test(server)) || powered) {
      f.push({
        id: "VERSION_DISCLOSURE",
        severity: "low",
        title: "เปิดเผยชนิด/เวอร์ชันซอฟต์แวร์ของเซิร์ฟเวอร์",
        detail: [server && `Server: ${server}`, powered && `X-Powered-By: ${powered}`]
          .filter(Boolean)
          .join(" · "),
        fix: "ซ่อนเวอร์ชันใน header (เช่น nginx server_tokens off, PHP expose_php = Off)",
      });
    }
    const cookies = h["set-cookie"];
    const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    const weak = list
      .map((c) => ({ name: c.split("=")[0]!.trim(), attrs: c.toLowerCase() }))
      // ทุก cookie บน HTTPS ควรมี Secure · HttpOnly บังคับเฉพาะ cookie ที่ดูเป็น session/token
      // (cookie อื่นอาจตั้งใจให้ JavaScript อ่านได้ เช่น ค่าธีม/analytics)
      .filter(
        (c) =>
          (isHttps && !/;\s*secure/.test(c.attrs)) ||
          (/sess|sid|auth|token|login|jwt/i.test(c.name) && !/;\s*httponly/.test(c.attrs)),
      );
    if (weak.length > 0) {
      f.push({
        id: "COOKIE_FLAGS",
        severity: "medium",
        title: "Cookie ไม่ได้ตั้ง Secure / HttpOnly",
        detail: `cookie: ${weak
          .map((c) => c.name)
          .slice(0, 5)
          .join(", ")}`,
        fix: "ตั้ง Secure และ HttpOnly (และ SameSite) ให้ cookie ทุกตัว โดยเฉพาะ session",
      });
    }

    // ---- เนื้อหา ----
    const body = input.page.body;
    if (/<title>\s*Index of \//i.test(body)) {
      f.push({
        id: "DIRECTORY_LISTING",
        severity: "medium",
        title: "เปิด Directory listing",
        detail: "ใครก็เห็นรายชื่อไฟล์ทั้งหมดในโฟลเดอร์",
        fix: "ปิด autoindex / Options -Indexes และใส่หน้า index",
      });
    }
    if (isHttps) {
      const mixed = [
        ...body.matchAll(/<(script|iframe|link|img)\b[^>]*\b(?:src|href)\s*=\s*["']http:\/\/([^"'/]+)/gi),
      ].map((m) => `${m[1]!.toLowerCase()} จาก ${m[2]}`);
      if (mixed.length > 0) {
        f.push({
          id: "MIXED_CONTENT",
          severity: mixed.some((m) => !m.startsWith("img")) ? "medium" : "low",
          title: "หน้า HTTPS โหลดไฟล์ผ่าน HTTP (mixed content)",
          detail: [...new Set(mixed)].slice(0, 4).join(", "),
          fix: "เปลี่ยนลิงก์ทรัพยากรทั้งหมดเป็น https://",
        });
      }
    }
    const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(body)?.[1];
    if (gen && /\d/.test(gen)) {
      f.push({
        id: "CMS_VERSION",
        severity: "low",
        title: `เปิดเผยเวอร์ชัน CMS (${gen.slice(0, 60)})`,
        detail: "ผู้โจมตีใช้เวอร์ชันเพื่อหาช่องโหว่ที่ตรงกันได้ทันที",
        fix: "ซ่อน meta generator และอัปเดต CMS/ปลั๊กอินให้เป็นเวอร์ชันล่าสุดเสมอ",
      });
    }
  }

  // ---- ไฟล์ที่หลุด ----
  for (const e of input.exposed) {
    const probe = EXPOSURE_PROBES.find((p) => p.path === e.path);
    if (probe && e.status === 200 && probe.match(e.body)) {
      f.push({
        id: `EXPOSED:${e.path}`,
        severity: "high",
        title: `เข้าถึง ${e.path} ได้จากภายนอก`,
        detail: probe.label,
        fix: `บล็อกการเข้าถึง ${e.path} ที่ web server และลบไฟล์ออกจากโฟลเดอร์ที่เปิดสู่สาธารณะ — ถ้ามีรหัสผ่านอยู่ ให้เปลี่ยนรหัสทันที`,
      });
    }
  }

  const score = Math.max(0, 100 - f.reduce((s, x) => s + WEIGHT[x.severity], 0));
  const order: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    score,
    grade: gradeFor(
      score,
      f.some((x) => x.severity === "high"),
    ),
    findings: f,
  };
}

/** อ่านใบรับรองผ่าน guarded lookup (ไม่ต่อไปยัง IP ภายใน) */
export function inspectTls(
  host: string,
  port: number,
  opts: { timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<TlsInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false, // อ่านใบรับรองแม้ไม่ถูกต้อง แล้วรายงานผ่าน authorizationError
      lookup: createGuardedLookup({ allowPrivate: opts.allowPrivate }),
      timeout: opts.timeoutMs ?? 8_000,
    });
    const done = (fn: () => void) => {
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert?.issuer ? (cert.issuer.O ?? cert.issuer.CN ?? null) : null;
      const info: TlsInfo = {
        validTo: cert?.valid_to ? new Date(cert.valid_to) : null,
        issuer: Array.isArray(issuer) ? issuer.join(", ") : issuer,
        protocol: socket.getProtocol(),
        authError: socket.authorized ? null : String(socket.authorizationError ?? "UNKNOWN"),
        fingerprint: cert?.fingerprint256 ?? null,
      };
      done(() => resolve(info));
    });
    socket.once("timeout", () => done(() => reject(new Error("TLS timeout"))));
    socket.once("error", (err) => done(() => reject(err)));
  });
}

/**
 * สแกนแบบ passive: เปิดหน้าแรก 1 ครั้ง, ลอง http://, อ่านใบรับรอง และขอไฟล์ที่ไม่ควรหลุด ~7 ไฟล์
 * ทุกคำขอผ่าน SSRF guard และไม่ส่งข้อมูลใด ๆ (ไม่ใช่การทดสอบเจาะระบบ)
 */
export async function runSecurityScan(
  url: string,
  opts: { allowPrivate?: boolean; now?: Date } = {},
): Promise<ScanResult & { tlsValidTo: Date | null }> {
  const check = checkTargetUrl(url, { allowPrivate: opts.allowPrivate });
  if (!check.ok) throw new Error(check.message);
  const target = check.url;
  const fetchOpts = { allowPrivate: opts.allowPrivate };

  let page: ScanInput["page"] = null;
  let pageError: string | null = null;
  try {
    const r = await fetchBytesGuarded(target.toString(), {
      ...fetchOpts,
      maxBytes: 512 * 1024,
      accept: "text/html,application/xhtml+xml",
      maxRedirects: 5,
    });
    page = { status: r.status, headers: r.headers, body: r.body.toString("utf8"), finalUrl: r.finalUrl };
  } catch (err) {
    pageError = err instanceof Error ? err.message : String(err);
  }
  // หน้า 5xx มาจาก proxy/หน้า error ของเซิร์ฟเวอร์ ไม่ใช่เว็บจริง — header ความปลอดภัยไม่ครบเสมอ ให้เกรดไปก็ผิด
  if (page && page.status >= 500)
    throw new Error(`หน้าเว็บตอบ HTTP ${page.status} — ไม่ให้เกรด (จะสแกนใหม่เมื่อเว็บกลับมาปกติ)`);

  const host = target.hostname.replace(/^\[|\]$/g, "");
  let tlsInfo: TlsInfo | null = null;
  let tlsError: string | null = null;
  try {
    tlsInfo = await inspectTls(
      host,
      target.protocol === "https:" ? Number(target.port || 443) : 443,
      fetchOpts,
    );
  } catch (err) {
    tlsError = err instanceof Error ? err.message : String(err);
  }

  let httpProbe: ScanInput["httpProbe"] = null;
  if (target.protocol === "https:" && !target.port) {
    try {
      const r = await fetchBytesGuarded(`http://${target.host}/`, {
        ...fetchOpts,
        maxBytes: 1024,
        followRedirects: false,
      });
      const loc = r.headers.location;
      httpProbe = {
        status: r.status,
        location: typeof loc === "string" ? new URL(loc, `http://${target.host}/`).toString() : null,
      };
    } catch {
      httpProbe = null; // ไม่เปิดพอร์ต 80 เลย = ไม่ใช่ปัญหา
    }
  }

  const origin = new URL(page?.finalUrl ?? target.toString()).origin;
  const exposed: ScanInput["exposed"] = [];
  for (const p of EXPOSURE_PROBES) {
    try {
      const r = await fetchBytesGuarded(origin + p.path, {
        ...fetchOpts,
        maxBytes: 4096,
        followRedirects: false,
        timeoutMs: 6_000,
      });
      exposed.push({ path: p.path, status: r.status, body: r.body.toString("latin1") });
    } catch {
      /* เข้าไม่ได้ = ดี */
    }
  }

  if (!page && !tlsInfo) throw new Error(pageError ?? tlsError ?? "เชื่อมต่อเว็บไม่ได้");
  const result = analyzeSecurity({
    url: target.toString(),
    page,
    pageError,
    httpProbe,
    tls: tlsInfo,
    tlsError,
    exposed,
    now: opts.now ?? new Date(),
  });
  return { ...result, tlsValidTo: tlsInfo?.validTo ?? null };
}
