import type { CheckErrorCode } from "./types";

const LABELS: Record<CheckErrorCode, string> = {
  TIMEOUT: "Timeout",
  CONNECT_TIMEOUT: "Connect timeout",
  DNS: "DNS lookup ล้มเหลว",
  CONNECTION_REFUSED: "Connection refused",
  CONNECTION_RESET: "Connection reset",
  TLS: "TLS handshake ล้มเหลว",
  HTTP_STATUS: "HTTP status ไม่อยู่ในเกณฑ์",
  TOO_MANY_REDIRECTS: "Redirect เกินจำนวนที่กำหนด",
  INVALID_REDIRECT: "Redirect ไม่ถูกต้อง",
  SSRF_BLOCKED: "ปลายทางเป็น IP ภายใน (ถูกปฏิเสธ)",
  PRIVATE_TARGET: "DNS ชี้ไป IP ภายใน",
  PRIVATE_REDIRECT: "Redirect ไป localhost/IP ภายใน",
  NETWORK: "เครือข่ายผิดพลาด",
  INTERNAL: "ข้อผิดพลาดภายใน Worker",
};

export function errorLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return (LABELS as Record<string, string>)[code] ?? code;
}

/** สาเหตุแบบสั้นสำหรับ Incident และตาราง เช่น "HTTP 503", "Timeout" */
export function causeLabel(code: string | null | undefined, httpStatus: number | null | undefined): string {
  if (code === "HTTP_STATUS" && httpStatus) return `HTTP ${httpStatus}`;
  return errorLabel(code);
}

/** error ที่เกิดระหว่างทางเครือข่าย — ถ้า canary ล้มเหลวพร้อมกัน ให้ถือว่าเป็นปัญหาฝั่ง Worker (UNKNOWN) */
export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "CONNECT_TIMEOUT",
  "DNS",
  "CONNECTION_REFUSED",
  "CONNECTION_RESET",
  "NETWORK",
]);

/**
 * ปลายทางกลายเป็น IP ภายใน — อาจเป็นเว็บตั้งค่าผิดจริง หรือเน็ตของ Worker ถูกจับไปหน้า login ของเราเตอร์
 * (captive portal) ซึ่งทำให้ทุกเว็บดูเหมือนชี้ไป 192.168.x → ต้องดู canary ก่อนตัดสินเหมือน network error
 */
export const PRIVATE_TARGET_CODES: ReadonlySet<string> = new Set(["PRIVATE_TARGET", "PRIVATE_REDIRECT"]);

/** error ที่ไม่ได้บอกว่าเว็บปลายทางล่ม — ไม่นับเป็น DOWN */
export const INDETERMINATE_ERROR_CODES: ReadonlySet<string> = new Set(["SSRF_BLOCKED", "INTERNAL"]);
