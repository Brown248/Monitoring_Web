import { and, eq, securityAlerts, sql } from "@app/db";
import { NextResponse } from "next/server";
import { parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** รับทราบ alert ด้านความปลอดภัย */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  await getDb()
    .update(securityAlerts)
    .set({ acknowledgedAt: new Date(), acknowledgedBy: user.id })
    .where(and(eq(securityAlerts.id, id), sql`${securityAlerts.acknowledgedAt} IS NULL`));
  return NextResponse.json({ ok: true, message: "รับทราบแล้ว" });
});
