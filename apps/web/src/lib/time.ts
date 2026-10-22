import "server-only";

/** เวลาของ request นี้ — เรียกครั้งเดียวต่อหน้าแล้วส่งต่อ (หน้าเป็น dynamic render ต่อ request อยู่แล้ว) */
export function requestNow(): number {
  return Date.now();
}
