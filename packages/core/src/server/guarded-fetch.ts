import { Agent, request } from "undici";
import { checkTargetUrl } from "../ssrf/validate-url";
import { createGuardedLookup } from "./guarded-lookup";
import { USER_AGENT } from "./http-check";

export interface FetchedBytes {
  status: number;
  contentType: string | null;
  finalUrl: string;
  body: Buffer;
  truncated: boolean;
  headers: Record<string, string | string[] | undefined>;
  /** URL ทุก hop ก่อนถึงปลายทาง (ไม่รวม finalUrl) */
  redirectChain: string[];
}

export interface FetchBytesOptions {
  timeoutMs?: number;
  maxBytes: number;
  maxRedirects?: number;
  accept?: string;
  /** false = ไม่ตาม redirect (คืน response 3xx ให้ผู้เรียกดู Location เอง) */
  followRedirects?: boolean;
  /** ใช้ในเทสต์เท่านั้น */
  allowPrivate?: boolean;
}

/**
 * GET ผ่าน SSRF guard เดียวกับการตรวจเว็บ: ตรวจปลายทางทุก hop, ตาม redirect เอง,
 * และอ่าน body ไม่เกิน maxBytes (เกินแล้วตัดทิ้ง ไม่โหลดต่อ)
 */
export async function fetchBytesGuarded(rawUrl: string, opts: FetchBytesOptions): Promise<FetchedBytes> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = new URL(rawUrl);
  const chain: string[] = [];
  for (let hop = 0; ; hop++) {
    const check = checkTargetUrl(current, { allowPrivate: opts.allowPrivate });
    if (!check.ok) throw Object.assign(new Error(check.message), { code: "SSRF_BLOCKED" });
    const agent = new Agent({
      connect: { timeout: timeoutMs, lookup: createGuardedLookup({ allowPrivate: opts.allowPrivate }) },
      keepAliveTimeout: 1,
      connections: 1,
    });
    try {
      const res = await request(current, {
        method: "GET",
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs + 1_000),
        headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "*/*" },
      });
      const location = res.headers.location;
      if (
        opts.followRedirects !== false &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        typeof location === "string"
      ) {
        res.body.destroy();
        if (hop >= maxRedirects) throw new Error("redirect เกินจำนวนที่กำหนด");
        chain.push(current.toString());
        current = new URL(location, current);
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res.body as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > opts.maxBytes) {
          chunks.push(chunk.subarray(0, opts.maxBytes - (size - chunk.length)));
          truncated = true;
          res.body.destroy();
          break;
        }
        chunks.push(chunk);
      }
      const ct = res.headers["content-type"];
      return {
        status: res.statusCode,
        contentType: typeof ct === "string" ? ct.split(";")[0]!.trim().toLowerCase() : null,
        finalUrl: current.toString(),
        body: Buffer.concat(chunks),
        truncated,
        headers: res.headers,
        redirectChain: chain,
      };
    } finally {
      void agent.close().catch(() => {});
    }
  }
}
