import { rootCauseFor, type Edge } from "@app/core";
import { sql } from "drizzle-orm";
import { mergeRecipients } from "@app/core";
import { getSettings, logEvent, type DbOrTx } from "./helpers";

// การจัดการ Incident ที่ทั้งหน้าเว็บและ Worker ใช้ร่วมกัน (ต้องเรียกภายในทรานแซกชัน)

/**
 * ระบบที่เว็บนี้พึ่งพา (ทางอ้อมด้วย) ที่ล่มอยู่ → {id, name} ของต้นเหตุ
 * นับเฉพาะเว็บที่ยังเปิดตรวจและไม่ได้ archive — เว็บที่หยุดตรวจแล้วจะไม่ทำให้อีเมลของเว็บอื่นถูกปิดไปด้วย
 */
export async function openRootCause(
  tx: DbOrTx,
  websiteId: number,
): Promise<{ id: number; name: string } | null> {
  const edges = await tx.execute<{ website_id: number; depends_on_id: number }>(sql`
    SELECT d.website_id, d.depends_on_id FROM website_dependencies d
    JOIN websites a ON a.id = d.website_id AND a.archived_at IS NULL
    JOIN websites b ON b.id = d.depends_on_id AND b.archived_at IS NULL AND b.enabled
  `);
  if (edges.rows.length === 0) return null;
  const graph: Edge[] = edges.rows.map((r) => [Number(r.website_id), Number(r.depends_on_id)] as const);
  if (!graph.some(([a]) => a === websiteId)) return null;
  // FOR SHARE: ถ้าต้นเหตุกำลังถูกปิด (กลับมา UP) ในทรานแซกชันอื่นพร้อมกัน จะรอให้จบก่อนแล้วเห็นว่าปิดแล้ว
  // — ไม่งั้นเว็บนี้บันทึกว่า "ล่มตาม" ต้นเหตุที่เพิ่งกลับมา โดยที่ฝั่งนั้นปล่อยเว็บที่ล่มตามไปแล้ว (มองไม่เห็นแถวนี้)
  // ผลคือไม่มีใครได้รับแจ้งเลย · กลับกัน: ฝั่งที่จะปิดต้องรอทรานแซกชันนี้ commit แล้วจึงเห็นแถวนี้ตอนปล่อย
  const down = await tx.execute<{ website_id: number }>(sql`
    SELECT i.website_id FROM incidents i
    JOIN websites w ON w.id = i.website_id AND w.enabled AND w.archived_at IS NULL
    WHERE i.recovered_at IS NULL AND i.website_id <> ${websiteId}
    ORDER BY i.id -- ล็อกตามลำดับเดียวกันทุกครั้ง ลดโอกาส deadlock เมื่อหลายเว็บเปลี่ยนสถานะพร้อมกัน
    FOR SHARE OF i
  `);
  const rootId = rootCauseFor(graph, websiteId, new Set(down.rows.map((r) => Number(r.website_id))));
  if (rootId === null) return null;
  const [row] = (await tx.execute<{ name: string }>(sql`SELECT name FROM websites WHERE id = ${rootId}`))
    .rows;
  return { id: rootId, name: row?.name ?? `#${rootId}` };
}

type DependentRow = {
  id: number;
  website_id: number;
  name: string;
  alert_emails: string[];
  root_id: number;
  root_name: string;
};

/**
 * คิดต้นเหตุของ Incident ที่ "ล่มตามกัน" ใหม่ — ยังมีระบบที่พึ่งพาล่มอยู่ → ชี้ไปที่ต้นเหตุนั้น
 * ไม่มีแล้ว = ล่มด้วยตัวเอง → ส่งอีเมล DOWN ตามปกติ (ไม่งั้นเว็บที่ยังล่มอยู่จะไม่มีใครได้รับแจ้งเลย)
 */
async function reevaluate(
  tx: DbOrTx,
  rows: DependentRow[],
  why: (d: DependentRow) => string,
): Promise<Array<{ incidentId: number; websiteId: number }>> {
  const released: Array<{ incidentId: number; websiteId: number }> = [];
  if (rows.length === 0) return released;
  const smtp = await getSettings(tx, "smtp");
  for (const d of rows) {
    const incidentId = Number(d.id);
    const websiteId = Number(d.website_id);
    const next = await openRootCause(tx, websiteId);
    if (next) {
      if (next.id !== Number(d.root_id))
        await tx.execute(
          sql`UPDATE incidents SET root_cause_website_id = ${next.id} WHERE id = ${incidentId}`,
        );
      continue;
    }
    await tx.execute(sql`UPDATE incidents SET root_cause_website_id = NULL WHERE id = ${incidentId}`);
    released.push({ incidentId, websiteId });
    const recipients = mergeRecipients(d.alert_emails, smtp.alertEmails);
    if (recipients.length > 0)
      await tx.execute(sql`
        INSERT INTO notification_events (incident_id, event_type, recipient)
        VALUES ${sql.join(
          recipients.map((r) => sql`(${incidentId}, 'DOWN', ${r})`),
          sql`, `,
        )}
        ON CONFLICT DO NOTHING
      `);
    await logEvent(tx, {
      type: "ROOT_CAUSE_CLEARED",
      level: "ERROR",
      websiteId,
      incidentId,
      message: `${why(d)} แต่ ${d.name} ยังล่มอยู่ — ${recipients.length ? "ส่งแจ้งเตือนตามปกติ" : "ไม่มีผู้รับอีเมล"}`,
      detail: `เดิมบันทึกว่า ${d.name} ล่มตาม ${d.root_name} จึงยังไม่ได้แจ้ง · ตอนนี้ถือว่าล่มด้วยสาเหตุของตัวเอง`,
    });
  }
  return released;
}

const dependentRows = (tx: DbOrTx, filter: ReturnType<typeof sql>) =>
  tx
    .execute<DependentRow>(
      sql`
      SELECT i.id, i.website_id, w.name, w.alert_emails, i.root_cause_website_id AS root_id,
             coalesce(r.name, '#' || i.root_cause_website_id) AS root_name
      FROM incidents i JOIN websites w ON w.id = i.website_id
      LEFT JOIN websites r ON r.id = i.root_cause_website_id
      WHERE i.recovered_at IS NULL AND i.root_cause_website_id IS NOT NULL AND ${filter}
      ORDER BY i.id
      FOR UPDATE OF i
    `,
    )
    .then((r) => r.rows);

/** ต้นเหตุ (siteId) กลับมาแล้ว/หยุดตรวจแล้ว → คิดต้นเหตุของเว็บที่ "ล่มตามกัน" ใหม่ */
export async function releaseDependentIncidents(
  tx: DbOrTx,
  siteId: number,
): Promise<Array<{ incidentId: number; websiteId: number }>> {
  const rows = await dependentRows(tx, sql`i.root_cause_website_id = ${siteId}`);
  return reevaluate(tx, rows, (d) => `${d.root_name} ไม่ได้ล่มแล้ว`);
}

/**
 * คิดต้นเหตุใหม่ทุก Incident ที่ "ล่มตามกัน" (หรือเฉพาะเว็บที่ระบุ) — ใช้เมื่อแผนผังการพึ่งพาเปลี่ยน
 * (เช่น เอาการพึ่งพาออกขณะต้นเหตุยังล่ม → เว็บนั้นต้องได้แจ้งเตือนเอง ไม่ใช่เงียบไปจนต้นเหตุกลับมา)
 * และกันไว้อีกชั้นในงาน maintenance (กรณีที่หลุดจากการปล่อยตอนต้นเหตุกลับมา)
 */
export async function recheckRootCauses(
  tx: DbOrTx,
  websiteIds?: number[],
): Promise<Array<{ incidentId: number; websiteId: number }>> {
  if (websiteIds && websiteIds.length === 0) return [];
  const rows = await dependentRows(
    tx,
    websiteIds
      ? sql`i.website_id IN (${sql.join(
          websiteIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql`true`,
  );
  return reevaluate(tx, rows, (d) => `ไม่ได้ล่มตาม ${d.root_name} แล้ว (ต้นเหตุกลับมา/เลิกพึ่งพา)`);
}

/**
 * ปิด Incident ที่เปิดค้างของเว็บที่หยุดตรวจ/archive — Worker จะไม่ตรวจเว็บนี้แล้ว จึงไม่มีอะไรมาปิดให้
 * ไม่ส่งอีเมล RECOVERY (ไม่รู้ว่าเว็บกลับมาจริงหรือไม่) · recovery_check_id = NULL บอกว่าปิดเพราะหยุดตรวจ
 */
export async function closeIncidentsOfInactiveSite(
  tx: DbOrTx,
  websiteId: number,
  reason: string,
): Promise<number> {
  const closed = await tx.execute<{ id: number }>(sql`
    -- ตัดเหลือมิลลิวินาทีเหมือนเวลาปิดปกติ (Date ของ JS) — ระบบอื่นที่อ้างเวลานี้ (เช่น cursor ของ Sheets) ไม่สับสน
    UPDATE incidents SET recovered_at = date_trunc('milliseconds', now())
    WHERE website_id = ${websiteId} AND recovered_at IS NULL
    RETURNING id
  `);
  for (const row of closed.rows) {
    const incidentId = Number(row.id);
    await tx.execute(sql`
      UPDATE ai_analyses SET status = 'SKIPPED', error = 'Incident ปิดเพราะหยุดตรวจเว็บ', completed_at = now()
      WHERE incident_id = ${incidentId} AND status = 'PENDING'
    `);
    await logEvent(tx, {
      type: "INCIDENT_CLOSED",
      level: "INFO",
      websiteId,
      incidentId,
      message: `ปิด Incident #${incidentId} เพราะ${reason}`,
      detail: "ไม่ได้ยืนยันว่าเว็บกลับมาใช้งานได้ · ไม่ส่งอีเมลแจ้งกลับมาใช้งาน",
    });
  }
  // เริ่มนับใหม่เมื่อเปิดตรวจอีกครั้ง — ไม่อ้างถึงผลตรวจเก่าที่อาจถูกลบไปแล้ว
  await tx.execute(sql`
    UPDATE website_state
    SET consecutive_failures = 0, consecutive_successes = 0, failure_streak_started_at = NULL,
        failure_streak_first_check_id = NULL, status = 'UNKNOWN', updated_at = now()
    WHERE website_id = ${websiteId}
  `);
  // แจ้งเตือนเชิงการทำงานของเว็บนี้ไม่มีอะไรมาปิดให้อัตโนมัติแล้ว
  await tx.execute(sql`
    UPDATE security_alerts SET acknowledged_at = now(), detail = coalesce(detail, '{}'::jsonb) || '{"autoResolved": true}'::jsonb
    WHERE website_id = ${websiteId} AND acknowledged_at IS NULL
      AND type IN ('ANOMALY_SLOW', 'ANOMALY_UNSTABLE', 'JOURNEY_FAILED')
  `);
  if (closed.rows.length) await releaseDependentIncidents(tx, websiteId);
  return closed.rows.length;
}
