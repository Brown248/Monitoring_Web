import { NextResponse } from "next/server";
import { readJsonBody, requireApi, route } from "@/lib/api";
import { createWebsite } from "@/lib/websites";

export const POST = route(async (req) => {
  const user = await requireApi(req, "ADMIN");
  const body = await readJsonBody(req);
  const id = await createWebsite(body, user.username);
  return NextResponse.json({ id }, { status: 201 });
});
