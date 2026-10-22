import { eq, jobRequests } from "@app/db";
import { NextResponse } from "next/server";
import { HttpError, parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  await requireApi(req);
  const id = parseId((await ctx.params).id);
  const [job] = await getDb()
    .select({
      id: jobRequests.id,
      type: jobRequests.type,
      status: jobRequests.status,
      result: jobRequests.result,
    })
    .from(jobRequests)
    .where(eq(jobRequests.id, id));
  if (!job) throw new HttpError(404, "ไม่พบงาน");
  return NextResponse.json(job);
});
