import { identifyImage, validateVideo } from "./imagemeta";
import { storeUpload } from "./storage";
import { getProvider, DEFAULT_PROVIDER } from "./providers";
import { assess, deriveForProvider } from "./derive";
import { getSetting } from "./settings";
import {
  completeUpload,
  planUploadObjects,
  prepareUpload,
  UploadError,
  type FinishClaim,
} from "./uploadReservations";

/** Derive and reserve before writing; originals remain byte-for-byte unchanged. */
export async function storeReferenceUpload(
  claim: FinishClaim,
  buf: Buffer,
  filename: string,
  count = 0,
) {
  if (buf.length !== claim.bytes)
    throw new UploadError("The upload bytes do not match its chunks.");
  const meta = identifyImage(buf);
  if (!meta)
    throw new UploadError(
      "Unrecognised file. Images: jpeg/png/webp/bmp/tiff/gif/heic. Videos: mp4/mov.",
    );
  const provider = getProvider(DEFAULT_PROVIDER);
  if (meta.kind === "video") {
    const problem = validateVideo(meta, buf.length);
    if (problem) throw new UploadError(problem);
  }
  const verdict =
    meta.kind === "image"
      ? assess(meta, buf.length, provider)
      : { ok: true, reasons: [] as string[], derivable: false };
  const mayDerive = (await getSetting("deriveForApi")) !== "0";
  if (!verdict.ok && (!verdict.derivable || !mayDerive))
    throw new UploadError(
      `This asset can't be sent to ${provider.label}: ${verdict.reasons.join("; ")}.` +
        (verdict.derivable
          ? " Delivery copies are switched off in Settings, so it was not stored."
          : " Nothing was compressed — send a larger original."),
    );
  let derivative: Awaited<ReturnType<typeof deriveForProvider>> | null = null;
  if (!verdict.ok && verdict.derivable && mayDerive) {
    try {
      derivative = await deriveForProvider(buf, provider);
    } catch {
      throw new UploadError(
        `${provider.label} won't accept this asset and a delivery copy could not be made. Try another original.`,
      );
    }
  }
  const uploadId = claim.uploadId;
  await planUploadObjects(
    claim,
    [
      { id: uploadId, ext: meta.ext },
      ...(derivative ? [{ id: `${uploadId}-api`, ext: derivative.ext }] : []),
    ],
    buf.length + (derivative?.bytes.length ?? 0),
  );
  const master = await storeUpload(uploadId, meta.ext, buf, meta.mime);
  const copy = derivative
    ? await storeUpload(
        `${uploadId}-api`,
        derivative.ext,
        derivative.bytes,
        derivative.mime,
      )
    : null;
  const response = {
    id: uploadId,
    filename,
    mime: meta.mime,
    kind: meta.kind,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    durationS: meta.durationS,
    sha256: master.sha256,
    url: `/api/uploads/${uploadId}`,
    delivery: derivative
      ? { note: derivative.note, bytes: derivative.bytes.length }
      : null,
    base64Bytes: meta.kind === "video" ? 0 : Math.ceil(buf.length / 3) * 4,
  };
  await prepareUpload(claim, {
    count,
    response,
    record: {
      id: uploadId,
      filename,
      mime: meta.mime,
      ext: meta.ext,
      bytes: buf.length,
      sha256: master.sha256,
      width: meta.width,
      height: meta.height,
      storedUrl: master.url,
      kind: meta.kind,
      durationS: meta.durationS,
      derivativeUrl: copy?.url,
      derivativeBytes: derivative?.bytes.length,
      derivativeNote: derivative?.note,
    },
  });
  return completeUpload(claim);
}
