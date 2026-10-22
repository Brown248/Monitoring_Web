import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// dev / build บนเครื่อง: ใช้ .env ที่ root ของ monorepo (ใน Docker ไม่มีไฟล์นี้ — ค่ามาจาก compose)
const rootEnv = path.join(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  output: "standalone",
  // next build รันจาก apps/web เสมอ → root ของ monorepo อยู่ขึ้นไปสองระดับ
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@app/core", "@app/db"],
  poweredByHeader: false,
  experimental: {
    // next dev เขียนไฟล์ลง apps/web/.next/dev ทุกครั้งที่ compile/เปิดหน้า (cache ของ Turbopack, log สำหรับ MCP)
    // root ของ Turbopack เป็นทั้ง monorepo → เห็นไฟล์พวกนี้เปลี่ยนแล้วรีโหลดหน้าวนไม่หยุด (ทุก ~0.2 วินาที)
    // ปิดทั้งสอง — มีผลเฉพาะ next dev (build/production ไม่เกี่ยว) แลกกับเริ่ม dev ช้าลงเล็กน้อย
    mcpServer: false,
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
