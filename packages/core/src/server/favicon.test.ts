import { describe, expect, it } from "vitest";
import { fetchFavicon, parseIconLinks, parseLogoImages, sniffImageType, tinyImage } from "./favicon";

describe("sniffImageType", () => {
  it("detects by magic bytes, not by extension", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(sniffImageType(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]))).toBe("image/x-icon");
    expect(sniffImageType(Buffer.from("GIF89a...."))).toBe("image/gif");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      "image/svg+xml",
    );
  });

  it("rejects html and svg with script", () => {
    expect(sniffImageType(Buffer.from("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg><script>alert(1)</script></svg>"))).toBeNull();
  });
});

describe("parseIconLinks", () => {
  it("resolves relative hrefs and prefers the sharper apple-touch-icon over rel=icon", () => {
    const html = `
      <link rel="apple-touch-icon" href="/apple.png">
      <link href='static/fav.png?v=1&amp;x=2' rel="shortcut icon">
      <link rel=stylesheet href="/a.css">
      <link rel="icon" href="javascript:alert(1)">`;
    expect(parseIconLinks(html, "https://example.com/app/")).toEqual([
      "https://example.com/apple.png",
      "https://example.com/app/static/fav.png?v=1&x=2",
    ]);
  });
});

describe("parseLogoImages", () => {
  it("finds the page's logo image when the site has no favicon", () => {
    const html = `
      <img src="/hero.jpg" alt="banner">
      <img class="brand-logo" src="/pic/SYNGROUP-Slide.png" alt="SYNGROUP">
      <img src="data:image/png;base64,AAA" class="logo">
      <img src='/static/company_logo.svg'>`;
    expect(parseLogoImages(html, "https://jig.example.com/a/")).toEqual([
      "https://jig.example.com/pic/SYNGROUP-Slide.png",
      "https://jig.example.com/static/company_logo.svg",
    ]);
  });
});

describe("favicon edge cases", () => {
  it("accepts the legacy apple-touch-icon-precomposed rel", () => {
    const html = `<link rel="apple-touch-icon-precomposed" href="/old.png"><link rel="icon" href="/f.ico">`;
    expect(parseIconLinks(html, "https://example.com/")).toEqual([
      "https://example.com/old.png",
      "https://example.com/f.ico",
    ]);
  });

  it("prefers lazy-load data-src / srcset over a placeholder src", () => {
    const html = `
      <img class="logo lazy" src="/blank.gif" data-src="/real-logo.png">
      <img class="site-logo" src="data:image/gif;base64,R0lG" srcset="/logo@1x.png 1x, /logo@2x.png 2x">`;
    expect(parseLogoImages(html, "https://example.com/")).toEqual([
      "https://example.com/real-logo.png",
      "https://example.com/logo@1x.png",
    ]);
  });

  it("treats 1x1 tracking pixels as unusable", () => {
    const png1 = Buffer.alloc(24);
    png1.write("\x89PNG", 0, "latin1");
    png1.writeUInt32BE(1, 16);
    png1.writeUInt32BE(1, 20);
    expect(tinyImage(png1, "image/png")).toBe(true);
    const png180 = Buffer.from(png1);
    png180.writeUInt32BE(180, 16);
    png180.writeUInt32BE(180, 20);
    expect(tinyImage(png180, "image/png")).toBe(false);
    const gif1 = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
    expect(tinyImage(gif1, "image/gif")).toBe(true);
    expect(tinyImage(Buffer.from("<svg/>"), "image/svg+xml")).toBe(false);
  });
});

describe("fetchFavicon", () => {
  it("refuses private targets (SSRF guard)", async () => {
    expect(await fetchFavicon("http://127.0.0.1:9/")).toBeNull();
  });
});
