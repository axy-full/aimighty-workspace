import { NextResponse } from "next/server";
import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { db, ready } from "@/lib/db";
import { openOriginalStream, originalSize } from "@/lib/storage";
import { originalMediaOf, type OriginalMedia } from "@/lib/originalMedia";
import { byteRange } from "@/lib/mediaRange";
import { attachmentDisposition } from "@/lib/contentDisposition";

export const dynamic = "force-dynamic";
export const maxDuration = 800;
type Ctx = { params: Promise<{ token: string; genId: string }> };

/**
 * One Approved take's bytes, for a review link (brief 2.6). The take must
 * be Approved, in the production the link names, and not deleted — checked
 * here rather than trusted from the path, so a link cannot be walked into
 * the rest of the workspace.
 *
 * Range is answered here, with 206 and the object's real length: iOS Safari
 * plays no video from a server that does not, and this is the page a studio
 * sends its clients. The bytes stream through rather than redirect, so a
 * revoked link stops working at once instead of when a signature lapses.
 */
/**
 * A downloaded file's name on a client link: what the page already shows (the shot and the version), never the
 * workspace's naming template, which can carry the engine or who made the take.
 */
function clientName(shot: unknown, version: unknown): string {
  const code = typeof shot === "string" ? shot.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) : "";
  const v = Number(version);
  return `${code || "take"}_v${Number.isSafeInteger(v) && v > 0 ? v : 1}`;
}

export const GET = async function GET(req: Request, { params }: Ctx) {
  const { token, genId } = await params;
  const found = await resolveShare(token);
  if (!found) return new Response("This review link has expired or been withdrawn.", { status: 404 });

  const take = await runInTenant(found.workspace, async (): Promise<{ media: OriginalMedia; bytes: number | null; name: string } | null> => {
    await ready();
    /* A Crew review link also plays the takes waiting for review in its production (lib/security/review-link.ts). */
    const states = found.review ? "('picked','approved')" : "('approved')";
    const rs = await db().execute({
      sql: `SELECT g.kind, g.params, g.bytes, g.version, s.code AS shot_code FROM generations g LEFT JOIN shots s ON s.id = g.shot_id
            WHERE g.id = ? AND g.project_id = ? AND g.review_state IN ${states} AND g.deleted = 0 AND g.status = 'succeeded' LIMIT 1`,
      args: [genId, found.share.projectId],
    });
    const row = rs.rows[0] as { kind?: unknown; params?: unknown; bytes?: unknown; version?: unknown; shot_code?: unknown } | undefined;
    if (!row) return null;
    const bytes = Number(row.bytes);
    return { media: originalMediaOf({ kind: row.kind ?? "video", params: row.params }), bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null, name: clientName(row.shot_code, row.version) };
  });
  if (!take) return new Response("Not part of this review.", { status: 404 });
  const { media } = take;

  const headers: Record<string, string> = {
    "Content-Type": media.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
  /** The answer for an object `total` bytes long; null when the range asked for lies past it. */
  const serve = async (total: number): Promise<Response | null> => {
    let range;
    try {
      range = byteRange(req.headers.has("if-range") ? null : req.headers.get("range"), total);
    } catch {
      return null;
    }
    const { stream, size } = await openOriginalStream(media.kind, genId, range, req.signal);
    const out = { ...headers };
    if (size != null) out["Content-Length"] = String(size);
    if (range) out["Content-Range"] = `bytes ${range.start}-${range.end}/${range.total}`;
    return new Response(stream, { status: range ? 206 : 200, headers: out });
  };
  try {
    return await runInTenant(found.workspace, async () => {
      // A 3D model is not something a browser shows; it leaves as a named file.
      if (media.kind === "model") headers["Content-Disposition"] = attachmentDisposition(`${take.name}.${media.ext}`);
      /* iOS asks for many small ranges per play. The size recorded when the
         original was stored answers them without a storage probe each time;
         storage is asked only when the row has none, or the object disagrees
         (openOriginalStream checks the length it is sent against it). */
      if (take.bytes != null) {
        const served = await serve(take.bytes).catch(() => null);
        if (served) return served;
      }
      const total = await originalSize(media.kind, genId);
      if (total == null) return new Response("That take could not be read.", { status: 404 });
      return (await serve(total)) ?? new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
    });
  } catch {
    return NextResponse.json({ error: "That take could not be read." }, { status: 502 });
  }
};
