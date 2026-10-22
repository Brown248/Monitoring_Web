import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./logger";

describe("redact", () => {
  it("hides values of sensitive keys at any depth", () => {
    const out = redact({ smtp: { host: "mail", password: "p@ss" }, apiKey: "k", token: "t" });
    expect(out).toEqual({
      smtp: { host: "mail", password: "[REDACTED]" },
      apiKey: "[REDACTED]",
      token: "[REDACTED]",
    });
  });

  it("strips credentials embedded in URLs", () => {
    expect(redact("postgres://monitor:secret123@db:5432/monitor")).toBe(
      "postgres://[REDACTED]@db:5432/monitor",
    );
  });
});

describe("createLogger", () => {
  it("respects the minimum level and writes redacted JSON", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", write: (l) => lines.push(l) });
    log.debug("skipped");
    log.info("hello", { authorization: "Bearer x" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "hello", authorization: "[REDACTED]" });
  });
});
