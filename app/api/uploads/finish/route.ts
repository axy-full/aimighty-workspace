import { after, NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { identifyImage } from "@/lib/imagemeta";
import { identifyAudio } from "@/lib/audioMeta";
import { inspectStoredUploadSeconds } from "@/lib/mediaSource.server";
import { assembleChunks, streamAssembleUpload, uploadPath } from "@/lib/storage";
import { storeReferenceUpload } from "@/lib/uploadIntake";
import { abandonUpload, beginUploadFinish, completeUpload, planUploadObjects, prepareUpload, UploadError, uploadFailure, uploadFailureBody, type FinishClaim } from "@/lib/uploadReservations";

export const dynamic = "force-dynamic";
/* Vercel ends after() work with the function; self-hosted `next start` has no
   such limit. The upload lease (20 min) stays above both. */
export const maxDuration = 800;

/** A finish done by then (a small file) is answered with its receipt, as before. */
const ANSWER_WITHIN_MS = 10_000;
/** Otherwise the answer is 202 and the client reads /api/uploads/session from this long on. */
const POLL_AFTER_MS = 1_000;

/** Test-only: delay the assembly and shorten the wait, in the mock dev server only (never in production). */
function finishTiming(req: Request) {
  const timing = { delayMs: 0, answerWithinMs: ANSWER_WITHIN_MS };
  if (process.env.ENGINE_MOCK !== "1" || process.env.NODE_ENV === "production") return timing;
  const read = (name: string, max: number) => {
    const raw = req.headers.get(name);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, max) : undefined;
  };
  return {
    delayMs: read("x-particl-test-finish-delay-ms", 60_000) ?? 0,
    answerWithinMs: read("x-particl-test-finish-answer-ms", ANSWER_WITHIN_MS) ?? ANSWER_WITHIN_MS,
  };
}
/** A background failure has no response to carry it: log it with the session id and the error's
 *  class only (never a filename, storage key or message, which can name the customer's file). */
function logFinishFailure(event: string, claim: FinishClaim, error: unknown, status?: number) {
  console.error(JSON.stringify({
    event,
    session: claim.key.slice(claim.key.lastIndexOf("/") + 1),
    error: error instanceof Error ? error.name : typeof error,
    ...(status ? { status } : {}),
  }));
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Everything after the claim: assemble, store, prepare and publish the upload under the claim's lease. */
async function assemble(claim: FinishClaim, count: number, filename: string, purpose: "chat" | "reference") {
  if (claim.prepared) return completeUpload(claim);
  if (purpose === "reference") return storeReferenceUpload(claim, await assembleChunks(claim.key, count), filename, count);
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
    width: meta && "width" in meta ? meta.width : null, height: meta && "height" in meta ? meta.height : null, durationS, storedUrl: uploadPath(claim.uploadId, ext),
  } });
  return completeUpload(claim);
}

/**
 * Claims the upload session at once (validation, lease, storage reservation),
 * then assembles in the background. A finish done within ~10 s answers its
 * receipt; a longer one answers 202 and the session (GET /api/uploads/session)
 * turns `committed` with the same receipt, or ends with its failure and its
 * reservation released. Identical retries recover the same immutable upload:
 * 409 while it is finishing, the saved receipt once committed.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  let claim: FinishClaim | undefined;
  let running: Promise<{ receipt: Record<string, unknown> } | { error: unknown }>;
  const timing = finishTiming(req);
  try {
    const body = await req.json().catch(() => ({}));
    const count = Number(body.count), filename = String(body.filename ?? "upload").slice(0, 200);
    const purpose = body.purpose === "chat" ? "chat" : "reference";
    claim = await beginUploadFinish(got.user.id, String(body.session ?? ""), { count, filename, purpose });
    if (claim.response) return NextResponse.json(await completeUpload(claim));
    const owned = claim;
    const run = await reserveRecoveryContinuation("upload-finish", async () => {
      try {
        if (timing.delayMs) await wait(timing.delayMs);
        return { receipt: await assemble(owned, count, filename, purpose) };
      } catch (error) {
        // The reservation is released exactly as a failed synchronous finish released it.
        const failure = uploadFailureBody(error);
        logFinishFailure("upload_finish_failed", owned, error, failure.status);
        await abandonUpload(owned, failure).catch((abandonError: unknown) =>
          logFinishFailure("upload_finish_release_failed", owned, abandonError),
        );
        return { error };
      }
    });
    // The work catches its own failure; only the fence's own bookkeeping can still reject here.
    running = run().catch((error: unknown) => ({ error }));
  } catch (error) {
    if (claim) await abandonUpload(claim, uploadFailureBody(error)).catch(() => {});
    return uploadFailure(error);
  }
  after(running.then(() => undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([running, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timing.answerWithinMs); })]);
  clearTimeout(timer);
  if (done) return "receipt" in done ? NextResponse.json(done.receipt) : uploadFailure(done.error);
  return NextResponse.json(
    { state: "assembling", pollAfterMs: POLL_AFTER_MS },
    { status: 202, headers: { "Retry-After": String(POLL_AFTER_MS / 1000), "Cache-Control": "private, no-store" } },
  );
});
