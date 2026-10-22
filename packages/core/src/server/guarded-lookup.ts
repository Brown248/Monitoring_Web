import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { isBlockedIp } from "../ssrf/ip-policy";

export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(
    readonly hostname: string,
    readonly address: string,
    /** ทุก IP ที่ resolve ได้เป็น IP ภายใน (DNS ชี้ผิด) — ไม่ใช่แค่บางตัว */
    readonly allPrivate = false,
  ) {
    super(`${hostname} resolve เป็น IP ภายใน (${address})`);
    this.name = "SsrfBlockedError";
  }
}

export interface LookupObserver {
  onResolved?(addresses: LookupAddress[], durationMs: number): void;
  /** ใช้ในเทสต์เท่านั้น — worker/web ไม่เปิดค่านี้ */
  allowPrivate?: boolean;
}

/**
 * dns.lookup ที่ปฏิเสธเมื่อ IP ใดที่ resolve ได้เป็น private/reserved
 * ใช้เป็น connect.lookup ของ undici → ตรวจที่ระดับ socket ทุกครั้งที่เชื่อมต่อ (กัน DNS rebinding)
 */
export function createGuardedLookup(observer?: LookupObserver): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    const started = performance.now();
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as LookupAddress[];
      if (list.length === 0) {
        const e = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        return callback(e);
      }
      const bad = observer?.allowPrivate ? undefined : list.find((a) => isBlockedIp(a.address));
      if (bad)
        return callback(
          new SsrfBlockedError(
            hostname,
            bad.address,
            list.every((a) => isBlockedIp(a.address)),
          ),
        );
      observer?.onResolved?.(list, performance.now() - started);
      if (options.all) return callback(null, list);
      const first = list[0]!;
      return callback(null, first.address, first.family);
    });
  }) as unknown as LookupFunction;
}
