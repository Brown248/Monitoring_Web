// อ่านค่าจาก URL (?page=, ?websiteId=, ?from=) อย่างปลอดภัย — ค่าแปลก ๆ ใช้ค่าเริ่มต้นแทน ไม่ทำให้หน้าล้ม (500)

const INT4_MAX = 2_147_483_647;
const MAX_PAGE = 100_000;

/** เลขหน้า: จำนวนเต็ม 1..100,000 (`1.5`, `1e20`, `Infinity`, `abc` → 1) */
export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
}

/** id ในฐานข้อมูล (int4) — นอกช่วงหรือไม่ใช่จำนวนเต็ม → undefined */
export function parseId(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= INT4_MAX ? n : undefined;
}

/** วันที่ YYYY-MM-DD ที่มีอยู่จริงในปฏิทิน (2026-02-31 → undefined) */
export function parseDateParam(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00Z`);
  // ปี 0000 JavaScript รับได้แต่ PostgreSQL ไม่รับ (date out of range → หน้า error) — จำกัดช่วงที่ใช้งานจริง
  const year = Number(raw.slice(0, 4));
  if (year < 1970 || year > 9999) return undefined;
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : undefined;
}

/** คีย์ที่มีอยู่จริงในตาราง (ไม่ใช่ toString/constructor ของ prototype) */
export function ownKey<T extends object>(obj: T, key: string | undefined): key is Extract<keyof T, string> {
  return key !== undefined && Object.hasOwn(obj, key);
}

/** หน้าที่ขอเกินหน้าสุดท้าย (เช่น ข้อมูลลดลงระหว่างดู) → หน้าสุดท้ายที่มีข้อมูล; null = หน้าเดิมใช้ได้ */
export function clampPage(page: number, total: number, pageSize: number): number | null {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return page > last ? last : null;
}
