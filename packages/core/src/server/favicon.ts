import { fetchBytesGuarded } from "./guarded-fetch";

const MAX_HTML_BYTES = 512 * 1024;
export const MAX_ICON_BYTES = 128 * 1024;

/** ดูชนิดรูปจาก magic bytes — ไม่เชื่อ Content-Type ของปลายทาง */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.readUInt32BE(0) === 0x00000100) return "image/x-icon";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).trimStart().toLowerCase();
  if (
    (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) &&
    !head.includes("<script")
  )
    return "image/svg+xml";
  return null;
}

/** รูป PNG/GIF ขนาด ≤ 2px (pixel ติดตาม/ตัวยึดที่) — ใช้เป็นโลโก้ไม่ได้ */
export function tinyImage(buf: Buffer, type: string): boolean {
  let w = 0;
  let h = 0;
  if (type === "image/png" && buf.length >= 24) {
    w = buf.readUInt32BE(16);
    h = buf.readUInt32BE(20);
  } else if (type === "image/gif" && buf.length >= 10) {
    w = buf.readUInt16LE(6);
    h = buf.readUInt16LE(8);
  } else return false;
  return w <= 2 || h <= 2;
}

/**
 * หา <link rel="icon"> จาก HTML · apple-touch-icon มาก่อน — มักเป็นโลโก้ความละเอียดสูง (180px)
 * ส่วน favicon.ico/16px ดูแตกเมื่อแสดงใหญ่
 */
export function parseIconLinks(html: string, baseUrl: string): string[] {
  const found: Array<{ href: string; rank: number }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!rel || !value) continue;
    const rels = rel.split(/\s+/);
    // apple-touch-icon-precomposed = ชื่อเก่าของ apple-touch-icon (เว็บรุ่นเก่ายังใช้)
    const rank = rels.some((r) => r.startsWith("apple-touch-icon")) ? 0 : rels.includes("icon") ? 1 : -1;
    if (rank < 0) continue;
    try {
      const u = new URL(value.replace(/&amp;/g, "&"), baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") found.push({ href: u.toString(), rank });
    } catch {
      /* href เสีย — ข้าม */
    }
  }
  return [...new Set(found.sort((a, b) => a.rank - b.rank).map((f) => f.href))];
}

/**
 * รูปโลโก้ในหน้าเว็บ (<img> ที่ class/id/alt/src มีคำว่า logo/brand) — ใช้เมื่อเว็บไม่มี favicon เลย
 * เช่น หน้า dashboard ที่ไม่ได้ใส่ favicon แต่มีโลโก้บริษัทที่หัวหน้า
 */
export function parseLogoImages(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    // lazy-load: src มักเป็นรูปตัวยึดที่ (1×1/data:) ตัวจริงอยู่ใน data-src / srcset
    const attr = (name: string) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
      return m?.[1] ?? m?.[2] ?? m?.[3];
    };
    const srcset = attr("data-srcset") ?? attr("srcset");
    const fromSet = srcset?.split(",")[0]?.trim().split(/\s+/)[0];
    const value = [attr("data-src"), fromSet, attr("src")].find((s) => s && !s.startsWith("data:"));
    if (!value) continue;
    const attrs = [/\bclass\s*=\s*["']([^"']*)/i, /\bid\s*=\s*["']([^"']*)/i, /\balt\s*=\s*["']([^"']*)/i]
      .map((re) => re.exec(tag)?.[1] ?? "")
      .join(" ");
    if (!/logo|brand/i.test(`${attrs} ${value}`)) continue;
    try {
      const u = new URL(value.replace(/&amp;/g, "&"), baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(u.toString());
    } catch {
      /* src เสีย — ข้าม */
    }
  }
  return [...new Set(out)].slice(0, 2);
}

export interface FaviconResult {
  contentType: string;
  body: Buffer;
  sourceUrl: string;
}

/** ดึง favicon ของเว็บ: อ่าน <link rel=icon> จากหน้าแรกก่อน แล้วค่อยลอง /favicon.ico */
export async function fetchFavicon(
  siteUrl: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<FaviconResult | null> {
  const candidates: string[] = [];
  let logos: string[] = [];
  let base = siteUrl;
  try {
    const page = await fetchBytesGuarded(siteUrl, {
      maxBytes: MAX_HTML_BYTES,
      accept: "text/html,application/xhtml+xml",
      allowPrivate: opts.allowPrivate,
    });
    base = page.finalUrl;
    if (page.status < 400 && (page.contentType ?? "").includes("html")) {
      const html = page.body.toString("utf8");
      candidates.push(...parseIconLinks(html, base));
      logos = parseLogoImages(html, base);
    }
  } catch {
    /* หน้าแรกโหลดไม่ได้ — ยังลอง /favicon.ico ได้ */
  }
  candidates.push(new URL("/favicon.ico", base).toString());
  // ไม่มี favicon ใช้ได้เลย → ลองโลโก้ในหน้าเว็บ
  candidates.push(...logos);

  for (const url of [...new Set(candidates)].slice(0, 6)) {
    try {
      const r = await fetchBytesGuarded(url, {
        maxBytes: MAX_ICON_BYTES,
        accept: "image/*",
        allowPrivate: opts.allowPrivate,
      });
      if (r.status >= 400 || r.truncated || r.body.length === 0) continue;
      const type = sniffImageType(r.body);
      if (type && !tinyImage(r.body, type)) return { contentType: type, body: r.body, sourceUrl: r.finalUrl };
    } catch {
      /* ลองตัวถัดไป */
    }
  }
  return null;
}
