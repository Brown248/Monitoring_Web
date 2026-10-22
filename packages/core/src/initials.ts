// อักษรย่อของชื่อเว็บ สำหรับไอคอนแทน favicon (isomorphic)

/** สระหน้าภาษาไทย (เขียนก่อนพยัญชนะ) — ข้ามไปเอาพยัญชนะตัวแรกแทน */
const THAI_LEADING_VOWEL = /^[เแโใไ]/;

function firstLetter(word: string): string {
  const w = word.replace(THAI_LEADING_VOWEL, "");
  // ตัวแรกที่เป็นตัวอักษร/ตัวเลข (ข้ามสัญลักษณ์) — ใช้ code point ไม่ตัดอีโมจิครึ่งตัว
  const ch = [...w].find((c) => /[\p{L}\p{N}]/u.test(c) && !/\p{M}/u.test(c));
  return (ch ?? "").toUpperCase();
}

/**
 * "IoT Yomnan" → "IY", "TFP Dashboard" → "TD", "ThingsBoard" → "TB", "CRM" → "CRM", "เว็บบริษัท" → "ว"
 * หลายคำ = อักษรแรกของ 2 คำแรก · คำเดียวแบบ CamelCase = ตัวใหญ่ 2 ตัวแรก · ตัวย่อล้วน ≤ 3 ตัวใช้ทั้งคำ
 */
export function siteInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_./|·:]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  if (words.length >= 2) return firstLetter(words[0]!) + firstLetter(words[1]!) || "?";
  const w = words[0]!;
  if (/^[A-Z0-9]{2,3}$/.test(w)) return w;
  const caps = w.match(/[A-Z]/g);
  if (caps && caps.length >= 2 && /^[A-Z]/.test(w)) return caps.slice(0, 2).join("");
  return firstLetter(w) || "?";
}

/** จำนวนสีของไอคอนอักษรย่อ (ต้องตรงกับรายการสีใน SiteIcon) */
export const ICON_TONES = 10;

/** สีของเว็บจากชื่อ — ชื่อเดิมได้สีเดิมเสมอ */
export function toneOf(name: string): number {
  return stableHash(name.trim().toLowerCase()) % ICON_TONES;
}

/** สีของกลุ่มเว็บ (เรียงตามลำดับที่ส่งมา) — เริ่มจากสีตามชื่อ ถ้าชนกับเว็บก่อนหน้าในกลุ่มให้ขยับไปสีถัดไป */
export function distinctTones(names: string[]): number[] {
  const used = new Set<number>();
  return names.map((n) => {
    let t = toneOf(n);
    for (let i = 0; i < ICON_TONES && used.has(t); i++) t = (t + 1) % ICON_TONES;
    used.add(t);
    return t;
  });
}

/** ตัวเลขคงที่จากชื่อ (FNV-1a) — ใช้เลือกสีให้ชื่อเดิมได้สีเดิมเสมอ */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
