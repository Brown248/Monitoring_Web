import { eq, websiteIcons } from "@app/db";
import { parseId, requireApi, route } from "@/lib/api";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  await requireApi(req);
  const id = parseId((await ctx.params).id);
  const [icon] = await getDb()
    .select({
      content: websiteIcons.content,
      contentType: websiteIcons.contentType,
      fetchedAt: websiteIcons.fetchedAt,
    })
    .from(websiteIcons)
    .where(eq(websiteIcons.websiteId, id))
    .limit(1);
  if (!icon?.content || !icon.contentType) {
    return new Response(null, { status: 404, headers: { "cache-control": "private, max-age=600" } });
  }
  const etag = `"${icon.fetchedAt.getTime().toString(36)}"`;
  const headers = {
    "content-type": icon.contentType,
    "cache-control": "private, max-age=86400",
    etag,
    "x-content-type-options": "nosniff",
    // รูปมาจากเว็บภายนอก — SVG ห้ามรันสคริปต์/โหลดอะไรต่อ
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(icon.content), { headers });
});
