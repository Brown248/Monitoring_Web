import { describe, expect, it } from "vitest";
import { createGuardedLookup } from "../server/guarded-lookup";
import { classifyIp } from "./ip-policy";
import { checkTargetUrl } from "./validate-url";

describe("classifyIp", () => {
  it.each([
    ["10.1.2.3", "private"],
    ["172.20.0.1", "private"],
    ["192.168.1.10", "private"],
    ["127.0.0.1", "private"],
    ["169.254.169.254", "private"],
    ["100.64.0.1", "private"],
    ["0.0.0.0", "private"],
    ["::1", "private"],
    ["fe80::1", "private"],
    ["fd00::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:127.0.0.1", "private"],
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["2606:4700:4700::1111", "public"],
    ["not-an-ip", "invalid"],
  ])("%s → %s", (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });
});

describe("checkTargetUrl", () => {
  it("accepts public http(s) URLs", () => {
    const r = checkTargetUrl("https://www.example.com/health");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.port).toBe(443);
  });
  it.each([
    ["http://169.254.169.254/latest/meta-data", "PRIVATE_IP"],
    ["http://192.168.1.10:8080", "PRIVATE_IP"],
    ["http://[::1]/", "PRIVATE_IP"],
    ["http://[::ffff:7f00:1]/", "PRIVATE_IP"],
    ["https://admin:secret@site.example.com", "CREDENTIALS"],
    ["ftp://files.example.com", "SCHEME"],
    ["http://localhost:3000", "LOCALHOST"],
    ["not a url", "INVALID"],
  ])("rejects %s (%s)", (url, reason) => {
    const r = checkTargetUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});

describe("createGuardedLookup", () => {
  it("rejects hostnames that resolve to loopback", async () => {
    const lookup = createGuardedLookup();
    const err = await new Promise<unknown>((resolve) => {
      lookup("localhost", { all: true }, (e: unknown) => resolve(e));
    });
    expect((err as { code?: string }).code).toBe("SSRF_BLOCKED");
  });
});
