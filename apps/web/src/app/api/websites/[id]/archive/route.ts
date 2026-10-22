import { NextResponse } from "next/server";
import { parseId, requireApi, route } from "@/lib/api";
import { archiveWebsite } from "@/lib/websites";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  await archiveWebsite(parseId((await ctx.params).id), user.username);
  return NextResponse.json({ ok: true, message: "Archive แล้ว" });
});
