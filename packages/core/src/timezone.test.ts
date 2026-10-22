import { describe, expect, it } from "vitest";
import { isValidTimeZone } from "./timezone";

describe("isValidTimeZone", () => {
  it("accepts IANA names", () => {
    for (const tz of ["Asia/Bangkok", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+7"])
      expect(isValidTimeZone(tz)).toBe(true);
  });
  it("rejects offsets, abbreviations-with-typos and garbage", () => {
    for (const tz of ["+07:00", "Asia/Bangkokk", "", "Asia/Bangkok; DROP TABLE x", "ICT/x"])
      expect(isValidTimeZone(tz)).toBe(false);
  });
});
