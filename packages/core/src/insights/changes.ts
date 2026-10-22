// ลายนิ้วมือของเว็บ + การเทียบหาความเปลี่ยนแปลง (isomorphic)

export interface Fingerprint {
  dns: {
    ips: string[];
    cname: string[];
    ns: string[];
    error: string | null;
    cnameError?: string | null;
    /** ถาม NS ไม่ได้รอบนี้ (ns ว่างเพราะไม่รู้ ไม่ใช่เพราะไม่มี) */
    nsError?: string | null;
  };
  tls: {
    issuer: string | null;
    validTo: string | null;
    fingerprint: string | null;
    authError: string | null;
    error: string | null;
  } | null;
  http: {
    status: number | null;
    finalUrl: string | null;
    redirects: number;
    server: string | null;
    poweredBy: string | null;
    cdn: string | null;
    title: string | null;
    generator: string | null;
    size: number | null;
    error: string | null;
  };
}

export type ChangeSeverity = "high" | "medium" | "low" | "info";

export interface SiteChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
  severity: ChangeSeverity;
}

const list = (v: string[]) => (v.length ? [...v].sort().join(", ") : "—");
/** URL โดยไม่มี query/hash — state=, session id ฯลฯ เปลี่ยนทุกครั้งเป็นเรื่องปกติ */
const pathOnly = (u: string | null) => {
  if (!u) return u;
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return u;
  }
};

/** ลายนิ้วมือที่อ่านมาจากฐานข้อมูลมีโครงสร้างครบไหม (ข้อมูลเก่า/เสียหาย = เริ่มเก็บใหม่ ไม่ crash) */
export function isFingerprint(v: unknown): v is Fingerprint {
  const f = v as Fingerprint | null;
  return Boolean(
    f && typeof f === "object" && f.dns && Array.isArray(f.dns.ips) && f.http && typeof f.http === "object",
  );
}
const statusClass = (s: number | null) => (s === null ? null : Math.floor(s / 100));

/**
 * เทียบลายนิ้วมือ 2 ครั้ง → รายการสิ่งที่เปลี่ยน
 * ข้ามส่วนที่ครั้งใดครั้งหนึ่งเก็บไม่ได้ (error) เพื่อไม่ให้ "เว็บล่ม" กลายเป็นการเปลี่ยนแปลงปลอม
 */
export function diffFingerprints(prev: Fingerprint, next: Fingerprint): SiteChange[] {
  const out: SiteChange[] = [];
  const add = (
    field: string,
    label: string,
    a: string | null,
    b: string | null,
    severity: ChangeSeverity,
  ) => {
    if ((a ?? "") !== (b ?? "")) out.push({ field, label, oldValue: a, newValue: b, severity });
  };
  const cdn = next.http.cdn ?? prev.http.cdn;

  if (!prev.dns.error && !next.dns.error) {
    // IP ของ CDN สลับได้เป็นปกติ · DNS แบบหมุนเวียน (ยังมี IP ซ้ำกับชุดเดิม) ก็ปกติ → ความสำคัญต่ำ
    // ย้ายไปชุด IP ใหม่ทั้งหมด (ไม่มี CDN) = ย้ายเซิร์ฟเวอร์ → ควรตรวจ
    const overlap = prev.dns.ips.some((ip) => next.dns.ips.includes(ip));
    add(
      "dns.ips",
      "IP ปลายทาง (DNS)",
      list(prev.dns.ips),
      list(next.dns.ips),
      cdn || overlap ? "low" : "medium",
    );
    if (!prev.dns.cnameError && !next.dns.cnameError)
      add("dns.cname", "CNAME", list(prev.dns.cname), list(next.dns.cname), "medium");
    if (!prev.dns.nsError && !next.dns.nsError && prev.dns.ns.length && next.dns.ns.length)
      add("dns.ns", "Nameserver ของโดเมน", list(prev.dns.ns), list(next.dns.ns), "high");
  }

  if (prev.tls && next.tls && !prev.tls.error && !next.tls.error) {
    add("tls.issuer", "ผู้ออกใบรับรอง SSL", prev.tls.issuer, next.tls.issuer, "medium");
    if (prev.tls.fingerprint !== next.tls.fingerprint) {
      const renewed =
        prev.tls.validTo && next.tls.validTo && new Date(next.tls.validTo) > new Date(prev.tls.validTo);
      // ใบรับรองเดิม (อายุสั้นกว่า) จากผู้ออกเดียวกัน = เซิร์ฟเวอร์หลายตัวใช้ใบคนละรุ่น สลับกันตอบ → เรื่องเล็ก
      const sameIssuerOlder = !renewed && prev.tls.issuer === next.tls.issuer;
      out.push({
        field: "tls.cert",
        label: renewed
          ? "ต่ออายุใบรับรอง SSL"
          : sameIssuerOlder
            ? "ใบรับรอง SSL สลับระหว่างเซิร์ฟเวอร์"
            : "เปลี่ยนใบรับรอง SSL",
        oldValue: prev.tls.validTo ? `หมดอายุ ${prev.tls.validTo.slice(0, 10)}` : null,
        newValue: next.tls.validTo ? `หมดอายุ ${next.tls.validTo.slice(0, 10)}` : null,
        severity: renewed ? "info" : sameIssuerOlder ? "low" : "medium",
      });
    }
    add(
      "tls.valid",
      "ความถูกต้องของใบรับรอง",
      prev.tls.authError ?? "ถูกต้อง",
      next.tls.authError ?? "ถูกต้อง",
      "high",
    );
  } else if (Boolean(prev.tls) !== Boolean(next.tls) && !prev.tls?.error && !next.tls?.error) {
    add("tls.enabled", "การใช้ HTTPS", prev.tls ? "เปิด" : "ปิด", next.tls ? "เปิด" : "ปิด", "high");
  }

  if (!prev.http.error && !next.http.error) {
    if (statusClass(prev.http.status) !== statusClass(next.http.status))
      add("http.status", "HTTP status", String(prev.http.status), String(next.http.status), "medium");
    add(
      "http.finalUrl",
      "URL ปลายทางหลัง redirect",
      pathOnly(prev.http.finalUrl),
      pathOnly(next.http.finalUrl),
      "medium",
    );
    add("http.server", "Server header (ซอฟต์แวร์/เวอร์ชัน)", prev.http.server, next.http.server, "low");
    add("http.poweredBy", "X-Powered-By", prev.http.poweredBy, next.http.poweredBy, "low");
    add("http.cdn", "CDN / ผู้ให้บริการด้านหน้า", prev.http.cdn, next.http.cdn, "medium");
    add("http.generator", "เวอร์ชัน CMS", prev.http.generator, next.http.generator, "low");
    add("http.title", "หัวข้อหน้าเว็บ (title)", prev.http.title, next.http.title, "low");
    if (prev.http.size && next.http.size) {
      const ratio = next.http.size / prev.http.size;
      if (ratio > 1.5 || ratio < 0.5)
        out.push({
          field: "http.size",
          label: "ขนาดหน้าเว็บเปลี่ยนมาก",
          oldValue: `${Math.round(prev.http.size / 1024)} KB`,
          newValue: `${Math.round(next.http.size / 1024)} KB`,
          severity: "low",
        });
    }
  }
  return out;
}
