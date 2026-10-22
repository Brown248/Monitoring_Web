import { describe, expect, it } from "vitest";
import { safeNextPath, urlForAi } from "./safe-path";

describe("safeNextPath (กัน open redirect หลัง login)", () => {
  it("keeps normal in-app paths with their query", () => {
    expect(safeNextPath("/websites?q=abc&page=2")).toBe("/websites?q=abc&page=2");
    expect(safeNextPath("/incidents/12#notes")).toBe("/incidents/12#notes");
  });

  it("rejects every way of reaching another site", () => {
    for (const evil of [
      "//evil.com",
      "/\t/evil.com", // เบราว์เซอร์ตัด Tab → //evil.com
      "/\n/evil.com",
      "/\r\n/evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/ /evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "/%09/evil.com/../", // ไม่ถูก decode — path ปกติแต่ต้องไม่ใช่ origin อื่น
    ]) {
      const out = safeNextPath(evil);
      expect(new URL(out, "http://monitor.invalid").origin, evil).toBe("http://monitor.invalid");
    }
    expect(safeNextPath("/\t/evil.com")).toBe("/");
  });

  it("never sends the user back to login or to an API", () => {
    expect(safeNextPath("/login?next=/x")).toBe("/");
    expect(safeNextPath("/api/auth/logout")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("/" + "a".repeat(3000))).toBe("/");
  });
});

describe("urlForAi", () => {
  it("drops query strings, fragments and credentials before sending a URL to the AI provider", () => {
    expect(urlForAi("https://user:pw@api.example.com/health?token=SECRET#x")).toBe(
      "https://api.example.com/health",
    );
    expect(urlForAi("http://10.0.0.5:8080/")).toBe("http://10.0.0.5:8080/");
  });
});
