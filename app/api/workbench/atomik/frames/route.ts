import sharp from "sharp";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { abandonUpload, beginDirectUpload, completeUpload, planUploadObjects, prepareUpload, UploadError, type FinishClaim } from "@/lib/uploadReservations";
import { storeUpload } from "@/lib/storage";
import { getAtomikProject } from "@/lib/workbench/atomik-server";
import { assertAtomikVideoSource, AtomikReferenceError } from "@/lib/workbench/atomik-references";
export const runtime = "nodejs";
export const maxDuration = 30;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** A review still is a derived attachment, not a replacement for its video master.
 * This upload has no video-render-provider restrictions and performs no AI call. */
export const POST = withTenant(async (req: Request) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (
    req.headers.get("X-Workbench-Scope") !==
    `particl-active-${requireTenant().id}-${auth.user.id}`
  )
    return json(
      {
        error:
          "This account or workspace changed. Reopen the original project.",
      },
      409,
    );
  const url = new URL(req.url);
  if (req.headers.get("origin") && req.headers.get("origin") !== url.origin)
    return json({ error: "Invalid request origin." }, 403);
  const projectId = url.searchParams.get("projectId") ?? "",
    assetId = url.searchParams.get("assetId") ?? "";
  if (!/^[\w-]{1,100}$/.test(projectId) || !assetId || assetId.length > 100)
    return json({ error: "Choose a saved video reference." }, 400);
  if (Number(req.headers.get("content-length") || 0) > 1_000_000)
    return json({ error: "Keep sampled stills under 1 MB." }, 413);
  let claim: FinishClaim | undefined;
  try {
    const project = await getAtomikProject(auth.user.id, projectId);
    await assertAtomikVideoSource(project, assetId, auth.user.id);
    // Read at most the documented bound, even if Content-Length is absent.
    const reader = req.body?.getReader();
    if (!reader) return json({ error: "Attach a sampled still." }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1_000_000) {
          await reader.cancel();
          return json({ error: "Keep sampled stills under 1 MB." }, 413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const decoder = sharp(Buffer.concat(chunks), {
      limitInputPixels: 4_000_000,
      pages: 1,
    });
    const metadata = await decoder.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? ""))
      return json({ error: "Attach a PNG, JPEG or WebP still." }, 422);
    const { data, info } = await decoder
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#fff" })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    claim = await beginDirectUpload(auth.user.id, data.length);
    const id = claim.uploadId;
    await planUploadObjects(claim, [{ id, ext: "jpg" }], data.length);
    const stored = await storeUpload(id, "jpg", data, "image/jpeg");
    await prepareUpload(claim, { count: 0, response: { id }, record: {
      id, filename: "Atomik video review still.jpg", mime: "image/jpeg", ext: "jpg", bytes: data.length,
      sha256: stored.sha256, width: info.width, height: info.height, storedUrl: stored.url, kind: "image", durationS: null,
    } });
    await completeUpload(claim);
    return json({ id });
  } catch (error) {
    if (claim) await abandonUpload(claim).catch(() => {});
    const status = Number((error as { status?: number })?.status) || 422;
    /* Storage full, a still too large, a reference that is not this project's: say which. */
    if ((error instanceof UploadError || error instanceof AtomikReferenceError) && error.message && status !== 404)
      return json({ error: error.message }, status);
    return json(
      {
        error:
          status === 404
            ? "This video is unavailable in the current workspace."
            : "The video still could not be prepared. Reopen the project and try again.",
      },
      status,
    );
  }
});
