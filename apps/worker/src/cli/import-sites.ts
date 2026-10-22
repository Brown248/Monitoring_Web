/**
 * นำเข้ารายชื่อเว็บไซต์จากไฟล์ที่ส่งออกด้วย export-sites (รันซ้ำได้ — เว็บที่ URL มีอยู่แล้วจะข้าม)
 *   Docker:      docker compose run --rm worker node dist/import-sites.cjs
 *   เครื่อง dev: pnpm sites:import
 * ตัวเลือก: --file <path>  --dry-run (ดูผลโดยไม่บันทึก)  --overwrite-settings (ทับค่าตั้งที่ server บันทึกไว้แล้ว)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@app/db";
import { importSites } from "../sites-transfer";

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "overwrite-settings": { type: "boolean", default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("ไม่พบ DATABASE_URL");
  // Docker: /app/deploy/sites.json · เครื่อง dev (รันจาก apps/worker): deploy/sites.json ที่ root
  const file =
    values.file ??
    [path.resolve("deploy/sites.json"), path.resolve("../../deploy/sites.json")].find((f) => existsSync(f));
  if (!file || !existsSync(file)) throw new Error("ไม่พบไฟล์รายชื่อเว็บ (ระบุด้วย --file <path>)");

  const { db, pool } = createDb(url, { applicationName: "import-sites", max: 1 });
  try {
    const dryRun = values["dry-run"];
    const r = await importSites(db, JSON.parse(readFileSync(file, "utf8")), {
      dryRun,
      overwriteSettings: values["overwrite-settings"],
    });
    console.log(`${dryRun ? "[ทดลอง — ยังไม่บันทึก] " : ""}นำเข้าจาก ${file}`);
    console.log(`  เพิ่มเว็บ ${r.added.length}${r.added.length ? `: ${r.added.join(", ")}` : ""}`);
    for (const s of r.skipped) console.log(`  ข้าม ${s.name} — ${s.reason}`);
    console.log(`  ความเชื่อมโยง ${r.dependencies} · การทดสอบใช้งานจริง ${r.journeys}`);
    if (r.settings.saved.length) console.log(`  ค่าตั้งที่บันทึก: ${r.settings.saved.join(", ")}`);
    if (r.settings.kept.length)
      console.log(
        `  ค่าตั้งที่ server มีอยู่แล้ว (ไม่ทับ — ใช้ --overwrite-settings ถ้าต้องการ): ${r.settings.kept.join(", ")}`,
      );
    for (const s of r.settings.invalid) console.log(`  ค่าตั้ง ${s.key} ไม่ถูกต้อง — ${s.reason}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
