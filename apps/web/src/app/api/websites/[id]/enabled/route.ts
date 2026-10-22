import { toggleEnabledSchema } from "@app/core/server";
import { NextResponse } from "next/server";
import { parseId, readJson, requireApi, route } from "@/lib/api";
import { setEnabled } from "@/lib/websites";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const { enabled } = await readJson(req, toggleEnabledSchema);
  await setEnabled(id, enabled, user.username);
  return NextResponse.json({ ok: true, message: enabled ? "เปิดการตรวจแล้ว" : "ปิดการตรวจแล้ว" });
});
