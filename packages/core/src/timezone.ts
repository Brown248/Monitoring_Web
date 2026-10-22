/**
 * ชื่อ timezone แบบ IANA (เช่น Asia/Bangkok) ที่ Node รู้จัก — ใช้ตรวจ APP_TIMEZONE ตอนเริ่มระบบ
 * (ตั้งผิดแล้วไม่เตือน = สรุปรายวัน/ลบข้อมูลเก่า/sync Sheets ล้มเงียบ และหน้าเว็บ error 500)
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TIMEZONE_HINT = "ต้องเป็นชื่อ timezone แบบ IANA เช่น Asia/Bangkok (ไม่ใช่ +07:00 หรือ ICT)";
