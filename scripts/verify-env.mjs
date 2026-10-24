// สภาพแวดล้อมชั่วคราวสำหรับ Stack Agent verify (.stack-agent/verify.json) — ไม่แตะฐานข้อมูล dev
//   node scripts/verify-env.mjs test    เปิด PostgreSQL ชั่วคราว แล้วรัน vitest พร้อม TEST_DATABASE_URL (รวม integration test)
//   node scripts/verify-env.mjs serve   เปิด PostgreSQL ชั่วคราว → migrate → สร้างผู้ใช้ทดสอบ → next dev ที่ PORT (ค่าเริ่มต้น 3999)
// ฐานข้อมูลใหม่ทุกครั้งใน temp ของเครื่อง (embedded-postgres ตัวเดียวกับ pnpm dev:db) ลบทิ้งเมื่อหยุด
// secret ใน .env (SMTP/AI/Google) ถูกตั้งเป็นค่าว่าง — verify ไม่ส่งอีเมลหรือเรียก AI จริง
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { TEST_PASSWORD, TEST_USER } from "./verify-constants.mjs";

const root = path.resolve(import.meta.dirname, "..");
const DB = { user: "verify", password: "verify-only-db-password", database: "monitor_verify" };
const TMP_PREFIX = "monitoring-web-verify-";
const OWNER_FILE = "owner.pid";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * verify บน Windows หยุด process ด้วย taskkill /F — cleanup ไม่ได้รัน โฟลเดอร์จึงค้าง
 * ตอนเริ่มลบโฟลเดอร์ที่ process เจ้าของ (ไฟล์ owner.pid) ไม่อยู่แล้ว หรือเก่าเกิน 12 ชม. (verify รอบหนึ่งใช้ไม่กี่นาที
 * แต่ Windows นำ PID เก่ากลับมาใช้ใหม่ได้ — ไม่มีเพดานอายุ โฟลเดอร์อาจค้างตลอดไป)
 */
function removeStaleDirs() {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const name of readdirSync(os.tmpdir())) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      const pidFile = path.join(dir, OWNER_FILE);
      const ownerGone = existsSync(pidFile) && !alive(Number(readFileSync(pidFile, "utf8")));
      if (ownerGone || statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
    } catch {
      // ไฟล์ยังถูกถืออยู่หรือถูกลบไปแล้ว — ลองใหม่รอบหลัง
    }
  }
}

/** พอร์ตว่างจาก OS — บน Windows process ลูกของ postgres (io_worker) อาจค้างถือพอร์ตเดิมไว้หลังหยุด จึงไม่ใช้พอร์ตตายตัว */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startDb() {
  removeStaleDirs();
  const dir = mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  writeFileSync(path.join(dir, OWNER_FILE), String(process.pid));
  const port = Number(process.env.VERIFY_DB_PORT) || (await freePort());
  const db = new EmbeddedPostgres({
    databaseDir: path.join(dir, "data"),
    user: DB.user,
    password: DB.password,
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
  });
  // embedded-postgres reject ด้วย undefined เมื่อเริ่มไม่ได้ — แปลงเป็นข้อความที่บอกสาเหตุ
  await db.initialise().catch((err) => {
    throw new Error(`initdb ล้มเหลวที่ ${dir}: ${err ?? "ไม่ทราบสาเหตุ"}`);
  });
  await db.start().catch((err) => {
    throw new Error(
      `เปิด PostgreSQL ชั่วคราวที่พอร์ต ${port} ไม่ได้: ${err ?? "ไม่ทราบสาเหตุ (พอร์ตถูกใช้อยู่?)"}`,
    );
  });
  const client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: DB.user,
    password: DB.password,
    database: "postgres",
  });
  await client.connect();
  await client.query(`CREATE DATABASE "${DB.database}" ENCODING 'UTF8' TEMPLATE template0`);
  await client.end();
  const url = `postgres://${DB.user}:${DB.password}@127.0.0.1:${port}/${DB.database}`;
  const stop = async () => {
    await db.stop().catch(() => {});
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ไฟล์ยังถูกถืออยู่ (Windows) — removeStaleDirs ลบให้ในรอบหลัง
    }
  };
  return { url, stop };
}

/** รัน node พร้อม args (ไม่ผ่าน shell — ใช้ได้เหมือนกันทั้ง Windows และ Linux) */
function run(args, { cwd = root, env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(" ")} → exit ${code}`)),
    );
  });
}

// ค่าว่าง = ไม่ถูกทับด้วย .env (process.loadEnvFile ใน next.config.ts ไม่ทับตัวแปรที่มีอยู่แล้ว)
const NO_SECRETS = { SMTP_PASSWORD: "", AI_API_KEY: "", AI_BASE_URL: "", GOOGLE_SERVICE_ACCOUNT_JSON: "" };

async function test(url) {
  await run([path.join(root, "node_modules/vitest/vitest.mjs"), "run"], {
    env: { ...NO_SECRETS, TEST_DATABASE_URL: url },
  });
}

async function serve(url) {
  const worker = path.join(root, "apps/worker");
  const dbEnv = { ...NO_SECRETS, DATABASE_URL: url };
  await run(["--import", "tsx", "src/cli/migrate.ts"], { cwd: worker, env: dbEnv });
  await run(
    [
      "--import",
      "tsx",
      "src/cli/create-user.ts",
      "--username",
      TEST_USER,
      "--role",
      "admin",
      "--password-stdin",
    ],
    { cwd: worker, env: dbEnv, input: `${TEST_PASSWORD}\n` },
  );
  const port = process.env.PORT || "3999";
  const web = path.join(root, "apps/web");
  const child = spawn(
    process.execPath,
    [path.join(web, "node_modules/next/dist/bin/next"), "dev", "--port", port, "--hostname", "127.0.0.1"],
    {
      cwd: web,
      stdio: "inherit",
      env: {
        ...process.env,
        ...dbEnv,
        APP_BASE_URL: `http://127.0.0.1:${port}`,
        COOKIE_SECURE: "false",
        // โฟลเดอร์ build แยก — เปิดได้แม้ pnpm dev:web กำลังรันอยู่ (ดู next.config.ts)
        WEB_DIST_DIR: ".next/verify",
      },
    },
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next dev → exit ${code}`))));
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  });
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "test" && mode !== "serve") {
    console.error("ใช้: node scripts/verify-env.mjs test|serve");
    process.exit(2);
  }
  let db;
  let code = 0;
  try {
    db = await startDb();
    await (mode === "test" ? test(db.url) : serve(db.url));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    code = 1;
  } finally {
    await db?.stop();
  }
  process.exit(code);
}
