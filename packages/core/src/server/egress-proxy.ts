import http from "node:http";
import net from "node:net";
import { checkTargetUrl } from "../ssrf/validate-url";
import { createGuardedLookup } from "./guarded-lookup";

export interface GuardedProxy {
  url: string;
  /** ปลายทางที่ถูกบล็อก (เช่น IP ภายใน) ระหว่างที่ proxy เปิดอยู่ */
  blocked: string[];
  close(): Promise<void>;
}

function splitHostPort(authority: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:]+):(\d+)$/.exec(authority);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65_536 ? { host: m[1]!, port } : null;
}

/**
 * HTTP proxy บน 127.0.0.1 สำหรับ headless browser — ทุกคำขอของหน้าเว็บ (รวม script/รูป/iframe)
 * ต้องผ่านที่นี่ และถูกตรวจด้วย SSRF guard เดียวกับการตรวจเว็บ
 * หน้าเว็บที่ถูกแฮกจึงสั่งให้ browser ยิงเข้า IP ภายในองค์กรไม่ได้
 */
export async function startGuardedProxy(opts: { allowPrivate?: boolean } = {}): Promise<GuardedProxy> {
  const blocked: string[] = [];
  const lookup = createGuardedLookup({ allowPrivate: opts.allowPrivate });
  const deny = (what: string) => {
    if (blocked.length < 50) blocked.push(what);
  };

  // socket ของ CONNECT tunnel ไม่อยู่ใน closeAllConnections() → เก็บเองเพื่อปิดให้หมดตอน close
  const tunnels = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const check = checkTargetUrl(target, opts);
    if (!check.ok || target.protocol !== "http:") {
      deny(target.host);
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host: target.hostname.replace(/^\[|\]$/g, ""),
        port: Number(target.port || 80),
        method: req.method,
        path: target.pathname + target.search,
        headers,
        lookup,
        timeout: 20_000,
        // ไม่ใช้ keep-alive agent กลาง — ไม่งั้น connection ค้างหลังปิด browser
        agent: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if ((err as { code?: string }).code === "SSRF_BLOCKED") deny(target.host);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on("timeout", () => upstream.destroy());
    req.pipe(upstream);
  });

  // HTTPS: CONNECT host:port → ต่อ TCP ผ่าน guarded lookup แล้วส่งต่อแบบ tunnel
  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const hp = splitHostPort(req.url ?? "");
    const check = hp ? checkTargetUrl(`https://${req.url}/`, opts) : null;
    if (!hp || !check?.ok) {
      deny(req.url ?? "?");
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: hp.host, port: hp.port, lookup, timeout: 20_000 }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (err) => {
      if ((err as { code?: string }).code === "SSRF_BLOCKED") deny(hp.host);
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    upstream.on("timeout", () => upstream.destroy());
    client.on("error", () => upstream.destroy());
    tunnels.add(client);
    tunnels.add(upstream);
    // ฝั่งใดปิด ปิดอีกฝั่งด้วย (กัน half-open ค้าง)
    client.on("close", () => {
      tunnels.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      tunnels.delete(upstream);
      client.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of tunnels) s.destroy();
        tunnels.clear();
        server.closeAllConnections();
        server.close(() => resolve());
        // กันค้าง: ไม่ว่าอะไรเกิดขึ้น worker ต้องไปต่อได้
        setTimeout(resolve, 3_000).unref();
      }),
  };
}
