import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { getSetting } from "@/lib/settings";
import { openUploadStream } from "@/lib/storage";
import { db, ready } from "@/lib/db";
import { servingFor } from "@/lib/serveType";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/** The workspace's own mark, for the top of a review page (brief 2.6). */
export const GET = async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const found = await resolveShare(token);
  if (!found) return new Response("Not found", { status: 404 });
  const out = await runInTenant(found.workspace, async () => {
    const uploadId = await getSetting("brandLogoUploadId");
    if (!uploadId) return null;
    await ready();
    const rs = await db().execute({ sql: `SELECT ext, mime FROM uploads WHERE id = ? LIMIT 1`, args: [uploadId] });
    if (!rs.rows.length) return null;
    const row = rs.rows[0] as { ext?: string; mime?: string };
    try { const up = await openUploadStream(uploadId, String(row.ext ?? "png")); return { stream: up.stream, mime: String(row.mime ?? "image/png") }; } catch { return null; }
  });
  if (!out) return new Response("No logo", { status: 404 });
  /* The stored mime decides nothing on its own: this route is
     UNAUTHENTICATED — anybody with a review link reaches it — and it was
     echoing a column back as the content type. A logo is a raster image or
     it is not served as one. `servingFor` is the same allowlist the media
     route uses, which excludes SVG: an SVG is a document that can carry
     script, and this one would run on the app's own origin in front of a
     client who was handed the link. */
  const serve = servingFor(out.mime);
  if (!serve.inline) return new Response("No logo", { status: 404 });
  return new Response(out.stream, {
    headers: {
      "Content-Type": serve.contentType,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
};
