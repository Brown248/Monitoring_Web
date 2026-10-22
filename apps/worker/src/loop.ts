import type { Logger } from "@app/core";
import type { Website } from "@app/db";
import type { WorkerContext } from "./context";
import type { CycleStats } from "./heartbeat";
import { checkWebsite, claimDueChecks } from "./jobs/checks";

export interface Repeater {
  stop(): Promise<void>;
}

/** เรียก fn ซ้ำทุก intervalMs แบบไม่ซ้อนรอบ; error ถูก log แล้วรันรอบถัดไปต่อ */
export function every(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
  log: Logger,
  initialDelayMs = 0,
): Repeater {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const run = async () => {
    if (stopped) return;
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      log.error(`${name} failed`, { err });
    }
    if (!stopped) timer = setTimeout(schedule, Math.max(0, intervalMs - (Date.now() - started)));
  };
  const schedule = () => {
    running = run();
  };

  timer = setTimeout(schedule, initialDelayMs);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

/**
 * Pool ตรวจเว็บ: ทุก tick claim งานเท่าช่องว่าง (concurrency - กำลังตรวจอยู่) แล้วปล่อยให้ทำงานคู่ขนาน
 * เว็บที่ timeout นานไม่ขวางเว็บอื่น
 */
export class CheckPool {
  private readonly inFlight = new Set<Promise<void>>();
  /** เว็บที่กำลังตรวจอยู่ — ตรวจนานเกินรอบ (redirect หลายทอด/ช้า) ไม่ให้ตรวจซ้อน นับล้มเหลวซ้ำ */
  private readonly checking = new Set<number>();
  private windowChecks = 0;
  private windowStart = Date.now();
  lastCycle: CycleStats | null = null;

  constructor(private readonly ctx: WorkerContext) {}

  get active(): number {
    return this.inFlight.size;
  }

  async tick(): Promise<void> {
    const { check_defaults } = await this.ctx.settings();
    const free = check_defaults.concurrency - this.inFlight.size;
    if (free <= 0) return;
    const sites = await claimDueChecks(this.ctx.db, free);
    for (const site of sites) {
      if (this.checking.has(site.id)) {
        this.ctx.log.warn("check still running — skip overlapping round", { websiteId: site.id });
        continue;
      }
      this.start(site);
    }
  }

  private start(site: Website) {
    const started = Date.now();
    this.checking.add(site.id);
    const p = checkWebsite(this.ctx, site)
      .then((o) => {
        this.ctx.log.debug("checked", { websiteId: site.id, status: o.status, ms: Date.now() - started });
      })
      .catch((err: unknown) => {
        this.ctx.log.error("check failed", { websiteId: site.id, err });
      })
      .finally(() => {
        this.inFlight.delete(p);
        this.checking.delete(site.id);
        this.windowChecks += 1;
        // สรุป "รอบ" ทุก 5 นาที: จำนวนเว็บที่ตรวจ และเวลาที่ใช้
        if (Date.now() - this.windowStart >= 300_000) this.rollWindow();
      });
    this.inFlight.add(p);
  }

  private rollWindow() {
    this.lastCycle = { at: new Date(), checks: this.windowChecks, durationMs: Date.now() - this.windowStart };
    this.windowChecks = 0;
    this.windowStart = Date.now();
  }

  /** สถิติปัจจุบัน (ใช้ก่อนครบ 5 นาทีแรก) */
  stats(): CycleStats | null {
    if (this.lastCycle) return this.lastCycle;
    if (this.windowChecks === 0) return null;
    return { at: new Date(), checks: this.windowChecks, durationMs: Date.now() - this.windowStart };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}
