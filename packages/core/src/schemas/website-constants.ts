/** ค่าคงที่ของฟอร์มเว็บไซต์ที่ใช้ได้ทั้งฝั่ง client และ server (ไม่มี import node:*) */
export const CHECK_INTERVAL_OPTIONS = [60, 120, 300, 600, 900, 1800, 3600] as const;

export function maxRoundSeconds(v: {
  timeoutSeconds: number;
  retryCount: number;
  retryDelaySeconds: number;
}) {
  return v.timeoutSeconds * (v.retryCount + 1) + v.retryDelaySeconds * v.retryCount;
}
