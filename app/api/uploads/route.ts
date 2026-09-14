import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { abandonUpload, beginDirectUpload, uploadFailure, UploadError, type FinishClaim } from "@/lib/uploadReservations";
import { storeReferenceUpload } from "@/lib/uploadIntake";
import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Accepts one image and stores it BYTE-FOR-BYTE.
 *
 * There is no compression step anywhere in this path: the request body is read
 * as raw bytes, written unchanged, then re-read from storage and hashed. The
 * response carries that hash so the client can compare it against its own —
 * if the two match, the stored file is provably identical to the file picked.
 *
 * R4: a master that a downstream API won't accept is no longer refused. The
 * master is kept exactly as it arrived, and a separate DELIVERY COPY is
 * derived to fit the vendor's limits — so a 30 MB ceiling at ByteDance can't
 * decide what resolution this studio is allowed to keep. The copy is never
 * shown in the library, downloaded, or exported; it exists only to be sent.
 */
/**
 * The workspace's uploads, newest first — the Library's References board
 * (design/particl-v2/README.md §11): loose, unversioned, free until one is
 * promoted to an asset. `?limit=` caps the page (200 by default, 500 at most).
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const limit = Math.max(1, Math.min(500, Number(new URL(req.url).searchParams.get("limit") ?? 200) || 200));
  const rs = await db().execute({
    sql: `SELECT id, filename, mime, bytes, width, height, kind, duration_s, created_at FROM uploads ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const uploads = rs.rows.map((r: any) => ({
    id: String(r.id), filename: String(r.filename ?? ""), mime: String(r.mime ?? ""), bytes: Number(r.bytes ?? 0),
    width: r.width == null ? null : Number(r.width), height: r.height == null ? null : Number(r.height),
    kind: r.kind === "video" ? "video" : "image", durationS: r.duration_s == null ? null : Number(r.duration_s),
    /* Served by this app, never the blob's own address: `/api/uploads/[id]` decides what a browser may render. */
    url: `/api/uploads/${encodeURIComponent(String(r.id))}`,
    createdAt: Number(r.created_at ?? 0),
  }));
  return NextResponse.json({ uploads });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  let claim: FinishClaim | undefined;
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new UploadError("Attach a file field.");
    claim = await beginDirectUpload(got.user.id, file.size);
    return NextResponse.json(await storeReferenceUpload(claim, Buffer.from(await file.arrayBuffer()), file.name.slice(0, 200)));
  } catch (error) {
    if (claim) await abandonUpload(claim).catch(() => {});
    return uploadFailure(error);
  }
});
