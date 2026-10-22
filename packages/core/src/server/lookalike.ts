import { domainToUnicode } from "node:url";
import { z } from "zod";
import { fetchBytesGuarded } from "./guarded-fetch";

const HOMOGLYPHS: Record<string, string[]> = {
  o: ["0"],
  l: ["1", "i"],
  i: ["1", "l"],
  e: ["3"],
  a: ["4"],
  s: ["5"],
  m: ["rn"],
  w: ["vv"],
};

/**
 * ตัวสะกดผิดที่พบบ่อยในโดเมนปลอม: แทนตัวอักษรที่หน้าตาคล้าย, ตกตัวอักษร, สลับตัวติดกัน
 * จำกัดจำนวนเพื่อไม่ยิง crt.sh ถี่เกินไป
 */
export function typoVariants(keyword: string, max = 12): string[] {
  const k = keyword.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < k.length; i++) {
    for (const g of HOMOGLYPHS[k[i]!] ?? []) out.add(k.slice(0, i) + g + k.slice(i + 1));
  }
  if (k.includes("rn")) out.add(k.replace("rn", "m"));
  for (let i = 1; i < k.length - 1; i++) out.add(k.slice(0, i) + k.slice(i + 1)); // ตกตัวอักษร
  for (let i = 0; i < k.length - 1; i++) out.add(k.slice(0, i) + k[i + 1] + k[i] + k.slice(i + 2)); // สลับ
  out.delete(k);
  return [...out].filter((v) => v.length >= 4).slice(0, max);
}

/** โดเมนนี้เป็นของบริษัทเอง (ตรงกันหรือเป็น subdomain) */
export function isOwnDomain(domain: string, own: string[]): boolean {
  const d = domain.toLowerCase();
  return own.some((o) => d === o || d.endsWith(`.${o}`));
}

const crtRowSchema = z.object({
  id: z.number(),
  issuer_name: z.string().nullish(),
  name_value: z.string(),
  not_before: z.string().nullish(),
});

export interface LookalikeHit {
  domain: string;
  keyword: string;
  similarity: "contains" | "typo";
  certId: number;
  issuer: string | null;
  notBefore: Date | null;
}

/** แปลงผลจาก crt.sh → โดเมนที่น่าสงสัย (ฟังก์ชันบริสุทธิ์ ทดสอบได้) */
/** อักษรต่างภาษาที่หน้าตาเหมือนอักษรละติน (homoglyph) ที่พบบ่อยในโดเมนปลอม */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
  һ: "h",
  ԛ: "q",
  ԝ: "w",
  ɡ: "g",
  ο: "o",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ı: "i",
  ł: "l",
  ø: "o",
};

/** รูปที่ผู้ใช้ "เห็น" ของโดเมน: punycode → Unicode → NFKC → แทน homoglyph → ตัดเครื่องหมายกำกับ */
export function lookalikeSkeleton(domain: string): string {
  const unicode = domain.includes("xn--") ? domainToUnicode(domain) || domain : domain;
  return [...unicode.normalize("NFKD").toLowerCase()]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .replace(/[̀-ͯ]/g, "");
}

export function extractLookalikes(
  rows: unknown,
  term: { query: string; keyword: string; similarity: "contains" | "typo" },
  ownDomains: string[],
): LookalikeHit[] {
  const parsed = z.array(crtRowSchema).safeParse(rows);
  if (!parsed.success) return [];
  const out = new Map<string, LookalikeHit>();
  for (const r of parsed.data) {
    for (const raw of r.name_value.split(/\s+/)) {
      const domain = raw.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) continue;
      // โดเมน IDN (xn--…) ที่ใช้อักษรหน้าตาเหมือนกัน เช่น "mycоmpany" (о ซีริลลิก) → เทียบจากรูปที่ตาเห็น
      if (!domain.includes(term.query) && !lookalikeSkeleton(domain).includes(term.query)) continue;
      if (isOwnDomain(domain, ownDomains)) continue;
      const issuer = r.issuer_name ? (/O=([^,]+)/.exec(r.issuer_name)?.[1] ?? r.issuer_name) : null;
      const notBefore = r.not_before ? new Date(`${r.not_before.replace(" ", "T")}Z`) : null;
      const prev = out.get(domain);
      if (!prev || (notBefore && prev.notBefore && notBefore > prev.notBefore)) {
        out.set(domain, {
          domain,
          keyword: term.keyword,
          similarity: term.similarity,
          certId: r.id,
          issuer: issuer?.slice(0, 200) ?? null,
          notBefore: notBefore && !Number.isNaN(notBefore.getTime()) ? notBefore : null,
        });
      }
    }
  }
  return [...out.values()];
}

/** ค้นหาใบรับรองที่มีคำนี้ใน Certificate Transparency log (crt.sh — บริการฟรี บางครั้งช้า/ล่ม) */
export async function searchCertificates(query: string): Promise<unknown> {
  const url = `https://crt.sh/?q=${encodeURIComponent(`%${query}%`)}&output=json&exclude=expired&deduplicate=Y`;
  // crt.sh เป็นบริการฟรีที่ตอบ 502/503 บ่อย → ลองซ้ำ 3 ครั้ง เว้นช่วงห่างขึ้น
  let r: Awaited<ReturnType<typeof fetchBytesGuarded>> | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      r = await fetchBytesGuarded(url, {
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 30_000,
        accept: "application/json",
      });
      if (r.status < 500) break;
    } catch (err) {
      if (attempt === 3) throw err;
    }
    if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5_000));
  }
  if (!r || r.status !== 200)
    throw new Error(`crt.sh ตอบ ${r?.status ?? "ไม่ได้"} (บริการอาจล่มชั่วคราว จะลองใหม่รอบถัดไป)`);
  if (r.truncated) throw new Error("ผลลัพธ์จาก crt.sh ใหญ่เกินไป — ใช้คำค้นที่เฉพาะเจาะจงกว่านี้");
  return JSON.parse(r.body.toString("utf8"));
}
