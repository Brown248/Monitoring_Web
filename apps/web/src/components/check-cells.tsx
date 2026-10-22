import { causeLabel, formatMs } from "@app/core";

interface CheckLike {
  status: string;
  degraded: boolean;
  httpStatus: number | null;
  firstHttpStatus: number | null;
  responseTimeMs: number | null;
  retries: number;
  errorCode: string | null;
  errorMessage: string | null;
  redirectCount: number;
}

export function httpCell(c: CheckLike): string {
  if (c.httpStatus === null) return "—";
  if (c.redirectCount > 0 && c.firstHttpStatus && c.firstHttpStatus !== c.httpStatus)
    return `${c.firstHttpStatus} → ${c.httpStatus}`;
  return String(c.httpStatus);
}

export function responseCell(c: CheckLike): string {
  return formatMs(c.responseTimeMs);
}

/** คำอธิบายสั้นของผลตรวจ (คอลัมน์ Error / รายละเอียด) */
export function detailCell(c: CheckLike, degradedThresholdMs?: number | null): string {
  if (c.status === "UP") {
    if (c.degraded)
      return degradedThresholdMs
        ? `ช้ากว่าเกณฑ์ ${degradedThresholdMs.toLocaleString("en-US")} ms`
        : "ตอบช้ากว่าเกณฑ์";
    if (c.retries > 0) return `สำเร็จหลัง retry ครั้งที่ ${c.retries}`;
    if (c.redirectCount > 0) return `Redirect ${c.redirectCount} hop`;
    return "—";
  }
  const label = causeLabel(c.errorCode, c.httpStatus);
  if (c.errorCode === "HTTP_STATUS") return label;
  if (c.errorMessage && c.errorMessage !== label) return `${label} · ${c.errorMessage}`;
  return label;
}
