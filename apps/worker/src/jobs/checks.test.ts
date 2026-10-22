import { createLogger, type CheckOutcome } from "@app/core";
import { describe, expect, it } from "vitest";
import type { WorkerContext } from "../context";
import { confirmNotOurNetwork } from "./checks";

// ไม่ต้องใช้ฐานข้อมูล: canary สดอยู่แล้ว (ไม่ตรวจซ้ำ) และ DNS สาธารณะถูกแทนด้วยฟังก์ชันจำลอง
const ctx = (canaryFailingNow: boolean): WorkerContext =>
  ({
    log: createLogger({ level: "error" }),
    canary: { failing: canaryFailingNow, checkedAt: new Date() },
  }) as unknown as WorkerContext;

const down = (errorCode: CheckOutcome["errorCode"]): CheckOutcome => ({
  status: "DOWN",
  degraded: false,
  retries: 2,
  httpStatus: null,
  firstHttpStatus: null,
  responseTimeMs: null,
  errorCode,
  errorMessage: "x",
  finalUrl: null,
  redirectCount: 0,
  remoteIp: null,
  dnsMs: null,
  connectMs: null,
  tlsMs: null,
  startedAt: new Date(),
  finishedAt: new Date(),
});

const publicDns = (ips: string[]) => async () => ({ addresses: ips });

describe("confirmNotOurNetwork", () => {
  it("captive portal: canary ล้มด้วย → ไม่นับว่าเว็บล่ม (ทั้ง DNS และ redirect ไป IP ภายใน)", async () => {
    for (const code of ["PRIVATE_TARGET", "PRIVATE_REDIRECT", "TIMEOUT"] as const) {
      const r = await confirmNotOurNetwork(ctx(true), down(code), "https://crm.example.com/", publicDns([]));
      expect(r.status).toBe("UNKNOWN");
    }
  });

  it("DNS ภายในชี้ IP ภายใน แต่ DNS สาธารณะชี้ IP จริง (split-horizon) → UNKNOWN พร้อมคำอธิบาย", async () => {
    const r = await confirmNotOurNetwork(
      ctx(false),
      down("PRIVATE_TARGET"),
      "https://www.company.co.th/",
      publicDns(["10.0.0.5", "93.184.216.34"]),
    );
    expect(r.status).toBe("UNKNOWN");
    expect(r.errorMessage).toContain("93.184.216.34");
  });

  it("DNS ชี้ IP ภายในทั้งในเครือข่ายและสาธารณะ = ตั้งค่าผิดจริง → ยังล่ม", async () => {
    const r = await confirmNotOurNetwork(
      ctx(false),
      down("PRIVATE_TARGET"),
      "https://broken.example.com/",
      publicDns(["10.0.0.5"]),
    );
    expect(r.status).toBe("DOWN");
  });

  it("เว็บ redirect ไป localhost ขณะเน็ตปกติ → ล่มจริง", async () => {
    const r = await confirmNotOurNetwork(
      ctx(false),
      down("PRIVATE_REDIRECT"),
      "https://x.example.com/",
      publicDns([]),
    );
    expect(r.status).toBe("DOWN");
  });

  it("HTTP 500 ไม่ใช่ปัญหาเครือข่าย → ล่มแม้ canary ล้ม", async () => {
    const r = await confirmNotOurNetwork(
      ctx(true),
      down("HTTP_STATUS"),
      "https://x.example.com/",
      publicDns([]),
    );
    expect(r.status).toBe("DOWN");
  });
});
