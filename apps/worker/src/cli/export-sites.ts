/**
 * ส่งออกรายชื่อเว็บไซต์ + ความเชื่อมโยง + การทดสอบใช้งานจริง + ค่าตั้งที่ไม่ใช่ความลับ เป็นไฟล์ JSON
 *   เครื่อง dev: pnpm sites:export                       (เขียน deploy/sites.json)
 *   Docker:      docker compose run --rm worker node dist/export-sites.cjs --out - > sites.json
 * ไม่มีรหัสผ่าน/ประวัติการตรวจ/ภาพต้นแบบในไฟล์ — นำไปใช้กับ import-sites บนเครื่องอื่น
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@app/db";
import { exportSites } from "../sites-transfer";

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("ไม่พบ DATABASE_URL");
  const out = values.out ?? path.resolve("../../deploy/sites.json");
  const { db, pool } = createDb(url, { applicationName: "export-sites", max: 1 });
  try {
    const data = await exportSites(db);
    const json = JSON.stringify(data, null, 2) + "\n";
    if (out === "-") process.stdout.write(json);
    else {
      writeFileSync(out, json);
      console.log(
        `ส่งออกแล้ว: ${data.websites.length} เว็บ · ${data.dependencies.length} ความเชื่อมโยง · ` +
          `${data.journeys.length} การทดสอบ · ค่าตั้ง ${Object.keys(data.settings).join(", ") || "-"} → ${out}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
