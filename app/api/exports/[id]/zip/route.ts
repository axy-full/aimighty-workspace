import { requireUser, withTenant } from "@/lib/auth";
import { ExportError } from "@/lib/exports/contract";
import { failure, whenOn } from "@/lib/exports/http";
import { exportZip } from "@/lib/exports/zip";
import { attachmentDisposition } from "@/lib/contentDisposition";

/**
 * Download all: one ready export's files (the video and any subtitle files) as one .zip, streamed. Owner only; 404 while the
 * switch is off, for an export that is not yours, and 409 until it is ready. The archive is stored (not compressed).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

const ID = /^export_[a-f0-9]{32}$/;

type Ctx = { params: Promise<{ id: string }> };

export const GET = whenOn(withTenant(async (_req: Request, ctx: Ctx) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await ctx.params;
    if (!ID.test(id)) throw new ExportError("That export was not found.", 404);
    const zip = await exportZip(auth.user.id, id);
    return new Response(zip.stream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition(zip.filename),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}));
