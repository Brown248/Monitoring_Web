export const CHECK_STATUSES = ["UP", "DOWN", "UNKNOWN"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const CHECK_ERROR_CODES = [
  "TIMEOUT",
  "CONNECT_TIMEOUT",
  "DNS",
  "CONNECTION_REFUSED",
  "CONNECTION_RESET",
  "TLS",
  "HTTP_STATUS",
  "TOO_MANY_REDIRECTS",
  "INVALID_REDIRECT",
  "SSRF_BLOCKED",
  "PRIVATE_TARGET",
  "PRIVATE_REDIRECT",
  "NETWORK",
  "INTERNAL",
] as const;
export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

/** ผลของการยิง request หนึ่งครั้ง (รวม redirect ทุก hop แล้ว) */
export interface AttemptResult {
  ok: boolean;
  httpStatus: number | null;
  firstHttpStatus: number | null;
  responseTimeMs: number | null;
  errorCode: CheckErrorCode | null;
  /** ข้อความที่ปลอดภัยสำหรับบันทึก — ห้ามมี header, cookie หรือ credential */
  errorMessage: string | null;
  finalUrl: string | null;
  redirectCount: number;
  remoteIp: string | null;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  /** วันหมดอายุใบรับรองของ hop สุดท้าย (เฉพาะ https) */
  tlsValidTo: string | null;
}

/** ผลตรวจหนึ่งรอบ (อาจมีหลาย attempt จาก retry) หลังตัดสินสถานะแล้ว */
export interface CheckOutcome extends Omit<AttemptResult, "ok" | "tlsValidTo"> {
  status: CheckStatus;
  degraded: boolean;
  retries: number;
  startedAt: Date;
  finishedAt: Date;
}

export type IncidentTransition = "open" | "close" | "none";

export type UserRole = "ADMIN" | "VIEWER";
