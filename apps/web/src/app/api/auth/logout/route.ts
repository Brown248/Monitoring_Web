import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { logout } from "@/lib/auth";

export const POST = route(async () => {
  await logout();
  return NextResponse.json({ ok: true });
});
