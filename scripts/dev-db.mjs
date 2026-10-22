// PostgreSQL สำหรับรันบนเครื่อง dev ที่ไม่มี Docker (ไม่ใช้บน server — server ใช้ docker compose)
//   pnpm dev:db   แล้วเปิดค้างไว้ · Ctrl+C เพื่อหยุด
// ข้อมูลเก็บนอกโฟลเดอร์โปรเจกต์ (../monitoring-web-dev-db หรือ DEV_DB_DIR) — ถ้าอยู่ในโปรเจกต์
// next dev จะเห็นไฟล์ฐานข้อมูลเปลี่ยนทุกครั้งที่เขียน แล้วรีเฟรชหน้าเว็บวนไม่หยุด
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const root = path.resolve(import.meta.dirname, "..");
process.loadEnvFile(path.join(root, ".env"));
const { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database } = process.env;
if (!user || !password || !database)
  throw new Error("ตั้งค่า POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB ใน .env ก่อน");

const dataDir = process.env.DEV_DB_DIR || path.resolve(root, "..", "monitoring-web-dev-db");
// ย้ายข้อมูลจากที่เก็บเดิม (.dev-db ในโปรเจกต์) ครั้งแรกครั้งเดียว — ต้องหยุดฐานข้อมูลก่อน (สคริปต์นี้ยังไม่เริ่ม)
const legacyDir = path.join(root, ".dev-db");
if (existsSync(path.join(legacyDir, "PG_VERSION")) && !existsSync(dataDir)) {
  renameSync(legacyDir, dataDir);
  console.log(`ย้ายฐานข้อมูล dev จาก ${legacyDir} → ${dataDir}`);
}
const db = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port: 5432,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

if (!existsSync(path.join(dataDir, "PG_VERSION"))) await db.initialise();
await db.start();

// สร้างฐานข้อมูลเป็น UTF8 (รองรับภาษาไทย) ถ้ายังไม่มี
const client = new pg.Client({ host: "127.0.0.1", port: 5432, user, password, database: "postgres" });
await client.connect();
const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (exists.rowCount === 0) {
  await client.query(
    `CREATE DATABASE "${database}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  console.log(`สร้างฐานข้อมูล ${database} แล้ว — รัน pnpm db:migrate ต่อ`);
}
await client.end();
console.log(`PostgreSQL พร้อมที่ 127.0.0.1:5432 (db=${database}) · Ctrl+C เพื่อหยุด`);

const stop = async () => {
  await db.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
