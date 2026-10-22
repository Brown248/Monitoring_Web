import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
}

export interface CreateDbOptions {
  max?: number;
  applicationName?: string;
  /** คำสั่ง SQL หนึ่งคำสั่งรันได้นานสุดกี่ ms (ค่าเริ่มต้น 60 วินาที) */
  statementTimeoutMs?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  const statementTimeout = options.statementTimeoutMs ?? 60_000;
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName,
    // ค่าเริ่มต้นของ pg ปิด connection ที่ว่าง 10 วินาที → เปิดหน้าใหม่หลังอ่านหน้าเดิมต้องต่อใหม่ทุกครั้ง
    // (SCRAM auth ~50–150 ms ต่อ connection) — เก็บไว้ 5 นาทีแทน
    idleTimeoutMillis: 300_000,
    keepAlive: true,
    // ไม่มี timeout = ฐานข้อมูลค้าง/เครือข่ายหลุดแบบเงียบ แล้วทุกงานรอตลอดไป (Worker หยุดตรวจเว็บโดยไม่มีใครรู้)
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeout,
    // กันฝั่ง client ด้วย — กรณีเซิร์ฟเวอร์ไม่ตอบเลย statement_timeout ฝั่งเซิร์ฟเวอร์ไม่มีโอกาสทำงาน
    query_timeout: statementTimeout + 5_000,
    // ทรานแซกชันที่เปิดค้าง (โค้ดรอ network ระหว่าง BEGIN…COMMIT) จะถือ lock ไว้ — ตัดทิ้งหลัง 5 นาที
    idle_in_transaction_session_timeout: 300_000,
  });
  const slowMs = Number(process.env.DB_SLOW_QUERY_MS);
  if (slowMs > 0) logSlowQueries(pool, slowMs, options.applicationName ?? "db");
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

/**
 * DB_SLOW_QUERY_MS=200 → พิมพ์ SQL ที่ช้ากว่าเกณฑ์ (ตัด 300 ตัวอักษร, ไม่พิมพ์ค่าพารามิเตอร์ที่อาจมีข้อมูลส่วนตัว)
 * เวลารวมเวลารอ connection ว่างใน pool ด้วย — ใช้หาคอขวด
 */
function logSlowQueries(pool: pg.Pool, slowMs: number, name: string): void {
  const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args) => {
    const t0 = performance.now();
    try {
      return await original(...args);
    } finally {
      const ms = performance.now() - t0;
      if (ms >= slowMs) {
        const q = args[0];
        const text = typeof q === "string" ? q : ((q as { text?: string })?.text ?? "");
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "slow query",
            app: name,
            ms: Math.round(ms),
            waiting: pool.waitingCount,
            sql: text.replace(/\s+/g, " ").slice(0, 300),
          }),
        );
      }
    }
  };
}
