import dns from "node:dns/promises";
import { isIP } from "node:net";
import { classifyIp } from "../ssrf/ip-policy";
import { checkTargetUrl } from "../ssrf/validate-url";
import { parseUpStatusCodes } from "../status/up-codes";
import { runAttempt } from "./http-check";

export interface UrlTestStep {
  key: "format" | "dns" | "ip" | "response" | "tls";
  label: string;
  ok: boolean;
  detail: string;
}

export interface UrlTestResult {
  ok: boolean;
  testedAt: string;
  steps: UrlTestStep[];
}

export interface UrlTestOptions {
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  upStatusCodes?: string;
  treatAuthAsUp?: boolean;
}

/** ทดสอบ URL ก่อนบันทึก: รูปแบบ → DNS → IP เป็น public → ยิงจริง 1 ครั้ง → ใบรับรอง TLS */
export async function testUrl(raw: string, opts: UrlTestOptions = {}): Promise<UrlTestResult> {
  const steps: UrlTestStep[] = [];
  const done = (): UrlTestResult => ({
    ok: steps.length > 0 && steps.every((s) => s.ok),
    testedAt: new Date().toISOString(),
    steps,
  });

  const target = checkTargetUrl(raw);
  if (!target.ok) {
    steps.push({ key: "format", label: "รูปแบบ URL ไม่ผ่าน", ok: false, detail: target.message });
    return done();
  }
  const { url, port } = target;
  steps.push({
    key: "format",
    label: "รูปแบบ URL ถูกต้อง",
    ok: true,
    detail: `${url.protocol.replace(":", "")} · port ${port} · ไม่มี credential`,
  });

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
    steps.push({ key: "dns", label: "เป็น IP โดยตรง", ok: true, detail: host });
  } else {
    try {
      const res = await dns.lookup(host, { all: true });
      addresses = res.map((r) => r.address);
      steps.push({
        key: "dns",
        label: "DNS resolve ได้",
        ok: true,
        detail: addresses.slice(0, 3).join(", "),
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "ERROR";
      steps.push({ key: "dns", label: "DNS resolve ไม่ได้", ok: false, detail: code });
      return done();
    }
  }

  const privateIp = addresses.find((a) => classifyIp(a) !== "public");
  if (privateIp) {
    steps.push({
      key: "ip",
      label: "IP เป็น private / reserved",
      ok: false,
      detail: `${privateIp} — ระบบจะปฏิเสธการเชื่อมต่อ`,
    });
    return done();
  }
  steps.push({
    key: "ip",
    label: "IP เป็น public",
    ok: true,
    detail: "ไม่ใช่ private / loopback / link-local",
  });

  const parsed = parseUpStatusCodes(opts.upStatusCodes ?? "200-399");
  const attempt = await runAttempt({
    url: url.href,
    timeoutMs: opts.timeoutMs ?? 10_000,
    followRedirects: opts.followRedirects ?? true,
    maxRedirects: opts.maxRedirects ?? 3,
    upRanges: parsed.ok ? parsed.ranges : [{ from: 200, to: 399 }],
    treatAuthAsUp: opts.treatAuthAsUp ?? false,
  });

  if (attempt.httpStatus !== null && attempt.errorCode !== "TOO_MANY_REDIRECTS") {
    const redirect = attempt.redirectCount > 0 ? `redirect ${attempt.redirectCount} hop` : "ไม่มี redirect";
    steps.push({
      key: "response",
      label: attempt.ok ? "ได้รับ response" : "ได้รับ response แต่ status ไม่อยู่ในเกณฑ์ UP",
      ok: attempt.ok,
      detail: `HTTP ${attempt.httpStatus} · ${attempt.responseTimeMs ?? "—"} ms · ${redirect}`,
    });
  } else {
    steps.push({
      key: "response",
      label: "ไม่ได้รับ response",
      ok: false,
      detail: attempt.errorMessage ?? "ไม่ทราบสาเหตุ",
    });
  }

  if (url.protocol === "https:") {
    if (attempt.errorCode === "TLS") {
      steps.push({
        key: "tls",
        label: "ใบรับรอง TLS ใช้ไม่ได้",
        ok: false,
        detail: attempt.errorMessage ?? "",
      });
    } else if (attempt.tlsValidTo) {
      const validTo = new Date(attempt.tlsValidTo);
      const days = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
      steps.push({
        key: "tls",
        label: days < 14 ? "ใบรับรอง TLS ใกล้หมดอายุ" : "ใบรับรอง TLS ใช้ได้",
        ok: days >= 0,
        detail: `หมดอายุ ${validTo.toISOString().slice(0, 10)} (อีก ${days} วัน)`,
      });
    }
  }
  return done();
}
