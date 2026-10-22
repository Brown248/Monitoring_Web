import { describe, expect, it } from "vitest";
import { distinctTones, ICON_TONES, siteInitials, stableHash, toneOf } from "./initials";

describe("siteInitials", () => {
  it.each([
    ["IoT Yomnan", "IY"],
    ["App IoT Yomnan", "AI"],
    ["TFP Dashboard", "TD"],
    ["ThingsBoard", "TB"],
    ["Smart Building", "SB"],
    ["Syn Hub Studio", "SH"],
    ["CRM", "CRM"],
    ["JIG API", "JA"],
    ["crm", "C"],
    ["VE Synexta AI", "VS"],
    ["smart-locker", "SL"],
    ["เว็บบริษัท", "ว"],
    ["ระบบ แจ้งซ่อม", "รจ"],
    ["  ", "?"],
    ["***", "?"],
  ])("%s → %s", (name, expected) => {
    expect(siteInitials(name)).toBe(expected);
  });
});

describe("distinctTones", () => {
  it("เว็บในกลุ่มเดียวกันได้สีไม่ซ้ำกันเสมอ แม้ชื่อจะ hash ชนกัน", () => {
    const names = Array.from({ length: ICON_TONES }, (_, i) => `site ${i}`);
    expect(new Set(distinctTones(names)).size).toBe(ICON_TONES);
    expect(new Set(distinctTones(["CRM", "CRM", "crm"])).size).toBe(3);
  });

  it("เว็บแรกในกลุ่มได้สีเดียวกับสีตามชื่อ (ไม่กะพริบเปลี่ยนสีตอนโหลด)", () => {
    expect(distinctTones(["ThingsBoard", "IoT Yomnan"])[0]).toBe(toneOf("ThingsBoard"));
  });
});

describe("stableHash", () => {
  it("ชื่อเดิมได้ค่าเดิม ชื่อต่างได้ค่าต่าง", () => {
    expect(stableHash("CRM")).toBe(stableHash("CRM"));
    expect(stableHash("CRM")).not.toBe(stableHash("ThingsBoard"));
  });
});
