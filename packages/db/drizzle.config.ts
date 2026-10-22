import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// รันผ่าน `pnpm db:*` → cwd = packages/db; โหลด .env ของ root โดยไม่ต้องใช้ dotenv
const rootEnv = "../../.env";
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  // generate ไม่ต้องเชื่อมต่อ DB; migrate/studio ต้องมี DATABASE_URL
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
