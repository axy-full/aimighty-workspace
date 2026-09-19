import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { identifyImage } from "@/lib/imagemeta";
import { identifyAudio } from "@/lib/audioMeta";
import { inspectStoredUploadSeconds } from "@/lib/mediaSource.server";
import { assembleChunks, streamAssembleUpload } from "@/lib/storage";
import { storeReferenceUpload } from "@/lib/uploadIntake";
import { abandonUpload, beginUploadFinish, completeUpload, planUploadObjects, prepareUpload, UploadError, uploadFailure, type FinishClaim } from "@/lib/uploadReservations";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** Identical retries recover the same immutable upload, including an interrupted DB commit. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  let claim: FinishClaim | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    const count = Number(body.count), filename = String(body.filename ?? "upload").slice(0, 200);
    const purpose = body.purpose === "chat" ? "chat" : "reference";
    claim = await beginUploadFinish(got.user.id, String(body.session ?? ""), { count, filename, purpose });
    if (claim.response || claim.prepared) return NextResponse.json(await completeUpload(claim));
    if (purpose === "reference") return NextResponse.json(await storeReferenceUpload(claim, await assembleChunks(claim.key, count), filename, count));
    const ext = (filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "bin").toLowerCase();
    await planUploadObjects(claim, [{ id: claim.uploadId, ext }], claim.bytes);
    const stored = await streamAssembleUpload(claim.key, count, claim.uploadId, ext, "application/octet-stream", claim.bytes);
    if (stored.bytes !== claim.bytes) throw new UploadError("The upload bytes do not match its chunks.");
    const meta = identifyImage(stored.headChunk) ?? identifyAudio(stored.headChunk), mime = meta?.mime ?? "application/octet-stream", kind = meta?.kind ?? "file";
    const response = { id: claim.uploadId, filename, mime, kind, bytes: stored.bytes, sha256: stored.sha256, url: `/api/uploads/${claim.uploadId}` };
    /* The original's own length, for the sound tools that price per minute.
       The mp4 header says it when the moov box leads; otherwise (and for
       every audio file) the bounded inspector reads it from the stored
       bytes. Best effort: an unreadable length is backfilled on first use. */
    let durationS = meta && "durationS" in meta ? meta.durationS : null;
    if (durationS == null && (kind === "audio" || kind === "video"))
      durationS = await inspectStoredUploadSeconds({ id: claim.uploadId, ext, kind, storedUrl: response.url, bytes: stored.bytes }).catch(() => null);
    await prepareUpload(claim, { count, response: { ...response, durationS }, record: {
      id: claim.uploadId, filename, mime, kind, ext, bytes: stored.bytes, sha256: stored.sha256,
      width: meta && "width" in meta ? meta.width : null, height: meta && "height" in meta ? meta.height : null, durationS, storedUrl: response.url,
    } });
    return NextResponse.json(await completeUpload(claim));
  } catch (error) {
    if (claim) await abandonUpload(claim).catch(() => {});
    return uploadFailure(error);
  }
});
