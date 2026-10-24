// ค่าร่วมของ scripts/verify-env.mjs และ scripts/verify-login-flow.mjs — ไฟล์เล็กแยกไว้ให้ flow script import ได้
// โดยไม่โหลด embedded-postgres (ซึ่งลงทะเบียน signal handler ของตัวเองตอน import)

/** ผู้ใช้ทดสอบในฐานข้อมูลชั่วคราวเท่านั้น (ไม่ใช่ผู้ใช้จริง) */
export const TEST_USER = "verify-admin";
export const TEST_PASSWORD = "verify-only-password";
