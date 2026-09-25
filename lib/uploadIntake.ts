import { validateAstraGlb } from './astra-blender/glb';
import { inspectStoredUploadSeconds } from "./mediaSource.server";
import { identifyImage, validateVideo } from "./imagemeta";
import { identifyAudio } from "./audioMeta";
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
  if (/\.blend$/i.test(filename)) {
    if (buf.length < 12 || buf.length > 50 * 1024 * 1024 || !/^BLENDER[-_][vV][0-9]{3}$/.test(buf.toString('ascii', 0, 12))) throw new UploadError('Use an uncompressed .blend file smaller than 50 MB. Disable Compress when saving in Blender.');
    await planUploadObjects(claim, [{ id: claim.uploadId, ext: 'blend' }], buf.length);
    const master = await storeUpload(claim.uploadId, 'blend', buf, 'application/x-blender');
    const response = { id: claim.uploadId, filename, mime: 'application/x-blender', kind: 'file', bytes: buf.length, width: null, height: null, durationS: null, sha256: master.sha256, url: `/api/uploads/${claim.uploadId}` };
    await prepareUpload(claim, { count, response, record: { id: claim.uploadId, filename, mime: response.mime, kind: 'file', ext: 'blend', bytes: buf.length, sha256: master.sha256, width: null, height: null, durationS: null, storedUrl: master.url } });
    return completeUpload(claim);
  }
  if (/\.glb$/i.test(filename) || (buf.length >= 4 && buf.readUInt32LE(0) === 0x46546c67)) {
    try { validateAstraGlb(buf); } catch(error) { throw new UploadError((error as Error).message); }
    await planUploadObjects(claim, [{ id: claim.uploadId, ext: 'glb' }], buf.length);
    const master = await storeUpload(claim.uploadId, 'glb', buf, 'model/gltf-binary');
    const response = { id: claim.uploadId, filename, mime: 'model/gltf-binary', kind: 'file', bytes: buf.length, width: null, height: null, durationS: null, sha256: master.sha256, url: `/api/uploads/${claim.uploadId}` };
    await prepareUpload(claim, { count, response, record: { id: claim.uploadId, filename, mime: response.mime, kind: 'file', ext: 'glb', bytes: buf.length, sha256: master.sha256, width: null, height: null, durationS: null, storedUrl: master.url } });
    return completeUpload(claim);
  }
  const meta = identifyImage(buf);
  if (!meta)
    throw new UploadError(
      `${identifyAudio(buf) ? "Audio can't be a reference." : "Unrecognised file."} Images: jpeg/png/webp/bmp/tiff/gif/heic. Videos: mp4/mov.`,
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
  /* A video whose moov box trails its media states no length in its head;
     the bounded inspector reads it from the stored file (best effort — a
     missing length is backfilled on first use by the sound tools). */
  const durationS = meta.kind === "video" && meta.durationS == null
    ? await inspectStoredUploadSeconds({ id: uploadId, ext: meta.ext, kind: "video", storedUrl: master.url, bytes: buf.length }).catch(() => null)
    : meta.durationS;
  const response = {
    id: uploadId,
    filename,
    mime: meta.mime,
    kind: meta.kind,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    durationS,
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
      durationS,
      derivativeUrl: copy?.url,
      derivativeBytes: derivative?.bytes.length,
      derivativeNote: derivative?.note,
    },
  });
  return completeUpload(claim);
}
