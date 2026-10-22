import type { Logger, SettingsMap } from "@app/core";
import { getAllSettings, type Database } from "@app/db";
import type { WorkerEnv } from "./env";

export interface CanaryState {
  /** ทุกปลายทาง canary ล้มเหลวในรอบล่าสุด (และผลยังไม่เก่าเกิน 3 นาที) */
  failing: boolean;
  checkedAt: Date | null;
}

export interface WorkerContext {
  db: Database;
  env: WorkerEnv;
  log: Logger;
  workerId: string;
  canary: CanaryState;
  settings(): Promise<SettingsMap>;
}

/** cache การตั้งค่าจาก DB 15 วินาที — หน้าเว็บบันทึกแล้ว worker เห็นภายในรอบถัดไป */
export function createSettingsCache(db: Database, ttlMs = 15_000): () => Promise<SettingsMap> {
  let cached: { at: number; value: SettingsMap } | null = null;
  return async () => {
    if (!cached || Date.now() - cached.at > ttlMs)
      cached = { at: Date.now(), value: await getAllSettings(db) };
    return cached.value;
  };
}

export function canaryFailing(c: CanaryState): boolean {
  return c.failing && c.checkedAt !== null && Date.now() - c.checkedAt.getTime() < 180_000;
}
