import { and, eq, logEvent, ne, notificationEvents } from "@app/db";
import { NextResponse } from "next/server";
import { HttpError, parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** ส่งใหม่ทันที (นับครั้งต่อจากเดิม; ถ้าเป็น DEAD จะได้โอกาสอีกรอบ) */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const db = getDb();
  const [row] = await db
    .update(notificationEvents)
    // createdAt = ตอนนี้: ผู้ดูแลสั่งส่งเอง ไม่ให้ถูกยกเลิกว่า "ค้างนานเกิน" (expireStaleEmails ใน worker)
    .set({ status: "PENDING", nextAttemptAt: new Date(), attempts: 0, createdAt: new Date() })
    .where(and(eq(notificationEvents.id, id), ne(notificationEvents.status, "SENT")))
    .returning({
      incidentId: notificationEvents.incidentId,
      recipient: notificationEvents.recipient,
      type: notificationEvents.eventType,
    });
  if (!row) throw new HttpError(409, "รายการนี้ส่งสำเร็จแล้วหรือไม่พบ");
  await logEvent(db, {
    type: "EMAIL_RETRY",
    incidentId: row.incidentId,
    message: `สั่งส่งอีเมล ${row.type} ถึง ${row.recipient} ใหม่ (โดย ${user.username})`,
  });
  return NextResponse.json({ ok: true, message: "เข้าคิวส่งใหม่แล้ว" });
});
