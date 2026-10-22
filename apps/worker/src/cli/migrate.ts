/**
 * ปรับโครงสร้างฐานข้อมูลให้เป็นรุ่นล่าสุด (migration) — รันก่อนเว็บ/Worker ทุกครั้งที่ start (service "migrate" ใน compose)
 * รันซ้ำได้ปลอดภัย: ทำเฉพาะ migration ที่ยังไม่เคยทำ · ล็อกด้วย advisory lock กันรันพร้อมกันหลายตัว
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createDb, sql } from "@app/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("ไม่พบ DATABASE_URL");
  // Docker: /app/migrations · เครื่อง dev (รันจาก apps/worker): packages/db/migrations
  const folder =
    process.env.MIGRATIONS_DIR ??
    [path.resolve("migrations"), path.resolve("../../packages/db/migrations")].find((d) =>
      existsSync(path.join(d, "meta", "_journal.json")),
    );
  if (!folder) throw new Error("ไม่พบโฟลเดอร์ migrations (ตั้ง MIGRATIONS_DIR)");
  const { db, pool } = createDb(url, { applicationName: "migrate", max: 1, statementTimeoutMs: 600_000 });
  try {
    await db.execute(sql`SELECT pg_advisory_lock(hashtext('monitor:migrate'))`);
    await migrate(db, { migrationsFolder: folder });
    const r = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
    );
    console.log(`migration เรียบร้อย · ทำแล้วทั้งหมด ${r.rows[0]?.n ?? "?"} รายการ`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const cause = err instanceof Error && err.cause instanceof Error ? ` — สาเหตุ: ${err.cause.message}` : "";
  console.error(
    `migration ล้มเหลว: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}${cause}`,
  );
  process.exit(1);
});
