import { NextResponse } from "next/server";
import { assertVersion, parseId, readJsonBody, requireApi, route } from "@/lib/api";
import { updateWebsite } from "@/lib/websites";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireApi(req, "ADMIN");
  const id = parseId((await ctx.params).id);
  const body = await readJsonBody(req);
  const version = await updateWebsite(id, body, user.username, (current) => assertVersion(req, current));
  return NextResponse.json({ ok: true, version });
});
