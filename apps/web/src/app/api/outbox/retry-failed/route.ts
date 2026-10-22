import { inArray, logEvent, notificationEvents } from "@app/db";
import { NextResponse } from "next/server";
import { requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

export const POST = route(async (req) => {
  const user = await requireApi(req, "ADMIN");
  const db = getDb();
  const rows = await db
    .update(notificationEvents)
    // createdAt = ตอนนี้: ผู้ดูแลสั่งส่งเอง ไม่ให้ถูกยกเลิกว่า "ค้างนานเกิน" (expireStaleEmails ใน worker)
    .set({ status: "PENDING", nextAttemptAt: new Date(), attempts: 0, createdAt: new Date() })
    .where(inArray(notificationEvents.status, ["FAILED", "DEAD"]))
    .returning({ id: notificationEvents.id });
  if (rows.length > 0) {
    await logEvent(db, {
      type: "EMAIL_RETRY",
      message: `สั่งส่งอีเมลที่ล้มเหลวใหม่ ${rows.length} รายการ (โดย ${user.username})`,
    });
  }
  return NextResponse.json({ ok: true, message: `เข้าคิวส่งใหม่ ${rows.length} รายการ` });
});
