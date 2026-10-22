import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, "ชื่อผู้ใช้ใช้ได้ a-z 0-9 . _ - ยาว 3–32 ตัว");

export const passwordSchema = z.string().min(8, "รหัสผ่านอย่างน้อย 8 ตัวอักษร").max(200);

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(200),
  remember: z.boolean().default(false),
});

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(["ADMIN", "VIEWER"]),
});

export const updateUserSchema = z.object({
  role: z.enum(["ADMIN", "VIEWER"]).optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
  /** ปลดล็อกบัญชีที่ถูกล็อกเพราะเดารหัสผิด (ไม่ต้องตั้งรหัสใหม่) */
  unlock: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
