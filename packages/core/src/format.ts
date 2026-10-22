/** ตัวจัดรูปแบบวันเวลาภาษาไทย (ปฏิทินสากล) ใช้ร่วมกันทั้งหน้าเว็บและอีเมล */

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("th-TH-u-ca-gregory-nu-latn", { timeZone: tz, hourCycle: "h23", ...opts });
    cache.set(key, f);
  }
  return f;
}

const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

/** 11:42:05 */
export function formatTime(d: Date | string | number, tz: string): string {
  return fmt(tz, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(toDate(d));
}

/** 11:42 */
export function formatHm(d: Date | string | number, tz: string): string {
  return fmt(tz, { hour: "2-digit", minute: "2-digit" }).format(toDate(d));
}

/** 21 ต.ค. */
export function formatDayMonth(d: Date | string | number, tz: string): string {
  return fmt(tz, { day: "numeric", month: "short" }).format(toDate(d));
}

/** 21 ต.ค. 11:36 */
export function formatDateTime(d: Date | string | number, tz: string): string {
  return `${formatDayMonth(d, tz)} ${formatHm(d, tz)}`;
}

/** 14 ม.ค. 2027 */
export function formatDate(d: Date | string | number, tz: string): string {
  return fmt(tz, { day: "numeric", month: "short", year: "numeric" }).format(toDate(d));
}

/** YYYY-MM-DD ตาม timezone (ใช้เป็น key รายวัน) */
export function dayKey(d: Date | string | number, tz: string): string {
  const parts = fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(toDate(d));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isSameDay(a: Date, b: Date, tz: string): boolean {
  return dayKey(a, tz) === dayKey(b, tz);
}

/** "วันนี้ 11:19" หรือ "17 ต.ค. 02:10" */
export function formatRelativeDay(d: Date | string | number, tz: string, now = new Date()): string {
  const date = toDate(d);
  return isSameDay(date, now, tz) ? `วันนี้ ${formatHm(date, tz)}` : formatDateTime(date, tz);
}

/** 23 นาที · 1 ชม. 5 นาที · 2 วัน 3 ชม. */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin} นาที`;
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days} วัน ${hours} ชม.` : `${days} วัน`;
  return mins > 0 ? `${hours} ชม. ${mins} นาที` : `${hours} ชม.`;
}

/** 12 วินาทีที่แล้ว · 5 นาทีที่แล้ว */
export function formatAgo(d: Date | string | number, now = new Date()): string {
  const sec = Math.max(0, Math.round((now.getTime() - toDate(d).getTime()) / 1000));
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ชั่วโมงที่แล้ว`;
  return `${Math.floor(hr / 24)} วันที่แล้ว`;
}

/** 5 นาที · 1 ชม. */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ชม.`;
  if (seconds % 60 === 0) return `${seconds / 60} นาที`;
  return `${seconds} วินาที`;
}

const numberFmt = new Intl.NumberFormat("en-US");
export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

/** 1,840 ms */
export function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${numberFmt.format(Math.round(ms))} ms`;
}

/** 99.62% (ตัด 0 ท้าย) */
export function formatPercent(ratio: number | null | undefined, digits = 2): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "—";
  const v = ratio * 100;
  if (v >= 100) return "100%";
  // ปัดลงเสมอ: ล่ม 1 ครั้งใน 25,000 (99.996%) ต้องไม่แสดงเป็น "100.00%" ราวกับไม่เคยล่ม
  const f = 10 ** digits;
  // + 1e-9: กันทศนิยมของ float (0.29 × 100 = 28.999…) ไม่ให้ปัดลงผิดเป็น 28.99
  return `${(Math.floor(v * f + 1e-9) / f).toFixed(digits)}%`;
}

/** 1.8 GB */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** ตัด https:// ออกเพื่อแสดงแบบย่อ */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
