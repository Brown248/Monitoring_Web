import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGuardedProxy } from "./egress-proxy";
import { extractLookalikes, isOwnDomain, lookalikeSkeleton, typoVariants } from "./lookalike";
import { analyzeSecurity, gradeFor, runSecurityScan, type ScanInput } from "./security-scan";

const NOW = new Date("2026-10-21T00:00:00Z");

function input(over: Partial<ScanInput> = {}): ScanInput {
  return {
    url: "https://example.com/",
    page: {
      status: 200,
      finalUrl: "https://example.com/",
      body: "<html><head><title>ok</title></head><body>hi</body></html>",
      headers: {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    },
    pageError: null,
    httpProbe: { status: 301, location: "https://example.com/" },
    tls: {
      validTo: new Date("2027-06-01T00:00:00Z"),
      issuer: "Let's Encrypt",
      protocol: "TLSv1.3",
      authError: null,
    },
    tlsError: null,
    exposed: [],
    now: NOW,
    ...over,
  };
}

describe("analyzeSecurity", () => {
  it("gives A with no findings for a well-configured site", () => {
    const r = analyzeSecurity(input());
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.grade).toBe("A");
  });

  it("flags missing headers, http without redirect, and leaky cookies", () => {
    const r = analyzeSecurity(
      input({
        page: {
          status: 200,
          finalUrl: "https://example.com/",
          body: "",
          headers: { server: "Apache/2.4.29", "set-cookie": ["PHPSESSID=abc; path=/"] },
        },
        httpProbe: { status: 200, location: null },
      }),
    );
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "HSTS_MISSING",
        "CSP_MISSING",
        "XCTO_MISSING",
        "CLICKJACKING",
        "VERSION_DISCLOSURE",
        "COOKIE_FLAGS",
        "HTTP_NO_REDIRECT",
      ]),
    );
    expect(r.score).toBeLessThan(80);
  });

  it("treats expiring/invalid certificates and exposed files as high severity", () => {
    const r = analyzeSecurity(
      input({
        tls: {
          validTo: new Date("2026-10-28T00:00:00Z"),
          issuer: null,
          protocol: "TLSv1.2",
          authError: "CERT_HAS_EXPIRED",
        },
        exposed: [
          { path: "/.env", status: 200, body: "DB_PASSWORD=secret\nAPP_KEY=x" },
          { path: "/.git/HEAD", status: 200, body: "ref: refs/heads/main\n" },
          // soft-404: หน้า HTML ที่ตอบ 200 ไม่นับว่าหลุด
          { path: "/phpinfo.php", status: 200, body: "<html>Not found</html>" },
        ],
      }),
    );
    const high = r.findings.filter((f) => f.severity === "high").map((f) => f.id);
    expect(high).toEqual(
      expect.arrayContaining(["TLS_INVALID", "TLS_EXPIRING", "EXPOSED:/.env", "EXPOSED:/.git/HEAD"]),
    );
    expect(high).not.toContain("EXPOSED:/phpinfo.php");
    expect(["D", "F"]).toContain(r.grade);
  });

  it("detects mixed content and directory listing", () => {
    const r = analyzeSecurity(
      input({
        page: {
          ...input().page!,
          body: '<title>Index of /</title><script src="http://cdn.example.net/a.js"></script>',
        },
      }),
    );
    expect(r.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining(["DIRECTORY_LISTING", "MIXED_CONTENT"]),
    );
  });

  it("caps grade at C when any high finding exists", () => {
    expect(gradeFor(95, true)).toBe("C");
    expect(gradeFor(95, false)).toBe("A");
    expect(gradeFor(40, false)).toBe("F");
  });
});

describe("lookalike", () => {
  it("generates typo variants without the original", () => {
    const v = typoVariants("google");
    expect(v).toContain("g0ogle");
    expect(v).toContain("gogle");
    expect(v).not.toContain("google");
    expect(v.length).toBeLessThanOrEqual(12);
  });

  it("extracts suspicious domains and skips the company's own", () => {
    const rows = [
      {
        id: 1,
        issuer_name: "C=US, O=Let's Encrypt, CN=R11",
        name_value: "mycompany-login.com\n*.mycompany-login.com",
        not_before: "2026-10-18T10:00:00",
      },
      { id: 2, issuer_name: null, name_value: "shop.mycompany.co.th", not_before: "2026-10-18T10:00:00" },
      { id: 3, issuer_name: null, name_value: "unrelated.org", not_before: "2026-10-18T10:00:00" },
    ];
    const hits = extractLookalikes(
      rows,
      { query: "mycompany", keyword: "mycompany", similarity: "contains" },
      ["mycompany.co.th"],
    );
    expect(hits.map((h) => h.domain)).toEqual(["mycompany-login.com"]);
    expect(hits[0]!.issuer).toBe("Let's Encrypt");
    expect(isOwnDomain("a.b.mycompany.co.th", ["mycompany.co.th"])).toBe(true);
    expect(extractLookalikes("not an array", { query: "x", keyword: "x", similarity: "typo" }, [])).toEqual(
      [],
    );
  });
});

describe("guarded egress proxy", () => {
  let target: http.Server;
  let port: number;
  beforeAll(async () => {
    target = http.createServer((_req, res) => res.end("internal secret"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    port = (target.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => target.close(() => r())));

  function viaProxy(proxyUrl: string, url: string): Promise<number> {
    const p = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: p.hostname, port: Number(p.port), path: url, method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function connectVia(proxyUrl: string, authority: string): Promise<number> {
    const p = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: p.hostname,
        port: Number(p.port),
        method: "CONNECT",
        path: authority,
      });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
  }

  it("blocks plain-http and CONNECT requests to private addresses", async () => {
    const proxy = await startGuardedProxy();
    try {
      expect(await viaProxy(proxy.url, `http://127.0.0.1:${port}/`)).toBe(403);
      expect(await viaProxy(proxy.url, `http://localhost:${port}/`)).toBe(403);
      expect(await connectVia(proxy.url, `127.0.0.1:${port}`)).toBe(403);
      expect(await connectVia(proxy.url, "10.0.0.1:443")).toBe(403);
      expect(proxy.blocked.length).toBeGreaterThanOrEqual(4);
    } finally {
      await proxy.close();
    }
  });

  it("allows private targets only when explicitly permitted (tests)", async () => {
    const proxy = await startGuardedProxy({ allowPrivate: true });
    try {
      expect(await viaProxy(proxy.url, `http://127.0.0.1:${port}/`)).toBe(200);
    } finally {
      await proxy.close();
    }
  });
});

describe("runSecurityScan on an error page", () => {
  it("refuses to grade a 5xx page (it is the proxy's error page, not the site)", async () => {
    const s = http.createServer((_req, res) => {
      res.statusCode = 502;
      res.end("Bad Gateway");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const port = (s.address() as AddressInfo).port;
      await expect(runSecurityScan(`http://127.0.0.1:${port}/`, { allowPrivate: true })).rejects.toThrow(
        "502",
      );
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("IDN lookalike domains", () => {
  it("sees through punycode + Cyrillic homoglyphs", () => {
    const fake = new URL("https://mycоmpany-login.com").hostname; // "о" ซีริลลิก → xn--...
    expect(fake.startsWith("xn--")).toBe(true);
    expect(lookalikeSkeleton(fake)).toBe("mycompany-login.com");
    const hits = extractLookalikes(
      [{ id: 1, name_value: fake, issuer_name: "O=Let's Encrypt", not_before: "2026-10-20 00:00:00" }],
      { query: "mycompany", keyword: "mycompany", similarity: "contains" },
      ["mycompany.co.th"],
    );
    expect(hits.map((h) => h.domain)).toEqual([fake]);
  });
});
