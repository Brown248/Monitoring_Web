import { describe, expect, it } from "vitest";
import { isChallengeContent, isChallengeTitle } from "./visual";

describe("bot-challenge detection", () => {
  it("recognises the interstitial pages of common bot protection", () => {
    for (const t of ["Just a moment...", "Attention Required! | Cloudflare", "DDoS-Guard", "Security Check"])
      expect(isChallengeTitle(t)).toBe(true);
    expect(isChallengeContent("", "Checking your browser before accessing example.com")).toBe(true);
  });

  it("does not mistake normal pages that merely mention captcha / security check", () => {
    for (const t of [
      "Website Security Check Tool — SYNTECH",
      "บริการติดตั้ง reCAPTCHA สำหรับเว็บไซต์",
      "ร้านค้าออนไลน์ | captcha ป้องกันสแปม",
    ])
      expect(isChallengeTitle(t)).toBe(false);
    // หน้ายาวปกติที่มีฟอร์ม captcha ไม่ใช่หน้าคั่น
    expect(isChallengeContent("สมัครสมาชิก", `${"เนื้อหา ".repeat(200)} please complete the captcha`)).toBe(
      false,
    );
  });
});
