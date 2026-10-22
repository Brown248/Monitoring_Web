import "server-only";
import { normalizeUrl, websiteFormSchema, websiteFormToRow } from "@app/core/server";
import {
  and,
  closeIncidentsOfInactiveSite,
  eq,
  isNull,
  logEvent,
  ne,
  sql,
  websites,
  websiteState,
} from "@app/db";
import { HttpError, isUniqueViolation, zodFields } from "./api";
import { getDb } from "./db";

export function parseWebsiteForm(body: unknown) {
  const parsed = websiteFormSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "ข้อมูลไม่ถูกต้อง", zodFields(parsed.error));
  return parsed.data;
}

const DUP_URL = () => new HttpError(409, "มีเว็บไซต์ที่ใช้ URL นี้อยู่แล้ว", { url: "URL นี้ถูกใช้แล้ว" });

/** เทียบแบบรูปแบบมาตรฐานทั้งสองฝั่ง — เว็บเก่าที่บันทึกก่อนมีการ normalize ก็จับได้ */
async function assertUrlUnique(url: string, exceptId?: number) {
  const where = exceptId
    ? and(isNull(websites.archivedAt), ne(websites.id, exceptId))
    : isNull(websites.archivedAt);
  const rows = await getDb().select({ url: websites.url }).from(websites).where(where);
  const wanted = normalizeUrl(url);
  if (rows.some((r) => normalizeUrl(r.url) === wanted)) throw DUP_URL();
}

export async function createWebsite(body: unknown, actor: string): Promise<number> {
  const form = parseWebsiteForm(body);
  await assertUrlUnique(form.url);
  return createRow(form, actor).catch((err: unknown) => {
    throw isUniqueViolation(err) ? DUP_URL() : err;
  });
}

async function createRow(form: ReturnType<typeof parseWebsiteForm>, actor: string): Promise<number> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.insert(websites).values(websiteFormToRow(form)).returning({ id: websites.id });
    const id = row!.id;
    // ตรวจครั้งแรกทันที
    await tx.insert(websiteState).values({ websiteId: id, nextCheckAt: new Date() });
    await logEvent(tx, {
      type: "WEBSITE_CREATED",
      websiteId: id,
      message: `เพิ่มเว็บไซต์ ${form.name} (โดย ${actor})`,
    });
    return id;
  });
}

export async function updateWebsite(
  id: number,
  body: unknown,
  actor: string,
  checkVersion: (current: Date) => void = () => undefined,
): Promise<string> {
  const form = parseWebsiteForm(body);
  await assertUrlUnique(form.url, id);
  const db = getDb();
  const [current] = await db.select().from(websites).where(eq(websites.id, id));
  if (!current || current.archivedAt) throw new HttpError(404, "ไม่พบเว็บไซต์");
  return db
    .transaction(async (tx) => {
      // ล็อกแถว + เทียบ version (กันผู้ดูแล 2 คนแก้ฟอร์มเดียวกันแล้วค่าของคนแรกหายเงียบ)
      // archived_at IS NULL: ถูก archive ระหว่างเปิดฟอร์ม → ไม่แก้ (กลับมาแสดงในรายการโดยไม่ตั้งใจ)
      const [locked] = await tx
        .select({ updatedAt: websites.updatedAt })
        .from(websites)
        .where(and(eq(websites.id, id), isNull(websites.archivedAt)))
        .for("update");
      if (!locked) throw new HttpError(404, "ไม่พบเว็บไซต์");
      checkVersion(locked.updatedAt);
      const [saved] = await tx
        .update(websites)
        .set(websiteFormToRow(form))
        .where(eq(websites.id, id))
        .returning({ updatedAt: websites.updatedAt });
      // ปิดการตรวจจากฟอร์มแก้ไข → ปิด Incident ค้างเหมือนกดปุ่ม "ปิดการตรวจ"
      if (current.enabled && !form.enabled)
        await closeIncidentsOfInactiveSite(tx, id, `ปิดการตรวจ ${form.name}`);
      // URL เปลี่ยน = คนละเว็บ → เริ่มเก็บลายนิ้วมือใหม่ ไม่เทียบกับของเว็บเดิม (กันแจ้งเตือน "Nameserver เปลี่ยน" หลอก)
      if (normalizeUrl(current.url) !== normalizeUrl(form.url))
        await tx.execute(sql`DELETE FROM site_fingerprints WHERE website_id = ${id}`);
      // URL เปลี่ยน = คนละเว็บ → นับผลตรวจล้มเหลว/สำเร็จติดกันใหม่ (streak ของ URL เดิมไม่ควรเปิด Incident ให้ URL ใหม่)
      if (normalizeUrl(current.url) !== normalizeUrl(form.url))
        await tx.execute(sql`
          UPDATE website_state SET consecutive_failures = 0, consecutive_successes = 0,
            failure_streak_started_at = NULL, failure_streak_first_check_id = NULL, updated_at = now()
          WHERE website_id = ${id}
        `);
      // เปลี่ยน URL/รอบตรวจ → ตรวจรอบใหม่เร็ว ๆ
      if (
        current.url !== form.url ||
        current.checkIntervalSeconds !== form.checkIntervalSeconds ||
        (!current.enabled && form.enabled)
      ) {
        await tx.update(websiteState).set({ nextCheckAt: new Date() }).where(eq(websiteState.websiteId, id));
      }
      await logEvent(tx, {
        type: "WEBSITE_UPDATED",
        websiteId: id,
        message: `แก้ไขการตั้งค่า ${form.name} (โดย ${actor})`,
      });
      return saved!.updatedAt.toISOString();
    })
    .catch((err: unknown) => {
      throw isUniqueViolation(err) ? DUP_URL() : err;
    });
}

export async function setEnabled(id: number, enabled: boolean, actor: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [w] = await tx
      .update(websites)
      .set({ enabled })
      .where(and(eq(websites.id, id), isNull(websites.archivedAt)))
      .returning({ name: websites.name });
    if (!w) throw new HttpError(404, "ไม่พบเว็บไซต์");
    if (enabled)
      await tx.update(websiteState).set({ nextCheckAt: new Date() }).where(eq(websiteState.websiteId, id));
    // หยุดตรวจ → Worker จะไม่ปิด Incident ที่ค้างให้แล้ว (และ Incident ค้างจะทำให้เว็บที่พึ่งพาเงียบตลอด)
    else await closeIncidentsOfInactiveSite(tx, id, `ปิดการตรวจ ${w.name}`);
    await logEvent(tx, {
      type: enabled ? "WEBSITE_ENABLED" : "WEBSITE_DISABLED",
      websiteId: id,
      message: `${enabled ? "เปิด" : "ปิด"}การตรวจ ${w.name} (โดย ${actor})`,
    });
  });
}

export async function archiveWebsite(id: number, actor: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [w] = await tx
      .update(websites)
      .set({ archivedAt: new Date(), enabled: false })
      .where(and(eq(websites.id, id), isNull(websites.archivedAt)))
      .returning({ name: websites.name });
    if (!w) throw new HttpError(404, "ไม่พบเว็บไซต์");
    await closeIncidentsOfInactiveSite(tx, id, `archive ${w.name}`);
    await logEvent(tx, {
      type: "WEBSITE_ARCHIVED",
      websiteId: id,
      message: `Archive เว็บไซต์ ${w.name} (โดย ${actor})`,
    });
  });
}

export async function checkNow(id: number): Promise<void> {
  const res = await getDb().execute(sql`
    UPDATE website_state s SET next_check_at = now()
    FROM websites w WHERE w.id = s.website_id AND s.website_id = ${id} AND w.enabled AND w.archived_at IS NULL
  `);
  if ((res.rowCount ?? 0) === 0) throw new HttpError(409, "เว็บไซต์นี้ปิดการตรวจอยู่หรือไม่พบ");
}
