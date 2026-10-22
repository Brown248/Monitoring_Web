import { and, eq, lookalikeDomains, securityAlerts, sql } from "@app/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

const schema = z.object({
  domain: z.string().trim().toLowerCase().max(253),
  status: z.enum(["NEW", "IGNORED", "REPORTED"]),
});

/** เปลี่ยนสถานะโดเมนเลียนแบบ (ไม่เกี่ยวข้อง / แจ้งรายงานแล้ว) */
export const POST = route(async (req) => {
  const user = await requireApi(req, "ADMIN");
  const { domain, status } = await readJson(req, schema);
  const db = getDb();
  const updated = await db
    .update(lookalikeDomains)
    .set({ status })
    .where(eq(lookalikeDomains.domain, domain))
    .returning({ domain: lookalikeDomains.domain });
  if (updated.length === 0) throw new HttpError(404, "ไม่พบโดเมนนี้");
  if (status !== "NEW") {
    await db
      .update(securityAlerts)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: user.id })
      .where(
        and(
          eq(securityAlerts.type, "LOOKALIKE_DOMAIN"),
          sql`${securityAlerts.detail}->>'domain' = ${domain}`,
          sql`${securityAlerts.acknowledgedAt} IS NULL`,
        ),
      );
  }
  return NextResponse.json({
    ok: true,
    message:
      status === "IGNORED"
        ? "ทำเครื่องหมายว่าไม่เกี่ยวข้องแล้ว"
        : status === "REPORTED"
          ? "บันทึกว่ารายงานแล้ว"
          : "ตั้งกลับเป็นใหม่แล้ว",
  });
});
