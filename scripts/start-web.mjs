// รันหน้าเว็บแบบ production บนเครื่อง (เร็วกว่า pnpm dev:web มาก) — ต้อง build ก่อน: pnpm build:web
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const web = path.join(root, "apps/web");
const standalone = path.join(web, ".next/standalone/apps/web");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("ยังไม่ได้ build — รัน pnpm build:web ก่อน");
  process.exit(1);
}
// standalone ไม่รวมไฟล์ static/public มาให้ — copy ทุกครั้งเพื่อให้ตรงกับ build ล่าสุด
cpSync(path.join(web, ".next/static"), path.join(standalone, ".next/static"), { recursive: true });
if (existsSync(path.join(web, "public")))
  cpSync(path.join(web, "public"), path.join(standalone, "public"), { recursive: true });

process.loadEnvFile(path.join(root, ".env"));
const port = process.env.WEB_PORT || "3000";
console.log(`WebMonitor (production) → http://localhost:${port}`);
// peer-ip.mjs: ต่อ IP จริงท้าย X-Forwarded-For (เหมือนใน Docker)
const preload = pathToFileURL(path.join(web, "peer-ip.mjs")).href;
const child = spawn(process.execPath, ["--import", preload, path.join(standalone, "server.js")], {
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0", NODE_ENV: "production" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
