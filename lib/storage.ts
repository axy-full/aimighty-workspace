import { withRecoveryActivity } from './recovery';
import { mkdir, writeFile, readFile, stat, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { currentTenant } from "./tenant";
import { isFixtureUrl } from "./mock";
import { fetchBytes } from "./mockFs";
import type { ByteRange } from './mediaRange';
import { cloudBackend, resolveStored, usingCloud, type ResolvedObject, type StorageBackend } from "./storage/backend";

export { backendKind, usingCloud, type StorageBackendKind } from "./storage/backend";

/**
 * Ark's video_url expires (~24h). We copy every finished render into our own
 * storage the first time we see it complete, so links never rot.
 *
 * A cloud backend (Vercel Blob today, Cloudflare R2 behind STORAGE_BACKEND=r2)
 * when one is configured, local disk otherwise; see lib/storage/backend.ts.
 *
 * Objects are stored PRIVATE and streamed back through our own authenticated
 * routes. A public blob URL is reachable by anyone who has the link, which is
 * wrong for client work — nothing here should be viewable outside the login.
 */

/**
 * Deterministic blob paths, so a row id is enough to find the object.
 * Every workspace but the studio's original one keeps its objects under
 * its own prefix; the original keeps the bare paths it always had.
 */
const prefix = () => { const ws = currentTenant()?.workspace; return ws && !ws.legacy ? `ws/${ws.id}/` : ""; };
export const videoPath  = (genId: string) => `${prefix()}generations/${genId}.mp4`;
export const imagePath  = (genId: string) => `${prefix()}generations/${genId}.png`;
export const audioPath  = (genId: string) => `${prefix()}generations/${genId}.mp3`;
/** 3D originals from the connected account (GLB, or a zip the provider returned). */
export const modelPath  = (genId: string) => `${prefix()}generations/${genId}.glb`;
export type OriginalKind = "video" | "image" | "audio" | "model";
const originalExt: Record<OriginalKind, string> = { video: "mp4", image: "png", audio: "mp3", model: "glb" };
const originalPath = (kind: OriginalKind, genId: string) =>
  kind === "image" ? imagePath(genId) : kind === "audio" ? audioPath(genId) : kind === "model" ? modelPath(genId) : videoPath(genId);
/** The photo set an identity was trained from, zipped for the trainer. */
export const identityZipPath = (identityId: string) => `${prefix()}identities/${identityId}.zip`;
export const uploadPath = (uploadId: string, ext: string) => `${prefix()}uploads/${uploadId}.${ext}`;

const LOCAL_DIR = path.join(process.cwd(), ".data", "generations");
/* Platform assets (brief 1.4): the bank's neutral previews. No tenant prefix — every workspace reads them. */
const PLATFORM_DIR = path.join(process.cwd(), ".data", "platform");
export const platformPath = (file: string) => `platform/${file}`;

export async function storePlatformBytes(file: string, buf: Buffer, contentType: string): Promise<string> {
return await withRecoveryActivity('storage', async () => {

  if (!/^[A-Za-z0-9_\-:./]+$/.test(file) || file.includes("..")) throw new Error("bad platform path");
  if (usingCloud()) {
    await cloudBackend().put(platformPath(file), buf, { contentType, overwrite: true });
    return platformPath(file);
  }
  const full = path.join(PLATFORM_DIR, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf);
  return platformPath(file);

});
}

export async function readPlatformBytes(file: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_\-:./]+$/.test(file) || file.includes("..")) throw new Error("bad platform path");
  if (usingCloud()) return readCloud(platformPath(file));
  return readFile(path.join(PLATFORM_DIR, file));
}

/** True when a cloud backend holds the objects — Blob or R2. The name predates R2; usingCloud() is the same test. */
export function usingBlob(): boolean {
  return usingCloud();
}

/** A stored row value that names an object outside the deterministic key: an
 *  absolute URL from an older browser-direct upload. Route URLs and empty
 *  values are not storage-shaped and fall through to the caller's own key. */
function storedObject(stored?: string | null): ResolvedObject | null {
  return stored && /^https?:\/\//.test(stored) ? resolveStored(stored) : null;
}

async function download(sourceUrl: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("The render's file did not finish downloading in 120s.");
    }
    throw new Error(`Could not download the render: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Could not download render (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function storeVideo(genId: string, sourceUrl: string): Promise<{ url: string; bytes: number }> {
return await withRecoveryActivity('storage', async () => {

  /* Two minutes, and no less: a 200 MB master over a slow link legitimately
     needs it, and abandoning one early would strand the very render the cron
     exists to rescue. But not unbounded either — this runs 30-wide inside a
     300s cron, where one stalled download could own the whole window. */
  const buf = isFixtureUrl(sourceUrl) ? await fetchBytes(sourceUrl) : await download(sourceUrl);

  if (usingCloud()) {
    // Saves are retried by every poll until they stick. Without overwrite, a
    // partial first attempt leaves an object behind and every retry then dies
    // on "already exists" — the video never records as saved.
    await cloudBackend().put(videoPath(genId), buf, { contentType: "video/mp4", overwrite: true });
    // Always hand back our own route, never a storage URL.
    return { url: `/api/media/${genId}`, bytes: buf.length };
  }

  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.mp4`), buf);
  return { url: `/api/media/${genId}`, bytes: buf.length };

});
}

/** Reads a private object back as bytes, from the active backend or the one a stored URL names. */
async function readCloud(key: string, backend: StorageBackend = cloudBackend()): Promise<Buffer> {
  const found = await backend.get(key);
  if (!found) throw new Error("blob not found");
  const reader = found.stream.getReader(), chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

export async function readVideoBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingCloud()) return readCloud(videoPath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.mp4`));
}

/** Bounded private read for immutable consumer-original recovery. */
export const readVideoBytesLimited = (genId: string, maximum: number) => readOriginalBytesLimited("video", genId, maximum);
export async function readOriginalBytesLimited(kind: OriginalKind, genId: string, maximum: number): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100 * 1024 * 1024) throw new Error("Invalid original video read.");
  if (!usingCloud()) {
    const file = path.join(LOCAL_DIR, `${genId}.${originalExt[kind]}`);
    try {
      if ((await stat(file)).size > maximum) throw new Error("Stored original exceeds its recorded length.");
      const bytes = await readFile(file);
      if (bytes.length > maximum) throw new Error("Stored original exceeds its recorded length.");
      return bytes;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  const found = await cloudBackend().get(originalPath(kind, genId), { signal: AbortSignal.timeout(20_000) });
  if (!found) return null;
  const reader = found.stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if ((length += part.value.byteLength) > maximum) throw new Error("Stored original exceeds its recorded length.");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, length);
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Store an already validated MP4 without changing a byte. Unlike mutable render
 * storage, this never overwrites a prior original: repeats must match its hash. */
export const storeVideoBytes = (genId: string, bytes: Buffer) => storeOriginalBytes("video", genId, bytes, "video/mp4");
/** Immutable original storage for every connected-account output kind. The
 * content type is what the provider served; the object path is fixed per kind. */
export async function storeOriginalBytes(kind: OriginalKind, genId: string, bytes: Buffer, contentType: string): Promise<{url: string; bytes: number; sha256: string}> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId) || !bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error("Invalid original video.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const verifyExisting = async () => {
    const existing = await readOriginalBytesLimited(kind, genId, bytes.length);
    if (!existing || existing.length !== bytes.length || createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("The stored original could not be verified; it was not overwritten.");
  };
  await withRecoveryActivity("storage", async () => {
    if (usingCloud()) {
      // overwrite:false rejects with ObjectExistsError when the original is
      // already there; any failure to write leads to the same verification.
      try { await cloudBackend().put(originalPath(kind, genId), bytes, { contentType, overwrite: false, signal: AbortSignal.timeout(30_000) }); }
      catch { await verifyExisting(); }
      return;
    }
    await mkdir(LOCAL_DIR, { recursive: true });
    const destination = path.join(LOCAL_DIR, `${genId}.${originalExt[kind]}`), temporary = path.join(LOCAL_DIR, `.${genId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await verifyExisting(); }
    } finally { await unlink(temporary).catch(() => {}); }
  });
  return { url: `/api/media/${genId}`, bytes: bytes.length, sha256 };
}

/* ── Image renders (Nano Banana) — bytes arrive in the API response, not at
 * a downloadable URL, so they're stored directly. Same privacy rules. ── */

export async function storeImageBytes(genId: string, buf: Buffer): Promise<{ url: string; bytes: number }> {
return await withRecoveryActivity('storage', async () => {

  if (usingCloud()) {
    await cloudBackend().put(imagePath(genId), buf, { contentType: "image/png", overwrite: true });
    return { url: `/api/media/${genId}`, bytes: buf.length };
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.png`), buf);
  return { url: `/api/media/${genId}`, bytes: buf.length };

});
}

export async function readImageBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingCloud()) return readCloud(imagePath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.png`));
}

/* ── Audio renders (ElevenLabs) — MP3 bytes arrive in the response body. ── */

export async function storeAudioBytes(genId: string, buf: Buffer): Promise<{ url: string; bytes: number }> {
return await withRecoveryActivity('storage', async () => {

  if (usingCloud()) {
    await cloudBackend().put(audioPath(genId), buf, { contentType: "audio/mpeg", overwrite: true });
    return { url: `/api/media/${genId}`, bytes: buf.length };
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.mp3`), buf);
  return { url: `/api/media/${genId}`, bytes: buf.length };

});
}

export async function readAudioBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingCloud()) return readCloud(audioPath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.mp3`));
}
export async function readModelBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingCloud()) return readCloud(modelPath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.glb`));
}

/**
 * The zip a trainer learns a face from. Private like everything else; the
 * trainer receives a signed link that expires, never the store. Returns the
 * store pathname (or the local file path in development).
 */
export async function storeIdentityZip(identityId: string, buf: Buffer): Promise<string> {
return await withRecoveryActivity('storage', async () => {

  if (!/^[A-Za-z0-9_-]+$/.test(identityId)) throw new Error("bad id");
  if (usingCloud()) {
    await cloudBackend().put(identityZipPath(identityId), buf, { contentType: "application/zip", overwrite: true });
    return identityZipPath(identityId);
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  const local = path.join(LOCAL_DIR, `${identityId}.zip`);
  await writeFile(local, buf);
  return local;

});
}

/**
 * A render's bytes as a stream, for handing straight to a Response.
 *
 * Downloads used to load the whole file into the function first — fine for a
 * few megabytes, a memory cliff for a 30-second 1080p clip, and pure waste
 * when the bytes are only passing through.
 */
export async function openMediaStream(
  genId: string, kind: OriginalKind
): Promise<ReadableStream<Uint8Array>> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  const pathname = originalPath(kind, genId);
  if (usingCloud()) {
    const found = await cloudBackend().get(pathname);
    if (!found) throw new Error("blob not found");
    return found.stream;
  }
  const { createReadStream } = await import("node:fs");
  const local = path.join(LOCAL_DIR, `${genId}.${originalExt[kind]}`);
  const node = createReadStream(local);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (c) => controller.enqueue(new Uint8Array(c as Buffer)));
      node.on("end", () => controller.close());
      node.on("error", (e) => controller.error(e));
    },
    cancel() { node.destroy(); },
  });
}

/* ── Reference image uploads ──────────────────────────────────────────────
 * Bytes are written EXACTLY as received. Nothing here decodes, resizes,
 * strips metadata or re-encodes. `storeUpload` returns the sha256 of what it
 * wrote so the caller can prove it matches what arrived.
 * -------------------------------------------------------------------- */

const UPLOAD_DIR = path.join(process.cwd(), ".data", "uploads");

export async function storeUpload(
  uploadId: string, ext: string, buf: Buffer, contentType: string
): Promise<{ url: string; sha256: string }> {
return await withRecoveryActivity('storage', async () => {

  const { createHash } = await import("node:crypto");

  if (usingCloud()) {
    await cloudBackend().put(uploadPath(uploadId, ext), buf, { contentType, overwrite: true });
    return {
      url: `/api/uploads/${uploadId}`,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const file = path.join(UPLOAD_DIR, `${uploadId}.${ext}`);
  await writeFile(file, buf);

  // Hash what actually landed on disk, not what we held in memory.
  const written = await readFile(file);
  return { url: `/api/uploads/${uploadId}`, sha256: createHash("sha256").update(written).digest("hex") };

});
}

export async function readUploadBytes(uploadId: string, ext: string, storedUrl: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error("bad upload id");
  if (usingCloud()) {
    const stored = storedObject(storedUrl);
    if (stored) {
      // Browser-direct upload. Public host → plain fetch;
      // anything else goes through the authorized private read.
      if (stored.publicUrl) {
        const res = await fetch(stored.key);
        if (!res.ok) throw new Error(`Could not read upload ${uploadId} (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      }
      return readCloud(stored.key, stored.backend);
    }
    return readCloud(uploadPath(uploadId, ext));
  }
  return readFile(path.join(UPLOAD_DIR, `${uploadId}.${ext}`));
}

/** Best-effort removal of a render's stored file — video or image. */
export async function deleteVideo(genId: string, strict = false, storedUrl?: string | null): Promise<void> {
return await withRecoveryActivity('storage', async () => {

  if (!/^[A-Za-z0-9_-]+$/.test(genId)) { if (strict) throw new Error("Invalid generation media identity"); return; }
  const targets = [videoPath(genId), imagePath(genId), audioPath(genId)];
  if (usingCloud() && storedUrl && /^https?:\/\//.test(storedUrl)) targets.push(storedUrl);
  for (const target of targets) {
    try {
      if (usingCloud()) {
        const stored = storedObject(target);
        await (stored ? stored.backend.del([stored.key]) : cloudBackend().del([target]));
      } else {
        const { rm } = await import("node:fs/promises");
        await rm(path.join(LOCAL_DIR, path.basename(target)), { force: true });
      }
    } catch (error) { if (strict) throw error; }
  }

});
}

/** Best-effort removal of an upload's stored file (blob URL, pathname, or local). */
export async function deleteUpload(uploadId: string, ext: string, storedUrl: string, strict = false): Promise<void> {
return await withRecoveryActivity('storage', async () => {

  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) return;
  try {
    if (usingCloud()) {
      // Browser-direct uploads carry a random suffix known only via stored_url.
      const stored = storedObject(storedUrl);
      await (stored ? stored.backend.del([stored.key]) : cloudBackend().del([uploadPath(uploadId, ext)]));
    } else {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(UPLOAD_DIR, `${uploadId}.${ext}`), { force: true });
    }
  } catch (error) { if (strict) throw error; }

});
}

/* ── Chunked uploads ──────────────────────────────────────────────────────
 * Vercel caps a request body at 4.5MB, but reference media runs to 30MB
 * (images) or 200MB (videos). The browser slices the file and posts each
 * chunk through our authed route; finish() reassembles them server-side and
 * writes ONE final private object. Bytes are never transformed.
 * -------------------------------------------------------------------- */

const CHUNK_DIR = path.join(process.cwd(), ".data", "chunks");
const chunkPath = (sess: string, i: number) => `${prefix()}chunks/${sess}/${i}`;

export async function storeChunk(sess: string, i: number, buf: Buffer): Promise<void> {
return await withRecoveryActivity('storage', async () => {

  if (usingCloud()) {
    await cloudBackend().put(chunkPath(sess, i), buf, { contentType: "application/octet-stream", overwrite: true });
    return;
  }
  await mkdir(path.join(CHUNK_DIR, prefix(), sess), { recursive: true });
  await writeFile(path.join(CHUNK_DIR, prefix(), sess, String(i)), buf);

});
}

export async function assembleChunks(sess: string, count: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      usingCloud()
        ? await readCloud(chunkPath(sess, i))
        : await readFile(path.join(CHUNK_DIR, prefix(), sess, String(i)))
    );
  }
  return Buffer.concat(parts);
}

export async function deleteChunks(sess: string, count: number, strict = false): Promise<void> {
return await withRecoveryActivity('storage', async () => {

  try {
    if (usingCloud()) {
      await cloudBackend().del(Array.from({ length: count }, (_, i) => chunkPath(sess, i)));
    } else {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(CHUNK_DIR, prefix(), sess), { recursive: true, force: true });
    }
  } catch (error) { if (strict) throw error; }

});
}

/* ── Presigned reads ──────────────────────────────────────────────────────
 * ModelArk fetches reference media over plain HTTPS — reference videos ONLY
 * accept a URL (no base64). A presigned GET gives it a time-limited link to
 * a private object: nothing becomes public, the link just works for a while.
 * -------------------------------------------------------------------- */

export async function presignedReadUrl(pathname: string, hours = 24): Promise<string> {
  return cloudBackend().presignGet(pathname, Date.now() + hours * 3600_000);
}

/* ── Streaming assembly, for chat attachments up to 2GB ───────────────────
 * A function must never hold a 2GB file: chunks are pulled one at a time and
 * fed straight into storage — a multipart blob upload in production, an
 * appending write stream on disk locally — while a running sha256 proves the
 * assembled object is byte-identical to what the browser sliced.
 * -------------------------------------------------------------------- */

export async function streamAssembleUpload(
  sess: string, count: number, uploadId: string, ext: string, contentType: string, maxBytes = 2 * 1024 * 1024 * 1024
): Promise<{ sha256: string; bytes: number; headChunk: Buffer }> {
return await withRecoveryActivity('storage', async () => {

  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  let total = 0;
  let headChunk: Buffer | null = null;

  const pathnameFor = uploadPath(uploadId, ext);

  async function* chunks(): AsyncGenerator<Buffer> {
    for (let i = 0; i < count; i++) {
      const buf = usingCloud()
        ? await readCloud(chunkPath(sess, i))
        : await readFile(path.join(CHUNK_DIR, prefix(), sess, String(i)));
      if (i === 0) headChunk = buf;
      hash.update(buf);
      total += buf.length;
      if (total > maxBytes) throw new Error("Upload exceeds its reserved byte limit.");
      yield buf;
    }
  }

  if (usingCloud()) {
    // The backend splits the stream into parts itself — memory stays flat.
    await cloudBackend().put(pathnameFor, Readable.from(chunks()), { contentType, overwrite: true, multipart: true });
  } else {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    await pipeline(
      Readable.from(chunks()),
      createWriteStream(path.join(UPLOAD_DIR, `${uploadId}.${ext}`))
    );
  }

  return { sha256: hash.digest("hex"), bytes: total, headChunk: headChunk ?? Buffer.alloc(0) };

});
}

/** Streams a stored upload out without buffering — a 2GB download must flow
 *  through the function, never sit in it. */
export async function openUploadStream(
  uploadId: string, ext: string, range?: ByteRange | null, storedUrl?: string, signal?: AbortSignal
): Promise<{ stream: ReadableStream; size: number | null }> {
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error("bad upload id");
  if (usingCloud()) {
    const stored = storedObject(storedUrl);
    const backend = stored ? stored.backend : cloudBackend(), target = stored ? stored.key : uploadPath(uploadId, ext);
    const found = await backend.get(target, { ...(range ? { range } : {}), signal, identity: true });
    if (!found) throw new Error("blob not found");
    const encoding = found.headers.get('content-encoding');
    const identity = !encoding || encoding.trim().toLowerCase() === 'identity';
    if(range && (!identity || found.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${range.total}`)){await found.stream.cancel().catch(()=>{});throw new Error('Storage did not honor the requested media range');}
    // Blob's SDK uses size: 0 when Content-Length is absent. Forwarding that
    // fallback truncates a nonempty stream at the HTTP boundary. A decoded
    // response's encoded length is equally unsafe; let unknown lengths stream.
    const length = found.headers.get('content-length');
    const knownLength = identity && length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length));
    const size = range ? range.end - range.start + 1 : knownLength ? Number(length) : null;
    return { stream: found.stream as ReadableStream, size };
  }
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  const file = path.join(UPLOAD_DIR, `${uploadId}.${ext}`);
  const st = await stat(file);
  if(range && st.size!==range.total)throw new Error('Upload length changed');
  return {
    stream: Readable.toWeb(createReadStream(file, {...(range?{start:range.start,end:range.end}:{}),signal})) as ReadableStream,
    size: range ? range.end-range.start+1 : st.size,
  };
}

/** Bounded reads of a retained generation, for metadata inspection without a full download. */
export async function openVideoStream(genId: string, range: ByteRange, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad generation id");
  if (usingCloud()) {
    const found = await cloudBackend().get(videoPath(genId), { range, signal, identity: true });
    if (!found) throw new Error("Original video not found");
    const encoding = found.headers.get('content-encoding');
    if ((encoding && encoding.trim().toLowerCase() !== 'identity') || found.headers.get("content-range") !== `bytes ${range.start}-${range.end}/${range.total}`) { await found.stream.cancel().catch(()=>{}); throw new Error("Storage did not honor the requested original range"); }
    return found.stream;
  }
  const {createReadStream} = await import("node:fs");
  const {stat} = await import("node:fs/promises");
  const file = path.join(LOCAL_DIR, `${genId}.mp4`);
  if ((await stat(file)).size !== range.total) throw new Error("Original video length changed");
  return Readable.toWeb(createReadStream(file,{start:range.start,end:range.end,signal})) as ReadableStream<Uint8Array>;
}
