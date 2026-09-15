import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { abandonUpload, beginDirectUpload, uploadFailure, UploadError, type FinishClaim } from "@/lib/uploadReservations";
import { storeReferenceUpload } from "@/lib/uploadIntake";
import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listLibraryUploads } from "@/lib/uploadLibrary";
import { AssetQueryError } from "@/lib/assetPagination";

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
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  try {
    return NextResponse.json(await listLibraryUploads(new URL(req.url).searchParams), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AssetQueryError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
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
