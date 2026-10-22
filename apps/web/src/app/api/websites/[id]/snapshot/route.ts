import { and, eq, visualSnapshots } from "@app/db";
import { HttpError, parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };
const KINDS = ["baseline", "latest", "diff"] as const;

/** ภาพหน้าเว็บที่ worker ถ่ายไว้ (PNG ที่ระบบสร้างเอง) */
export const GET = route<Ctx>(async (req, ctx) => {
  await requireApi(req);
  const id = parseId((await ctx.params).id);
  const kind = new URL(req.url).searchParams.get("kind") ?? "latest";
  if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new HttpError(400, "kind ไม่ถูกต้อง");
  const [snap] = await getDb()
    .select({ image: visualSnapshots.image, capturedAt: visualSnapshots.capturedAt })
    .from(visualSnapshots)
    .where(and(eq(visualSnapshots.websiteId, id), eq(visualSnapshots.kind, kind)))
    .limit(1);
  if (!snap?.image) return new Response(null, { status: 404 });
  const etag = `"${kind}-${snap.capturedAt.getTime().toString(36)}"`;
  const headers = {
    "content-type": "image/png",
    "cache-control": "private, no-cache",
    etag,
    "x-content-type-options": "nosniff",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(snap.image), { headers });
});
