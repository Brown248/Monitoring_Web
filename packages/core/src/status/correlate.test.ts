import { describe, expect, it } from "vitest";
import { baseDomain, correlateOutages, type OutageInput } from "./correlate";

const t0 = new Date("2026-10-21T02:00:00Z").getTime();
let seq = 0;
function o(name: string, url: string, minute: number, extra: Partial<OutageInput> = {}): OutageInput {
  seq++;
  return {
    incidentId: seq,
    websiteId: seq,
    name,
    url,
    startedAt: new Date(t0 + minute * 60_000),
    recoveredAt: null,
    errorCode: "CONNECT_TIMEOUT",
    remoteIp: null,
    ...extra,
  };
}

describe("correlateOutages", () => {
  it("groups sites on the same server IP", () => {
    const groups = correlateOutages([
      o("A", "https://a.example.com", 0, { remoteIp: "203.0.113.5" }),
      o("B", "https://b.other.org", 2, { remoteIp: "203.0.113.5" }),
      o("C", "https://c.third.net", 1, { remoteIp: "198.51.100.9" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("server");
    expect(groups[0]!.members.map((m) => m.name)).toEqual(["A", "B"]);
  });

  it("does not group outages far apart in time", () => {
    const groups = correlateOutages([
      o("A", "https://a.x.com", 0, { remoteIp: "203.0.113.5" }),
      o("B", "https://b.y.com", 45, { remoteIp: "203.0.113.5" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("groups by shared domain, then DNS, then a burst — each site in one group only", () => {
    const groups = correlateOutages(
      [
        o("Shop", "https://shop.mycompany.co.th", 0),
        o("HR", "https://hr.mycompany.co.th", 1),
        o("X", "https://x.alpha.com", 2, { errorCode: "DNS" }),
        o("Y", "https://y.beta.com", 3, { errorCode: "DNS" }),
        o("Z", "https://z.gamma.com", 3, { errorCode: "DNS" }),
      ],
      { canaryFailing: true },
    );
    expect(groups.map((g) => g.kind).sort()).toEqual(["dns", "domain"]);
    const all = groups.flatMap((g) => g.members.map((m) => m.name));
    expect(new Set(all).size).toBe(all.length);
  });

  it("reports a burst of unrelated sites with the canary hint", () => {
    const groups = correlateOutages(
      [o("P", "https://p.one.com", 0), o("Q", "https://q.two.com", 1), o("R", "https://r.three.com", 2)],
      { canaryFailing: true },
    );
    expect(groups[0]!.kind).toBe("burst");
    expect(groups[0]!.hint).toContain("Canary");
  });

  it("extracts base domains including Thai second-level domains", () => {
    expect(baseDomain("shop.mycompany.co.th")).toBe("mycompany.co.th");
    expect(baseDomain("a.b.example.com")).toBe("example.com");
    expect(baseDomain("example.com")).toBe("example.com");
    // โฮสต์ร่วม: คนละเจ้าของ → คนละโดเมน (ไม่ยอมให้ค่าลับของ alice ไปกรอกบนเว็บของ bob)
    expect(baseDomain("alice.github.io")).toBe("alice.github.io");
    expect(baseDomain("docs.alice.github.io")).toBe("alice.github.io");
    expect(baseDomain("bob.github.io")).not.toBe(baseDomain("alice.github.io"));
    expect(baseDomain("my-app.vercel.app")).toBe("my-app.vercel.app");
  });
});
