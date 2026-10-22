/**
 * สร้างผู้ใช้จากเซิร์ฟเวอร์ (ใช้สร้าง Admin คนแรก) / รีเซ็ตรหัสผ่าน
 *   Docker:  docker compose run --rm worker node dist/create-user.cjs --username admin --role admin
 *   เครื่อง dev: pnpm user:create -- --username admin --role admin
 *   pnpm user:create -- --username viewer --role viewer --password-stdin < pw.txt
 * ชื่อผู้ใช้มีอยู่แล้ว = รีเซ็ตรหัสผ่าน (และปลดล็อก) โดย "ไม่เปลี่ยนสิทธิ์" เว้นแต่ใส่ --role มาเอง
 */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { passwordSchema, usernameSchema } from "@app/core";
import { createDb, eq, sessions, users } from "@app/db";
import argon2 from "argon2";

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) return line;
    return "";
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

/** --role: admin / viewer เท่านั้น (พิมพ์ผิด เช่น "viwer" ต้องไม่กลายเป็น Admin เงียบ ๆ) */
export function parseRole(raw: string | undefined): "ADMIN" | "VIEWER" | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toUpperCase();
  if (v === "ADMIN" || v === "VIEWER") return v;
  throw new Error(`--role ต้องเป็น admin หรือ viewer (ได้ "${raw}")`);
}

async function main() {
  const { values } = parseArgs({
    // pnpm ส่ง "--" ต่อมาด้วย (pnpm user:create -- --username ...)
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      username: { type: "string" },
      role: { type: "string" },
      "password-stdin": { type: "boolean", default: false },
    },
  });
  const username = usernameSchema.safeParse(values.username ?? "");
  if (!username.success) throw new Error(`--username: ${username.error.issues[0]?.message}`);
  const role = parseRole(values.role);

  if (!process.env.DATABASE_URL) throw new Error("ไม่พบ DATABASE_URL (ตั้งค่าใน .env)");
  const { db, pool } = createDb(process.env.DATABASE_URL, { applicationName: "create-user", max: 1 });
  try {
    const [existing] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.username, username.data));
    let password: string;
    if (values["password-stdin"]) {
      password = (await readHidden("")).trim();
    } else {
      password = await readHidden("รหัสผ่าน (อย่างน้อย 8 ตัว): ");
      const again = await readHidden("ยืนยันรหัสผ่าน: ");
      if (password !== again) throw new Error("รหัสผ่านไม่ตรงกัน");
    }
    const pw = passwordSchema.safeParse(password);
    if (!pw.success) throw new Error(pw.error.issues[0]?.message ?? "รหัสผ่านไม่ถูกต้อง");
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    if (existing) {
      const finalRole = role ?? existing.role;
      await db
        .update(users)
        .set({ passwordHash: hash, role: finalRole, isActive: true, failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, existing.id));
      await db.delete(sessions).where(eq(sessions.userId, existing.id));
      console.log(
        `รีเซ็ตรหัสผ่านของ ${username.data} แล้ว · สิทธิ์: ${finalRole}${role && role !== existing.role ? ` (เปลี่ยนจาก ${existing.role})` : ""}`,
      );
    } else {
      const finalRole = role ?? "ADMIN";
      await db.insert(users).values({ username: username.data, passwordHash: hash, role: finalRole });
      console.log(`สร้างผู้ใช้ ${username.data} แล้ว · สิทธิ์: ${finalRole}`);
    }
  } finally {
    await pool.end();
  }
}

// รันเป็นสคริปต์เท่านั้น (เทสต์ import parseRole ได้โดยไม่สั่ง main)
if (!process.env.VITEST) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
