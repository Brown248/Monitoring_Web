import { diffFingerprints, type Fingerprint } from "@app/core";
import { describe, expect, it } from "vitest";
import { mergeFingerprint } from "./insights";

const fp = (ns: string[], nsError: string | null = null): Fingerprint =>
  ({
    dns: { ips: ["1.2.3.4"], cname: [], ns, error: null, cnameError: null, nsError },
    tls: null,
    http: { status: 200, finalUrl: null, redirects: 0, server: null, poweredBy: null, error: null },
  }) as unknown as Fingerprint;

describe("nameserver change detection survives a failed NS lookup", () => {
  it("keeps the last known NS when a lookup times out, so a later hijack is still reported", () => {
    const good = fp(["ns1.registrar.com", "ns2.registrar.com"]);
    // รอบที่ถาม NS ไม่ได้ → เก็บค่าเดิมไว้ ไม่ใช่ค่าว่าง
    const stored = mergeFingerprint(good, fp([], "TIMEOUT"));
    expect(stored.dns.ns).toEqual(good.dns.ns);
    expect(diffFingerprints(good, fp([], "TIMEOUT"))).toEqual([]);
    // รอบถัดไป NS ถูกเปลี่ยนเป็นของผู้บุกรุก → ต้องแจ้ง
    const hijacked = fp(["ns1.attacker.net"]);
    const changes = diffFingerprints(stored, hijacked);
    expect(changes.map((c) => c.field)).toContain("dns.ns");
  });
});
