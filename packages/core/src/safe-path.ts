const BASE = "http://monitor.invalid";

/**
 * ปลายทางหลัง login (?next=) — รับเฉพาะ path ภายในเว็บนี้ (กัน open redirect)
 * ใช้ตัวแยก URL จริงแทนการเทียบตัวอักษร: เบราว์เซอร์ตัด Tab/ขึ้นบรรทัดทิ้งก่อนแยก URL
 * ("/\t/evil.com" → "//evil.com" = เว็บอื่น) และมองแบ็กสแลชเป็นทับ — ตรวจด้วยตาเองพลาดง่าย
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 2000 || !raw.startsWith("/")) return "/";
  // อักขระควบคุม/ช่องว่าง/แบ็กสแลช ไม่มีใน path ปกติของระบบนี้ — ปฏิเสธทั้งหมด
  // eslint-disable-next-line no-control-regex -- ตั้งใจจับอักขระควบคุม
  if (/[\u0000- \u007f\\]/.test(raw)) return "/";
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (u.origin !== BASE) return "/";
  const path = `${u.pathname}${u.search}${u.hash}`;
  if (u.pathname === "/login" || u.pathname.startsWith("/api/")) return "/";
  return path;
}

/**
 * URL ที่จะส่งให้ผู้ให้บริการ AI — ตัด query/fragment/รหัสผ่านใน URL ทิ้ง
 * (URL ตรวจสุขภาพมักมี ?token=… หรือ key ที่ไม่ควรออกนอกองค์กร)
 */
export function urlForAi(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0]!;
  }
}
