import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { currentTenant } from "./tenant";
import { isFixtureUrl } from "./mock";
import { fetchBytes } from "./mockFs";
import type { ByteRange } from './mediaRange';

/**
 * Ark's video_url expires (~24h). We copy every finished render into our own
 * storage the first time we see it complete, so links never rot.
 *
 * Vercel Blob when BLOB_READ_WRITE_TOKEN is present, local disk otherwise.
 *
 * Blobs are stored PRIVATE and streamed back through our own authenticated
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
/** The photo set an identity was trained from, zipped for the trainer. */
export const identityZipPath = (identityId: string) => `${prefix()}identities/${identityId}.zip`;
export const uploadPath = (uploadId: string, ext: string) => `${prefix()}uploads/${uploadId}.${ext}`;

const LOCAL_DIR = path.join(process.cwd(), ".data", "generations");
/* Platform assets (brief 1.4): the bank's neutral previews. No tenant prefix — every workspace reads them. */
const PLATFORM_DIR = path.join(process.cwd(), ".data", "platform");
export const platformPath = (file: string) => `platform/${file}`;

export async function storePlatformBytes(file: string, buf: Buffer, contentType: string): Promise<string> {
  if (!/^[A-Za-z0-9_\-:./]+$/.test(file) || file.includes("..")) throw new Error("bad platform path");
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(platformPath(file), buf, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true });
    return platformPath(file);
  }
  const full = path.join(PLATFORM_DIR, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf);
  return platformPath(file);
}

export async function readPlatformBytes(file: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_\-:./]+$/.test(file) || file.includes("..")) throw new Error("bad platform path");
  if (usingBlob()) return readBlob(platformPath(file));
  return readFile(path.join(PLATFORM_DIR, file));
}

export function usingBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
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
  /* Two minutes, and no less: a 200 MB master over a slow link legitimately
     needs it, and abandoning one early would strand the very render the cron
     exists to rescue. But not unbounded either — this runs 30-wide inside a
     300s cron, where one stalled download could own the whole window. */
  const buf = isFixtureUrl(sourceUrl) ? await fetchBytes(sourceUrl) : await download(sourceUrl);

  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(videoPath(genId), buf, {
      access: "private",
      contentType: "video/mp4",
      addRandomSuffix: false,
      // Saves are retried by every poll until they stick. Without this, a
      // partial first attempt leaves a blob behind and every retry then dies
      // on "blob already exists" — the video never records as saved.
      allowOverwrite: true,
    });
    // Always hand back our own route, never a storage URL.
    return { url: `/api/media/${genId}`, bytes: buf.length };
  }

  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.mp4`), buf);
  return { url: `/api/media/${genId}`, bytes: buf.length };
}

/** Reads a private blob back as bytes. */
async function readBlob(pathnameOrUrl: string): Promise<Buffer> {
  const { get } = await import("@vercel/blob");
  const found = await get(pathnameOrUrl, { access: "private" });
  if (!found?.stream) throw new Error("blob not found");
  const chunks: Uint8Array[] = [];
  // @ts-expect-error - web stream is async-iterable at runtime
  for await (const c of found.stream) chunks.push(c as Uint8Array);
  return Buffer.concat(chunks);
}

export async function readVideoBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingBlob()) return readBlob(videoPath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.mp4`));
}

/* ── Image renders (Nano Banana) — bytes arrive in the API response, not at
 * a downloadable URL, so they're stored directly. Same privacy rules. ── */

export async function storeImageBytes(genId: string, buf: Buffer): Promise<{ url: string; bytes: number }> {
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(imagePath(genId), buf, {
      access: "private",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { url: `/api/media/${genId}`, bytes: buf.length };
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.png`), buf);
  return { url: `/api/media/${genId}`, bytes: buf.length };
}

export async function readImageBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingBlob()) return readBlob(imagePath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.png`));
}

/* ── Audio renders (ElevenLabs) — MP3 bytes arrive in the response body. ── */

export async function storeAudioBytes(genId: string, buf: Buffer): Promise<{ url: string; bytes: number }> {
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(audioPath(genId), buf, {
      access: "private",
      contentType: "audio/mpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { url: `/api/media/${genId}`, bytes: buf.length };
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.mp3`), buf);
  return { url: `/api/media/${genId}`, bytes: buf.length };
}

export async function readAudioBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingBlob()) return readBlob(audioPath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.mp3`));
}

/**
 * The zip a trainer learns a face from. Private like everything else; the
 * trainer receives a signed link that expires, never the store. Returns the
 * store pathname (or the local file path in development).
 */
export async function storeIdentityZip(identityId: string, buf: Buffer): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(identityId)) throw new Error("bad id");
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(identityZipPath(identityId), buf, {
      access: "private",
      contentType: "application/zip",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return identityZipPath(identityId);
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  const local = path.join(LOCAL_DIR, `${identityId}.zip`);
  await writeFile(local, buf);
  return local;
}

/**
 * A render's bytes as a stream, for handing straight to a Response.
 *
 * Downloads used to load the whole file into the function first — fine for a
 * few megabytes, a memory cliff for a 30-second 1080p clip, and pure waste
 * when the bytes are only passing through.
 */
export async function openMediaStream(
  genId: string, kind: "video" | "image" | "audio"
): Promise<ReadableStream<Uint8Array>> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  const pathname = kind === "image" ? imagePath(genId) : kind === "audio" ? audioPath(genId) : videoPath(genId);
  if (usingBlob()) {
    const { get } = await import("@vercel/blob");
    const found = await get(pathname, { access: "private" });
    if (!found?.stream) throw new Error("blob not found");
    return found.stream as ReadableStream<Uint8Array>;
  }
  const { createReadStream } = await import("node:fs");
  const local = path.join(LOCAL_DIR, `${genId}.${kind === "image" ? "png" : kind === "audio" ? "mp3" : "mp4"}`);
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
  const { createHash } = await import("node:crypto");

  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(uploadPath(uploadId, ext), buf, {
      access: "private", contentType, addRandomSuffix: false, allowOverwrite: true,
    });
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
}

export async function readUploadBytes(uploadId: string, ext: string, storedUrl: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error("bad upload id");
  if (usingBlob()) {
    if (/^https?:\/\//.test(storedUrl)) {
      // Browser-direct upload. Public host segment → plain fetch;
      // anything else goes through the authorized private read.
      if (storedUrl.includes(".public.blob.vercel-storage.com/")) {
        const res = await fetch(storedUrl);
        if (!res.ok) throw new Error(`Could not read upload ${uploadId} (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      }
      return readBlob(storedUrl);
    }
    return readBlob(uploadPath(uploadId, ext));
  }
  return readFile(path.join(UPLOAD_DIR, `${uploadId}.${ext}`));
}

/** Best-effort removal of a render's stored file — video or image. */
export async function deleteVideo(genId: string, strict = false, storedUrl?: string | null): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) { if (strict) throw new Error("Invalid generation media identity"); return; }
  const targets = [videoPath(genId), imagePath(genId), audioPath(genId)];
  if (usingBlob() && storedUrl && /^https?:\/\//.test(storedUrl)) targets.push(storedUrl);
  for (const target of targets) {
    try {
      if (usingBlob()) {
        const { del } = await import("@vercel/blob");
        await del(target);
      } else {
        const { rm } = await import("node:fs/promises");
        await rm(path.join(LOCAL_DIR, path.basename(target)), { force: true });
      }
    } catch (error) { if (strict) throw error; }
  }
}

/** Best-effort removal of an upload's stored file (blob URL, pathname, or local). */
export async function deleteUpload(uploadId: string, ext: string, storedUrl: string, strict = false): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) return;
  try {
    if (usingBlob()) {
      const { del } = await import("@vercel/blob");
      // Browser-direct uploads carry a random suffix known only via stored_url.
      await del(/^https?:\/\//.test(storedUrl) ? storedUrl : uploadPath(uploadId, ext));
    } else {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(UPLOAD_DIR, `${uploadId}.${ext}`), { force: true });
    }
  } catch (error) { if (strict) throw error; }
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
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(chunkPath(sess, i), buf, {
      access: "private", contentType: "application/octet-stream",
      addRandomSuffix: false, allowOverwrite: true,
    });
    return;
  }
  await mkdir(path.join(CHUNK_DIR, prefix(), sess), { recursive: true });
  await writeFile(path.join(CHUNK_DIR, prefix(), sess, String(i)), buf);
}

export async function assembleChunks(sess: string, count: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      usingBlob()
        ? await readBlob(chunkPath(sess, i))
        : await readFile(path.join(CHUNK_DIR, prefix(), sess, String(i)))
    );
  }
  return Buffer.concat(parts);
}

export async function deleteChunks(sess: string, count: number, strict = false): Promise<void> {
  try {
    if (usingBlob()) {
      const { del } = await import("@vercel/blob");
      await del(Array.from({ length: count }, (_, i) => chunkPath(sess, i)));
    } else {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(CHUNK_DIR, prefix(), sess), { recursive: true, force: true });
    }
  } catch (error) { if (strict) throw error; }
}

/* ── Presigned reads ──────────────────────────────────────────────────────
 * ModelArk fetches reference media over plain HTTPS — reference videos ONLY
 * accept a URL (no base64). A presigned GET gives it a time-limited link to
 * a private object: nothing becomes public, the link just works for a while.
 * -------------------------------------------------------------------- */

export async function presignedReadUrl(pathname: string, hours = 24): Promise<string> {
  const { issueSignedToken, presignUrl } = await import("@vercel/blob");
  const validUntil = Date.now() + hours * 3600_000;
  const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await presignUrl(token, {
    operation: "get", pathname, access: "private", validUntil,
  });
  return presignedUrl;
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
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  let total = 0;
  let headChunk: Buffer | null = null;

  const pathnameFor = uploadPath(uploadId, ext);

  async function* chunks(): AsyncGenerator<Buffer> {
    for (let i = 0; i < count; i++) {
      const buf = usingBlob()
        ? await readBlob(chunkPath(sess, i))
        : await readFile(path.join(CHUNK_DIR, prefix(), sess, String(i)));
      if (i === 0) headChunk = buf;
      hash.update(buf);
      total += buf.length;
      if (total > maxBytes) throw new Error("Upload exceeds its reserved byte limit.");
      yield buf;
    }
  }

  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(pathnameFor, Readable.from(chunks()), {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      // The SDK splits the stream into parts itself — memory stays flat.
      multipart: true,
    });
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
}

/** Streams a stored upload out without buffering — a 2GB download must flow
 *  through the function, never sit in it. */
export async function openUploadStream(
  uploadId: string, ext: string, range?: ByteRange | null, storedUrl?: string, signal?: AbortSignal
): Promise<{ stream: ReadableStream; size: number | null }> {
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error("bad upload id");
  if (usingBlob()) {
    const { get } = await import("@vercel/blob");
    const target = storedUrl && /^https?:\/\//.test(storedUrl) ? storedUrl : uploadPath(uploadId, ext);
    const found = await get(target, { access: target.includes('.public.blob.vercel-storage.com/') ? 'public' : "private", abortSignal:signal, ...(range?{headers:{Range:`bytes=${range.start}-${range.end}`}}:{}) });
    if (!found?.stream) throw new Error("blob not found");
    if(range && found.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${range.total}`){await found.stream.cancel().catch(()=>{});throw new Error('Storage did not honor the requested media range');}
    return { stream: found.stream as ReadableStream, size: found.blob?.size ?? null };
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
