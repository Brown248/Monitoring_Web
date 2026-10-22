import dns from "node:dns";
import net from "node:net";
import { baseDomain } from "../status/correlate";
import type { Fingerprint } from "../insights/changes";
import { diagnoseVerdict, type DiagnosisFacts, type DiagnosisVerdict } from "../insights/diagnose";
import { isBlockedIp } from "../ssrf/ip-policy";
import { checkTargetUrl } from "../ssrf/validate-url";
import { fetchBytesGuarded } from "./guarded-fetch";
import { inspectTls } from "./security-scan";

const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

function resolverFor(server: string): dns.promises.Resolver {
  const r = new dns.promises.Resolver({ timeout: 3_000, tries: 1 });
  r.setServers([server]);
  return r;
}

const errCode = (err: unknown) =>
  (err as { code?: string })?.code ?? (err instanceof Error ? err.message.slice(0, 120) : String(err));

async function systemLookup(host: string): Promise<{ addresses: string[]; error: string | null }> {
  if (net.isIP(host)) return { addresses: [host], error: null };
  try {
    const r = await dns.promises.lookup(host, { all: true });
    return { addresses: [...new Set(r.map((a) => a.address))], error: null };
  } catch (err) {
    return { addresses: [], error: errCode(err) };
  }
}

export async function publicLookup(
  host: string,
): Promise<{ addresses: string[]; error: string | null; resolver: string | null }> {
  if (net.isIP(host)) return { addresses: [host], error: null, resolver: null };
  let lastErr: string | null = null;
  for (const server of PUBLIC_RESOLVERS) {
    try {
      const r = resolverFor(server);
      const [v4, v6] = await Promise.all([
        r.resolve4(host).catch(() => [] as string[]),
        r.resolve6(host).catch(() => [] as string[]),
      ]);
      if (v4.length || v6.length) return { addresses: [...v4, ...v6], error: null, resolver: server };
      lastErr = "ENOTFOUND";
    } catch (err) {
      lastErr = errCode(err);
    }
  }
  return { addresses: [], error: lastErr, resolver: null };
}

function tcpConnect(
  ip: string,
  port: number,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; error: string | null; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port, timeout: timeoutMs });
    const done = (ok: boolean, error: string | null) => {
      s.removeAllListeners();
      s.destroy();
      resolve({ ok, error, ms: Math.round(performance.now() - t0) });
    };
    s.once("connect", () => done(true, null));
    s.once("timeout", () => done(false, "TIMEOUT"));
    s.once("error", (e) => done(false, errCode(e)));
  });
}

export function detectCdn(headers: Record<string, string | string[] | undefined>): string | null {
  const h = (n: string) => {
    const v = headers[n];
    return Array.isArray(v) ? v.join(",") : (v ?? "");
  };
  if (h("cf-ray") || /cloudflare/i.test(h("server"))) return "cloudflare";
  if (h("x-amz-cf-id")) return "cloudfront";
  if (h("x-vercel-id")) return "vercel";
  if (/akamai/i.test(h("server")) || h("x-akamai-transformed")) return "akamai";
  if (h("x-served-by") && /cache/i.test(h("x-served-by"))) return "fastly";
  return null;
}

/** ตัด control char (เช่น NUL — Postgres jsonb เก็บไม่ได้ ทำให้บันทึกล้มทั้งรอบ) */
const clean = (s: string | null | undefined): string | null =>
  // eslint-disable-next-line no-control-regex -- ตั้งใจตัด control char
  s ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") || null : null;
const one = (v: string | string[] | undefined) => clean((Array.isArray(v) ? v[0] : v) ?? null);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** ถอด HTML entity พื้นฐานใน title/meta (&amp; &#8211; &#x2013;) */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

async function httpProbe(url: string, opts: { allowPrivate?: boolean; timeoutMs?: number }) {
  const t0 = performance.now();
  try {
    const r = await fetchBytesGuarded(url, {
      maxBytes: 256 * 1024,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxRedirects: 5,
      accept: "text/html,application/xhtml+xml,*/*",
      allowPrivate: opts.allowPrivate,
    });
    const body = r.body.toString("utf8");
    return {
      status: r.status,
      ms: Math.round(performance.now() - t0),
      finalUrl: r.finalUrl,
      redirects: r.redirectChain.length,
      server: one(r.headers.server)?.slice(0, 120) ?? null,
      poweredBy: one(r.headers["x-powered-by"])?.slice(0, 120) ?? null,
      cdn: detectCdn(r.headers),
      title: clean(
        decodeEntities(/<title[^>]*>([^<]{0,200})<\/title>/i.exec(body)?.[1] ?? "")
          .trim()
          .replace(/\s+/g, " "),
      ),
      generator: clean(
        decodeEntities(
          /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{0,100})["']/i.exec(body)?.[1] ?? "",
        ),
      ),
      size: r.truncated ? null : r.body.length,
      error: null as string | null,
    };
  } catch (err) {
    return {
      status: null,
      ms: Math.round(performance.now() - t0),
      finalUrl: null,
      redirects: 0,
      server: null,
      poweredBy: null,
      cdn: null,
      title: null,
      generator: null,
      size: null,
      error: errCode(err),
    };
  }
}

/** NS ของโดเมน: ลอง resolver สาธารณะทีละตัว · ไม่มี record = [] · ถามไม่ได้ทุกตัว = null (ไม่รู้) */
async function resolveNsRobust(domain: string): Promise<string[] | null> {
  for (const server of PUBLIC_RESOLVERS) {
    try {
      return await resolverFor(server).resolveNs(domain);
    } catch (err) {
      if (["ENODATA", "ENOTFOUND"].includes(String((err as { code?: string })?.code))) return [];
    }
  }
  return null;
}

/** เก็บลายนิ้วมือของเว็บ: DNS (IP/CNAME/NS), ใบรับรอง และลักษณะของคำตอบ HTTP */
export async function collectFingerprint(
  url: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<Fingerprint> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const isIp = net.isIP(host) !== 0;
  const pub = resolverFor(PUBLIC_RESOLVERS[0]!);
  // CNAME: "ไม่มี record" = [] · หมดเวลา/ผิดพลาด = null (ไม่รู้) — ไม่งั้น DNS ช้าครั้งเดียวกลายเป็น "CNAME เปลี่ยน"
  const noRecord = (err: unknown) =>
    ["ENODATA", "ENOTFOUND"].includes(String((err as { code?: string })?.code));
  const [sys, cname, ns] = await Promise.all([
    systemLookup(host),
    isIp
      ? Promise.resolve([] as string[])
      : pub.resolveCname(host).catch((err: unknown) => (noRecord(err) ? ([] as string[]) : null)),
    isIp ? Promise.resolve([] as string[]) : resolveNsRobust(baseDomain(host)),
  ]);
  let tls: Fingerprint["tls"] = null;
  if (u.protocol === "https:") {
    try {
      const t = await inspectTls(host, Number(u.port || 443), { allowPrivate: opts.allowPrivate });
      tls = {
        issuer: t.issuer,
        validTo: t.validTo?.toISOString() ?? null,
        fingerprint: t.fingerprint ?? null,
        authError: t.authError,
        error: null,
      };
    } catch (err) {
      tls = { issuer: null, validTo: null, fingerprint: null, authError: null, error: errCode(err) };
    }
  }
  const h = await httpProbe(url, opts);
  return {
    dns: {
      ips: [...sys.addresses].sort(),
      cname: cname ? cname.sort() : [],
      cnameError: cname ? null : "TIMEOUT",
      ns: (ns ?? []).map((x) => x.toLowerCase()).sort(),
      // ถาม NS ไม่ได้ (หมดเวลา/ผิดพลาด) ≠ ไม่มี NS — ไม่งั้นรอบถัดไป NS ของผู้บุกรุกกลายเป็นค่าตั้งต้นแทนการแจ้งเตือน
      nsError: ns ? null : "TIMEOUT",
      error: sys.error,
    },
    tls,
    http: {
      status: h.status,
      finalUrl: h.finalUrl,
      redirects: h.redirects,
      server: h.server,
      poweredBy: h.poweredBy,
      cdn: h.cdn,
      title: h.title,
      generator: h.generator,
      size: h.size,
      error: h.error,
    },
  };
}

export interface DiagnosisStep {
  key: string;
  label: string;
  status: "ok" | "fail" | "warn" | "skip";
  detail: string;
  ms: number | null;
}

export interface DiagnosisResult {
  verdict: DiagnosisVerdict;
  steps: DiagnosisStep[];
  facts: DiagnosisFacts;
  durationMs: number;
}

/**
 * ไล่ตรวจทีละชั้น: เน็ตของ Worker → DNS (ระบบ + สาธารณะ) → TCP → TLS → HTTP แล้วสรุปผล
 * ทุกการเชื่อมต่อยังผ่านกฎ SSRF (ไม่ต่อไปยัง IP ภายในถ้าไม่ได้อนุญาต)
 */
export async function runDiagnosis(
  url: string,
  ctx: { canaryFailing: boolean; lastGoodIp: string | null; slowMs: number; allowPrivate?: boolean },
): Promise<DiagnosisResult> {
  const started = performance.now();
  const check = checkTargetUrl(url, { allowPrivate: ctx.allowPrivate });
  if (!check.ok) throw new Error(check.message);
  const u = check.url;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const scheme = u.protocol === "https:" ? "https" : "http";
  const port = Number(u.port || (scheme === "https" ? 443 : 80));
  const steps: DiagnosisStep[] = [];

  steps.push({
    key: "network",
    label: "เน็ตขาออกของ Worker",
    status: ctx.canaryFailing ? "fail" : "ok",
    detail: ctx.canaryFailing ? "เว็บอ้างอิงภายนอกก็เข้าไม่ได้" : "ออกอินเทอร์เน็ตได้ปกติ",
    ms: null,
  });

  let t = performance.now();
  const [dnsSystem, dnsPublic] = await Promise.all([systemLookup(host), publicLookup(host)]);
  const dnsMs = Math.round(performance.now() - t);
  steps.push({
    key: "dns",
    label: "DNS",
    status: dnsSystem.addresses.length ? "ok" : dnsPublic.addresses.length ? "warn" : "fail",
    detail: dnsSystem.addresses.length
      ? `${dnsSystem.addresses.slice(0, 3).join(", ")}${
          !dnsPublic.resolver
            ? ""
            : dnsPublic.addresses.some((ip) => dnsSystem.addresses.includes(ip))
              ? ` · DNS สาธารณะ (${dnsPublic.resolver}) ตอบตรงกัน`
              : ` · DNS สาธารณะ (${dnsPublic.resolver}) ตอบต่างกัน: ${dnsPublic.addresses.slice(0, 2).join(", ")}`
        }`
      : `DNS ของเครือข่าย: ${dnsSystem.error ?? "ไม่มีคำตอบ"} · DNS สาธารณะ: ${dnsPublic.addresses.length ? dnsPublic.addresses.slice(0, 2).join(", ") : (dnsPublic.error ?? "ไม่มีคำตอบ")}`,
    ms: dnsMs,
  });

  const target = dnsSystem.addresses.find((ip) => net.isIPv4(ip)) ?? dnsSystem.addresses[0] ?? null;
  // ระบบป้องกันปฏิเสธทั้งชื่อถ้ามี IP ภายในปนอยู่แม้ตัวเดียว (เช่น AAAA ภายใน) → ต้องรู้ตั้งแต่ตรงนี้
  // ไม่งั้นขั้นต่อไปล้มแล้วผลวินิจฉัยโทษ SSL/แอปผิดตัว
  const privateIp = !ctx.allowPrivate && dnsSystem.addresses.some((ip) => isBlockedIp(ip));

  let tcp: DiagnosisFacts["tcp"] = null;
  if (target && !privateIp) {
    tcp = await tcpConnect(target, port);
    steps.push({
      key: "tcp",
      label: `เชื่อมต่อ ${target}:${port}`,
      status: tcp.ok ? "ok" : "fail",
      detail: tcp.ok
        ? "เชื่อมต่อได้"
        : tcp.error === "TIMEOUT"
          ? "ไม่มีการตอบภายใน 5 วินาที"
          : `ถูกปฏิเสธ (${tcp.error})`,
      ms: tcp.ms,
    });
  } else {
    steps.push({
      key: "tcp",
      label: "เชื่อมต่อเซิร์ฟเวอร์",
      status: "skip",
      detail: privateIp ? "ข้าม — ปลายทางเป็น IP ภายใน" : "ข้าม — ไม่มี IP ให้เชื่อมต่อ",
      ms: null,
    });
  }

  let tls: DiagnosisFacts["tls"] = null;
  if (scheme === "https" && tcp?.ok) {
    t = performance.now();
    try {
      const info = await inspectTls(host, port, { allowPrivate: ctx.allowPrivate });
      const daysLeft = info.validTo ? Math.floor((info.validTo.getTime() - Date.now()) / 86_400_000) : null;
      tls = { ok: !info.authError, authError: info.authError, daysLeft, error: null };
      steps.push({
        key: "tls",
        label: "ใบรับรอง SSL",
        status:
          info.authError || (daysLeft !== null && daysLeft < 0)
            ? "fail"
            : daysLeft !== null && daysLeft < 14
              ? "warn"
              : "ok",
        detail: info.authError
          ? `ไม่ถูกต้อง: ${info.authError}`
          : `${info.issuer ?? "ไม่ทราบผู้ออก"} · หมดอายุอีก ${daysLeft ?? "?"} วัน · ${info.protocol ?? ""}`,
        ms: Math.round(performance.now() - t),
      });
    } catch (err) {
      tls = { ok: false, authError: null, daysLeft: null, error: errCode(err) };
      steps.push({
        key: "tls",
        label: "ใบรับรอง SSL",
        status: "fail",
        detail: `handshake ไม่สำเร็จ: ${errCode(err)}`,
        ms: null,
      });
    }
  } else if (scheme === "https") {
    steps.push({
      key: "tls",
      label: "ใบรับรอง SSL",
      status: "skip",
      detail: "ข้าม — ยังเชื่อมต่อไม่ได้",
      ms: null,
    });
  }

  let http: DiagnosisFacts["http"] = null;
  if (tcp?.ok && (scheme === "http" || tls?.ok)) {
    const h = await httpProbe(u.toString(), { allowPrivate: ctx.allowPrivate });
    http = { status: h.status, ms: h.ms, server: h.server, cdn: h.cdn, error: h.error };
    steps.push({
      key: "http",
      label: "คำตอบ HTTP",
      status:
        h.status === null
          ? "fail"
          : h.status >= 500
            ? "fail"
            : h.status >= 400
              ? "warn"
              : h.ms > ctx.slowMs
                ? "warn"
                : "ok",
      detail:
        h.status === null
          ? `ไม่ได้รับคำตอบ (${h.error})`
          : `HTTP ${h.status} · ${h.ms} ms${h.server ? ` · ${h.server}` : ""}${h.cdn && h.cdn !== h.server?.toLowerCase() ? ` · ผ่าน ${h.cdn}` : ""}`,
      ms: h.ms,
    });
  } else {
    steps.push({
      key: "http",
      label: "คำตอบ HTTP",
      status: "skip",
      detail: "ข้าม — ชั้นก่อนหน้ายังไม่ผ่าน",
      ms: null,
    });
  }

  const facts: DiagnosisFacts = {
    scheme,
    host,
    port,
    canaryFailing: ctx.canaryFailing,
    dnsSystem,
    dnsPublic,
    lastGoodIp: ctx.lastGoodIp,
    privateIp,
    tcp: tcp ? { ok: tcp.ok, error: tcp.error, ms: tcp.ms } : null,
    tls,
    http,
    slowMs: ctx.slowMs,
  };
  return {
    verdict: diagnoseVerdict(facts),
    steps,
    facts,
    durationMs: Math.round(performance.now() - started),
  };
}
