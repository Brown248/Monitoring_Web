import "server-only";
import { createDb, type Database, type DbHandle } from "@app/db";
import { getEnv } from "./env";

// เก็บไว้บน globalThis เพื่อไม่ให้สร้าง pool ใหม่ทุกครั้งที่ dev server ทำ HMR
const globalForDb = globalThis as unknown as { __monitorDb?: DbHandle };

export function getDb(): Database {
  globalForDb.__monitorDb ??= createDb(getEnv().DATABASE_URL, {
    applicationName: "web",
    max: 10,
    // หน้าเว็บไม่ควรรอ query เกิน 30 วินาที — ค้างนานกว่านั้นให้ error แทนหน้าขาวที่โหลดไม่จบ
    statementTimeoutMs: 30_000,
  });
  return globalForDb.__monitorDb.db;
}
