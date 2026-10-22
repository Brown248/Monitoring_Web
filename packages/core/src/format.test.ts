import { describe, expect, it } from "vitest";
import { formatPercent } from "./format";

describe("formatPercent", () => {
  it("100% เฉพาะเมื่อไม่เคยล่มจริง ๆ", () => {
    expect(formatPercent(1)).toBe("100%");
    // ล่ม 1 ครั้งใน 25,000 → ต้องไม่ปัดขึ้นเป็น 100.00%
    expect(formatPercent(1 - 1 / 25_000)).toBe("99.99%");
    expect(formatPercent(0.99999)).toBe("99.99%");
  });

  it("ปัดลง ทศนิยมตามที่กำหนด", () => {
    expect(formatPercent(0.9962)).toBe("99.62%");
    expect(formatPercent(0.5)).toBe("50.00%");
    expect(formatPercent(0)).toBe("0.00%");
    expect(formatPercent(0.33333, 1)).toBe("33.3%");
    // float: 0.29 × 100 = 28.999… ต้องได้ 29.00 ไม่ใช่ 28.99
    expect(formatPercent(0.29)).toBe("29.00%");
    expect(formatPercent(0.57)).toBe("57.00%");
  });

  it("ไม่มีข้อมูล → ขีด", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});
