import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, workerHeartbeats, type Database } from "@app/db";

/** Docker healthcheck อ่าน mtime ของไฟล์นี้ (ใน container = /tmp/worker.alive) */
export const ALIVE_FILE = path.join(os.tmpdir(), "worker.alive");

export interface WorkerInfo {
  workerId: string;
  startedAt: Date;
  version?: string;
}

export interface CycleStats {
  at: Date;
  checks: number;
  durationMs: number;
}

export interface Watchdog {
  /** เรียกเมื่อ heartbeat เขียนฐานข้อมูลสำเร็จ */
  ok(): void;
  stop(): void;
}

/**
 * heartbeat ไม่สำเร็จนานเกิน maxStaleMs (ฐานข้อมูลค้าง / pool ตัน / ลูปค้าง) → onStale (ปกติคือ exit ให้ Docker รีสตาร์ท)
 * restart: unless-stopped ของ Docker ไม่รีสตาร์ท container ที่แค่ "unhealthy" — Worker ต้องออกเอง
 */
export function startWatchdog(opts: {
  maxStaleMs: number;
  onStale: (staleMs: number) => void;
  intervalMs?: number;
  now?: () => number;
}): Watchdog {
  const now = opts.now ?? Date.now;
  let lastOk = now();
  const timer = setInterval(() => {
    const stale = now() - lastOk;
    if (stale > opts.maxStaleMs) opts.onStale(stale);
  }, opts.intervalMs ?? 15_000);
  return {
    ok: () => void (lastOk = now()),
    stop: () => clearInterval(timer),
  };
}

export async function beat(db: Database, info: WorkerInfo, cycle: CycleStats | null): Promise<void> {
  const values = {
    workerId: info.workerId,
    hostname: os.hostname(),
    pid: process.pid,
    version: info.version ?? null,
    startedAt: info.startedAt,
    lastCycleAt: cycle?.at ?? null,
    lastCycleChecks: cycle?.checks ?? null,
    lastCycleMs: cycle?.durationMs ?? null,
  };
  await db
    .insert(workerHeartbeats)
    .values(values)
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { ...values, lastSeenAt: sql`now()` } });
  // ช่องละ 5 นาทีสำหรับกราฟ heartbeat 24 ชม. บนหน้าสถานะระบบ
  await db.execute(sql`
    INSERT INTO heartbeat_slots (slot, beats)
    VALUES (to_timestamp(floor(extract(epoch FROM now()) / 300) * 300), 1)
    ON CONFLICT (slot) DO UPDATE SET beats = heartbeat_slots.beats + 1
  `);

  // touch หลังเขียน DB สำเร็จเท่านั้น → ถ้าต่อ DB ไม่ได้ container จะกลายเป็น unhealthy
  await writeFile(ALIVE_FILE, String(Date.now()));
}
