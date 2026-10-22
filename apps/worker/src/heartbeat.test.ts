import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWatchdog } from "./heartbeat";

describe("startWatchdog", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("fires once heartbeats stop succeeding for longer than the limit", () => {
    const onStale = vi.fn();
    const w = startWatchdog({ maxStaleMs: 300_000, onStale, intervalMs: 15_000 });
    vi.advanceTimersByTime(290_000);
    expect(onStale).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onStale).toHaveBeenCalled();
    expect(onStale.mock.calls[0]![0]).toBeGreaterThan(300_000);
    w.stop();
  });

  it("never fires while heartbeats keep succeeding", () => {
    const onStale = vi.fn();
    const w = startWatchdog({ maxStaleMs: 300_000, onStale, intervalMs: 15_000 });
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(30_000);
      w.ok();
    }
    expect(onStale).not.toHaveBeenCalled();
    w.stop();
  });

  it("stops checking after stop() (graceful shutdown)", () => {
    const onStale = vi.fn();
    const w = startWatchdog({ maxStaleMs: 1_000, onStale, intervalMs: 500 });
    w.stop();
    vi.advanceTimersByTime(10_000);
    expect(onStale).not.toHaveBeenCalled();
  });
});
