import { NextResponse } from "next/server";
import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { db, ready } from "@/lib/db";
import { openMediaStream } from "@/lib/storage";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string; genId: string }> };

/**
 * One Approved take's bytes, for a review link (brief 2.6). The take must
 * be Approved, in the production the link names, and not deleted — checked
 * here rather than trusted from the path, so a link cannot be walked into
 * the rest of the workspace.
 */
export const GET = async function GET(_req: Request, { params }: Ctx) {
  const { token, genId } = await params;
  const found = await resolveShare(token);
  if (!found) return new Response("This review link has expired or been withdrawn.", { status: 404 });

  const kind = await runInTenant(found.workspace, async () => {
    await ready();
    const rs = await db().execute({
      sql: `SELECT kind FROM generations WHERE id = ? AND project_id = ? AND review_state = 'approved' AND deleted = 0 AND status = 'succeeded' LIMIT 1`,
      args: [genId, found.share.projectId],
    });
    return rs.rows.length ? String((rs.rows[0] as { kind?: string }).kind ?? "video") : null;
  });
  if (!kind) return new Response("Not part of this review.", { status: 404 });

  const media: "video" | "image" | "audio" = kind === "image" ? "image" : kind === "audio" ? "audio" : "video";
  try {
    const stream = await runInTenant(found.workspace, () => openMediaStream(genId, media));
    return new Response(stream, {
      headers: {
        "Content-Type": media === "image" ? "image/png" : media === "audio" ? "audio/mpeg" : "video/mp4",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "That take could not be read." }, { status: 502 });
  }
};
