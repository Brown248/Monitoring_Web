import { isIP } from "node:net";
import { isBlockedIp } from "./ip-policy";

export type UrlCheck =
  | { ok: true; url: URL; port: number; isIpLiteral: boolean }
  | { ok: false; reason: "INVALID" | "SCHEME" | "CREDENTIALS" | "PRIVATE_IP" | "LOCALHOST"; message: string };

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * ตรวจ URL ก่อนเชื่อมต่อทุก hop:
 * - http/https เท่านั้น, ห้ามมี username/password
 * - host ที่เป็น IP literal ต้องตรวจที่นี่ เพราะ net.connect ไม่เรียก lookup เมื่อ host เป็น IP
 *   (hostname ปกติถูกตรวจซ้ำตอน DNS resolve ใน guarded lookup)
 */
export function checkTargetUrl(raw: string | URL, policy: { allowPrivate?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return { ok: false, reason: "INVALID", message: "รูปแบบ URL ไม่ถูกต้อง" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "SCHEME", message: `Scheme ที่ไม่รองรับ (${url.protocol.replace(":", "")})` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "CREDENTIALS", message: "มี username/password ใน URL" };
  }
  const host = stripBrackets(url.hostname);
  if (!host) return { ok: false, reason: "INVALID", message: "ไม่มี hostname" };
  const lower = host.toLowerCase();
  if (!policy.allowPrivate && (lower === "localhost" || lower.endsWith(".localhost"))) {
    return { ok: false, reason: "LOCALHOST", message: "localhost ไม่อนุญาต" };
  }
  const isIpLiteral = isIP(host) !== 0;
  if (!policy.allowPrivate && isIpLiteral && isBlockedIp(host)) {
    return { ok: false, reason: "PRIVATE_IP", message: `IP ภายในหรือสงวนไว้ (${host})` };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { ok: true, url, port, isIpLiteral };
}
