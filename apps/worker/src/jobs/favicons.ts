import { fetchFavicon } from "@app/core/server";
import { getState, setState, sql, websiteIcons } from "@app/db";
import type { WorkerContext } from "../context";

const BATCH = 4;
/** เพิ่มเลขนี้เมื่อเปลี่ยนวิธีหาโลโก้ → ดึงใหม่ทุกเว็บหนึ่งรอบ (ไม่ต้องรอครบ 7 วัน) */
const DISCOVERY_VERSION = 2;

/**
 * ดึง favicon ของเว็บที่ยังไม่มี / เปลี่ยน URL / เก่ากว่า 7 วัน (ล้มเหลวแล้วลองใหม่หลัง 6 ชม. — เว็บที่ล่มอยู่จะได้โลโก้เมื่อกลับมา)
 * ทำทีละไม่กี่เว็บต่อรอบ เพื่อไม่แย่งเน็ตกับการตรวจจริง
 */
export async function refreshFavicons(ctx: WorkerContext): Promise<void> {
  const state = await getState<{ version: number }>(ctx.db, "favicon-discovery");
  if ((state?.version ?? 1) < DISCOVERY_VERSION) {
    await ctx.db.execute(sql`UPDATE website_icons SET fetched_at = '2000-01-01'`);
    await setState(ctx.db, "favicon-discovery", { version: DISCOVERY_VERSION });
  }
  const due = await ctx.db.execute<{ id: number; url: string }>(sql`
    SELECT w.id, w.url
    FROM websites w
    LEFT JOIN website_icons i ON i.website_id = w.id
    WHERE w.archived_at IS NULL
      AND (i.website_id IS NULL
           OR i.site_url <> w.url
           OR (i.ok AND i.fetched_at < now() - interval '7 days')
           OR (NOT i.ok AND i.fetched_at < now() - interval '6 hours'))
    ORDER BY i.fetched_at NULLS FIRST, w.id
    LIMIT ${BATCH}
  `);
  for (const row of due.rows) {
    const id = Number(row.id);
    const icon = await fetchFavicon(row.url).catch(() => null);
    if (!icon) {
      // ดึงไม่ได้ชั่วคราว (เว็บล่ม/ช้า) แต่มีโลโก้ดีของ URL เดิมอยู่แล้ว → เก็บโลโก้เดิมไว้ ลองใหม่ใน 6 ชม.
      // (เดิมเขียนทับเป็นว่าง โลโก้หายจากหน้าเว็บจนกว่าจะดึงสำเร็จอีกครั้ง)
      const kept = await ctx.db.execute(sql`
        UPDATE website_icons SET fetched_at = now() - interval '7 days' + interval '6 hours'
        WHERE website_id = ${id} AND ok AND site_url = ${row.url}
        RETURNING website_id
      `);
      if (kept.rows.length > 0) continue;
    }
    const values = {
      websiteId: id,
      siteUrl: row.url,
      ok: icon !== null,
      content: icon?.body ?? null,
      contentType: icon?.contentType ?? null,
      sourceUrl: icon?.sourceUrl ?? null,
      fetchedAt: new Date(),
    };
    await ctx.db
      .insert(websiteIcons)
      .values(values)
      .onConflictDoUpdate({ target: websiteIcons.websiteId, set: values });
    ctx.log.debug("favicon refreshed", { websiteId: id, ok: values.ok });
  }
}
