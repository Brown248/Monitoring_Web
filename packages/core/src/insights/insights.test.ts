import { describe, expect, it } from "vitest";
import { detectAnomalies, isLearning, type AnomalyBaseline } from "./anomaly";
import { diffFingerprints, isFingerprint, type Fingerprint } from "./changes";
import { diagnoseVerdict, type DiagnosisFacts } from "./diagnose";
import { dependenciesOf, layerOf, rootCauseFor, wouldCreateCycle, type Edge } from "./graph";
import { journeySchema, loginTemplate, secretEnvName, secretsUsed } from "./journey";

const healthy: DiagnosisFacts = {
  scheme: "https",
  host: "app.example.com",
  port: 443,
  canaryFailing: false,
  dnsSystem: { addresses: ["93.184.216.34"], error: null },
  dnsPublic: { addresses: ["93.184.216.34"], error: null, resolver: "1.1.1.1" },
  lastGoodIp: "93.184.216.34",
  privateIp: false,
  tcp: { ok: true, error: null, ms: 12 },
  tls: { ok: true, authError: null, daysLeft: 60, error: null },
  http: { status: 200, ms: 300, server: "nginx", cdn: null, error: null },
  slowMs: 3000,
};
const facts = (patch: Partial<DiagnosisFacts>): DiagnosisFacts => ({ ...healthy, ...patch });

describe("diagnoseVerdict", () => {
  it("ทุกชั้นปกติ → ok", () => {
    expect(diagnoseVerdict(healthy).layer).toBe("ok");
    expect(diagnoseVerdict(healthy).severity).toBe("ok");
  });

  it("เน็ตของ Worker เองหลุด มาก่อนทุกอย่าง", () => {
    const v = diagnoseVerdict(
      facts({ canaryFailing: true, http: null, tcp: { ok: false, error: "TIMEOUT", ms: null } }),
    );
    expect(v.layer).toBe("worker-network");
  });

  it("DNS หาไม่เจอจากทุกที่ → dns", () => {
    const v = diagnoseVerdict(
      facts({
        dnsSystem: { addresses: [], error: "ENOTFOUND" },
        dnsPublic: { addresses: [], error: "ENOTFOUND", resolver: null },
        tcp: null,
        tls: null,
        http: null,
      }),
    );
    expect(v.layer).toBe("dns");
    expect(v.severity).toBe("down");
  });

  it("DNS ของเครือข่ายพัง แต่ DNS สาธารณะตอบ → dns-internal", () => {
    const v = diagnoseVerdict(
      facts({ dnsSystem: { addresses: [], error: "ETIMEOUT" }, tcp: null, tls: null, http: null }),
    );
    expect(v.layer).toBe("dns-internal");
  });

  it("ปลายทางเป็น IP ภายใน → blocked", () => {
    expect(diagnoseVerdict(facts({ privateIp: true, tcp: null, tls: null, http: null })).layer).toBe(
      "blocked",
    );
  });

  it("TCP ถูกปฏิเสธ / timeout", () => {
    expect(
      diagnoseVerdict(facts({ tcp: { ok: false, error: "ECONNREFUSED", ms: 3 }, tls: null, http: null }))
        .layer,
    ).toBe("server-refused");
    expect(
      diagnoseVerdict(facts({ tcp: { ok: false, error: "TIMEOUT", ms: 5000 }, tls: null, http: null })).layer,
    ).toBe("network");
  });

  it("ใบรับรองหมดอายุ → tls", () => {
    const v = diagnoseVerdict(
      facts({ tls: { ok: false, authError: "CERT_HAS_EXPIRED", daysLeft: -3, error: null }, http: null }),
    );
    expect(v.layer).toBe("tls");
  });

  it("Cloudflare 530 → cdn-origin (Tunnel) พร้อมวิธีแก้", () => {
    const v = diagnoseVerdict(
      facts({ http: { status: 530, ms: 70, server: "cloudflare", cdn: "cloudflare", error: null } }),
    );
    expect(v.layer).toBe("cdn-origin");
    expect(v.title).toContain("530");
    expect(v.actions.length).toBeGreaterThan(0);
    // ชั้นก่อนหน้าผ่านแล้ว → บอกว่าส่วนไหนปกติ
    expect(v.healthy.length).toBeGreaterThan(0);
  });

  it("5xx ทั่วไป → app, 403 → access, 404 → path", () => {
    expect(diagnoseVerdict(facts({ http: { ...healthy.http!, status: 502 } })).layer).toBe("app");
    expect(diagnoseVerdict(facts({ http: { ...healthy.http!, status: 500 } })).layer).toBe("app");
    expect(diagnoseVerdict(facts({ http: { ...healthy.http!, status: 403 } })).layer).toBe("access");
    expect(diagnoseVerdict(facts({ http: { ...healthy.http!, status: 404 } })).layer).toBe("path");
  });

  it("ตอบช้ากว่าเกณฑ์ → slow (warn)", () => {
    const v = diagnoseVerdict(facts({ http: { ...healthy.http!, ms: 4200 } }));
    expect(v.layer).toBe("slow");
    expect(v.severity).toBe("warn");
  });
});

const fp = (
  patch: {
    dns?: Partial<Fingerprint["dns"]>;
    tls?: Fingerprint["tls"];
    http?: Partial<Fingerprint["http"]>;
  } = {},
): Fingerprint => ({
  dns: { ips: ["1.1.1.1"], cname: [], ns: ["a.ns.example", "b.ns.example"], error: null, ...patch.dns },
  tls:
    patch.tls === undefined
      ? { issuer: "R3", validTo: "2026-12-01T00:00:00.000Z", fingerprint: "AA", authError: null, error: null }
      : patch.tls,
  http: {
    status: 200,
    finalUrl: "https://x.example/",
    redirects: 0,
    server: "nginx/1.24",
    poweredBy: null,
    cdn: null,
    title: "Home",
    generator: null,
    size: 10_000,
    error: null,
    ...patch.http,
  },
});

describe("diffFingerprints", () => {
  it("เหมือนเดิม → ไม่มีการเปลี่ยนแปลง", () => {
    expect(diffFingerprints(fp(), fp())).toEqual([]);
  });

  it("เปลี่ยน Nameserver = high, IP (ไม่มี CDN) = medium, server = low", () => {
    const changes = diffFingerprints(
      fp(),
      fp({ dns: { ns: ["evil.ns.example"], ips: ["2.2.2.2"] }, http: { server: "nginx/1.26" } }),
    );
    const by = Object.fromEntries(changes.map((c) => [c.field, c.severity]));
    expect(by["dns.ns"]).toBe("high");
    expect(by["dns.ips"]).toBe("medium");
    expect(by["http.server"]).toBe("low");
  });

  it("IP ของเว็บหลัง CDN สลับ = low", () => {
    const a = fp({ http: { cdn: "cloudflare" } });
    const b = fp({ dns: { ips: ["3.3.3.3"] }, http: { cdn: "cloudflare" } });
    expect(diffFingerprints(a, b).find((c) => c.field === "dns.ips")?.severity).toBe("low");
  });

  it("ต่ออายุใบรับรอง = info, ใบรับรองใหม่จากผู้ออกคนอื่นที่อายุสั้นลง = medium", () => {
    const renewed = diffFingerprints(
      fp(),
      fp({
        tls: {
          issuer: "R3",
          validTo: "2027-03-01T00:00:00.000Z",
          fingerprint: "BB",
          authError: null,
          error: null,
        },
      }),
    );
    expect(renewed.find((c) => c.field === "tls.cert")?.severity).toBe("info");
    const swapped = diffFingerprints(
      fp(),
      fp({
        tls: {
          issuer: "Unknown CA",
          validTo: "2026-06-01T00:00:00.000Z",
          fingerprint: "CC",
          authError: null,
          error: null,
        },
      }),
    );
    expect(swapped.find((c) => c.field === "tls.cert")?.severity).toBe("medium");
  });

  it("รอบที่เก็บไม่ได้ (เว็บล่ม) ไม่นับเป็นการเปลี่ยนแปลงปลอม", () => {
    const down = fp({ http: { status: null, error: "ECONNREFUSED", server: null, title: null } });
    expect(diffFingerprints(fp(), down)).toEqual([]);
    expect(diffFingerprints(down, fp())).toEqual([]);
  });

  it("status class เปลี่ยน (200 → 500) = medium, 200 → 204 ไม่นับ", () => {
    expect(diffFingerprints(fp(), fp({ http: { status: 503 } })).some((c) => c.field === "http.status")).toBe(
      true,
    );
    expect(diffFingerprints(fp(), fp({ http: { status: 204 } })).some((c) => c.field === "http.status")).toBe(
      false,
    );
  });

  it("ขนาดหน้าเปลี่ยนเกิน 50% เท่านั้นที่นับ", () => {
    expect(diffFingerprints(fp(), fp({ http: { size: 12_000 } })).some((c) => c.field === "http.size")).toBe(
      false,
    );
    expect(diffFingerprints(fp(), fp({ http: { size: 2_000 } })).some((c) => c.field === "http.size")).toBe(
      true,
    );
  });
});

describe("diffFingerprints — กันรายการหลอก", () => {
  it("CNAME ถามไม่ทัน (timeout) ไม่นับเป็นการเปลี่ยน", () => {
    const a = fp({ dns: { cname: ["x.cdn.net"] } });
    const b = fp({ dns: { cname: [], cnameError: "TIMEOUT" } });
    expect(diffFingerprints(a, b).some((c) => c.field === "dns.cname")).toBe(false);
  });

  it("DNS หมุนเวียน (ยังมี IP ซ้ำชุดเดิม) = low · ย้ายไปชุดใหม่ทั้งหมด = medium", () => {
    const a = fp({ dns: { ips: ["1.1.1.1", "2.2.2.2"] } });
    expect(
      diffFingerprints(a, fp({ dns: { ips: ["2.2.2.2", "3.3.3.3"] } })).find((c) => c.field === "dns.ips")
        ?.severity,
    ).toBe("low");
    expect(
      diffFingerprints(a, fp({ dns: { ips: ["9.9.9.9"] } })).find((c) => c.field === "dns.ips")?.severity,
    ).toBe("medium");
  });

  it("URL ปลายทางที่ต่างกันแค่ query (state=, session) ไม่นับ", () => {
    const a = fp({ http: { finalUrl: "https://sso.x.com/login?state=abc" } });
    const b = fp({ http: { finalUrl: "https://sso.x.com/login?state=xyz" } });
    expect(diffFingerprints(a, b).some((c) => c.field === "http.finalUrl")).toBe(false);
    const moved = fp({ http: { finalUrl: "https://other.x.com/login" } });
    expect(diffFingerprints(a, moved).some((c) => c.field === "http.finalUrl")).toBe(true);
  });

  it("ใบรับรองรุ่นเก่ากว่าจากผู้ออกเดียวกัน (เซิร์ฟเวอร์สลับกันตอบ) = low", () => {
    const older = fp({
      tls: {
        issuer: "R3",
        validTo: "2026-09-01T00:00:00.000Z",
        fingerprint: "ZZ",
        authError: null,
        error: null,
      },
    });
    const c = diffFingerprints(fp(), older).find((x) => x.field === "tls.cert");
    expect(c?.severity).toBe("low");
    expect(c?.label).toContain("สลับ");
  });

  it("isFingerprint: ข้อมูลเสียหาย/ว่าง → false (เริ่มเก็บใหม่ ไม่ crash)", () => {
    expect(isFingerprint(fp())).toBe(true);
    expect(isFingerprint({})).toBe(false);
    expect(isFingerprint(null)).toBe(false);
    expect(isFingerprint({ dns: {}, http: {} })).toBe(false);
  });
});

describe("detectAnomalies", () => {
  const base: AnomalyBaseline = { median: 300, p90: 450, samples: 500, flakyRate: 0.01 };

  it("ข้อมูลไม่พอ = กำลังเรียนรู้ ไม่เตือน", () => {
    const b = { ...base, samples: 10 };
    expect(isLearning(b)).toBe(true);
    expect(detectAnomalies(b, { upMs: [5000, 5000, 5000, 5000], total: 10, flaky: 10 }, "high")).toEqual([]);
  });

  it("ช้ากว่าปกติ 3 ใน 4 ครั้ง → slow", () => {
    const a = detectAnomalies(base, { upMs: [300, 1500, 1600, 1700], total: 12, flaky: 0 }, "normal");
    expect(a.map((x) => x.kind)).toEqual(["slow"]);
    expect(a[0]!.factor).toBeGreaterThan(4);
  });

  it("ช้าแค่ครั้งเดียว (spike) → ไม่เตือน", () => {
    expect(detectAnomalies(base, { upMs: [300, 290, 5000, 310], total: 12, flaky: 0 }, "high")).toEqual([]);
  });

  it("เว็บที่ปกติช้าอยู่แล้ว ต้องช้ากว่าปกติอย่างน้อย 800 ms ถึงนับ", () => {
    const fast: AnomalyBaseline = { median: 40, p90: 60, samples: 500, flakyRate: 0 };
    // 4 เท่าของ 40 ms = 160 ms — ยังไม่ใช่ปัญหาจริง
    expect(detectAnomalies(fast, { upMs: [200, 210, 220, 230], total: 12, flaky: 0 }, "high")).toEqual([]);
  });

  it("ล้มเหลว/ต้อง retry บ่อยผิดปกติ → unstable", () => {
    const a = detectAnomalies(base, { upMs: [300, 300, 300], total: 12, flaky: 5 }, "normal");
    expect(a.map((x) => x.kind)).toEqual(["unstable"]);
  });

  it("เว็บที่ปกติก็ไม่นิ่งอยู่แล้ว ไม่เตือนง่าย ๆ", () => {
    const flaky: AnomalyBaseline = { ...base, flakyRate: 0.2 };
    expect(detectAnomalies(flaky, { upMs: [300], total: 12, flaky: 5 }, "normal")).toEqual([]);
  });

  it("ความไวมีผล: 2× ช้า เตือนเฉพาะ high", () => {
    const recent = { upMs: [1200, 1200, 1200, 1200], total: 12, flaky: 0 };
    expect(detectAnomalies(base, recent, "high").length).toBe(1);
    expect(detectAnomalies(base, recent, "low").length).toBe(0);
  });
});

describe("graph", () => {
  // CRM → API → DB, Portal → API, Portal → SSO
  const edges: Edge[] = [
    [1, 2],
    [2, 3],
    [4, 2],
    [4, 5],
  ];

  it("dependenciesOf รวมทางอ้อม", () => {
    expect([...dependenciesOf(edges, 1)].sort()).toEqual([2, 3]);
    expect([...dependenciesOf(edges, 3)]).toEqual([]);
  });

  it("wouldCreateCycle", () => {
    expect(wouldCreateCycle(edges, 3, 1)).toBe(true); // DB → CRM จะวน
    expect(wouldCreateCycle(edges, 1, 1)).toBe(true);
    expect(wouldCreateCycle(edges, 1, 5)).toBe(false);
  });

  it("layerOf: ฐานอยู่ชั้น 0", () => {
    const l = layerOf(edges, [1, 2, 3, 4, 5]);
    expect(l.get(3)).toBe(0);
    expect(l.get(5)).toBe(0);
    expect(l.get(2)).toBe(1);
    expect(l.get(1)).toBe(2);
    expect(l.get(4)).toBe(2);
  });

  it("rootCauseFor เลือกตัวที่ลึกสุดที่ล่มอยู่", () => {
    expect(rootCauseFor(edges, 1, new Set([2, 3]))).toBe(3);
    expect(rootCauseFor(edges, 1, new Set([2]))).toBe(2);
    expect(rootCauseFor(edges, 1, new Set([5]))).toBe(null); // SSO ไม่เกี่ยวกับ CRM
    expect(rootCauseFor(edges, 3, new Set([1, 2]))).toBe(null); // DB ไม่พึ่งใคร
  });

  it("ข้อมูลวน (ไม่ควรเกิด) ไม่ทำให้ค้าง", () => {
    const cyc: Edge[] = [
      [1, 2],
      [2, 1],
    ];
    expect([...dependenciesOf(cyc, 1)]).toEqual([2]);
    expect(layerOf(cyc, [1, 2]).size).toBe(2);
  });
});

describe("journeySchema", () => {
  it("แม่แบบ login ใช้ secret และผ่าน schema หลังใส่ selector", () => {
    const steps = loginTemplate("https://crm.example.com/login", "CRM");
    steps[4] = { action: "waitFor", selector: "#dashboard" };
    expect(journeySchema.safeParse({ enabled: true, intervalMinutes: 15, steps }).success).toBe(true);
    expect(secretsUsed(steps)).toEqual(["JOURNEY_CRM_USER", "JOURNEY_CRM_PASS"]);
    expect(secretEnvName("crm_pass")).toBe("JOURNEY_CRM_PASS");
  });

  it("ปฏิเสธขั้นตอนที่ขาดข้อมูล / URL ผิด / secret ผิดรูปแบบ", () => {
    const bad = (steps: unknown[]) =>
      journeySchema.safeParse({ enabled: true, intervalMinutes: 15, steps }).success;
    expect(bad([{ action: "goto", value: "javascript:alert(1)" }])).toBe(false);
    expect(bad([{ action: "fill", selector: "#a" }])).toBe(false);
    expect(bad([{ action: "click" }])).toBe(false);
    expect(bad([{ action: "fill", selector: "#p", value: "secret:bad name" }])).toBe(false);
    expect(bad([])).toBe(false);
    expect(
      journeySchema.safeParse({
        enabled: true,
        intervalMinutes: 7,
        steps: [{ action: "goto", value: "https://a.b" }],
      }).success,
    ).toBe(false);
  });
});
