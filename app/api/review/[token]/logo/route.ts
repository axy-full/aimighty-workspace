import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { getSetting } from "@/lib/settings";
import { openUploadStream } from "@/lib/storage";
import { db, ready } from "@/lib/db";

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
  return new Response(out.stream, { headers: { "Content-Type": out.mime, "Cache-Control": "public, max-age=3600" } });
};
