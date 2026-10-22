import { NextResponse } from "next/server";
import { requireApi, route } from "@/lib/api";
import { siteStatusList } from "@/lib/data/websites";

/** รายชื่อเว็บแบบเบาสำหรับค้นหาด่วน (Ctrl+K) */
export const GET = route(async (req) => {
  await requireApi(req);
  const sites = await siteStatusList();
  return NextResponse.json(
    { sites: sites.map(({ id, name, url, enabled, status }) => ({ id, name, url, enabled, status })) },
    { headers: { "cache-control": "private, no-store" } },
  );
});
