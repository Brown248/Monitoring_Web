import { NextResponse } from "next/server";
import { parseId, requireApi, route } from "@/lib/api";
import { checkNow } from "@/lib/websites";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  await requireApi(req, "ADMIN");
  await checkNow(parseId((await ctx.params).id));
  return NextResponse.json({ ok: true, message: "สั่งตรวจแล้ว — ผลจะขึ้นภายในไม่กี่วินาที" });
});
