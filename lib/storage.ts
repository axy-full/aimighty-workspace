import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

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

/** Deterministic blob paths, so a row id is enough to find the object. */
export const videoPath  = (genId: string) => `generations/${genId}.mp4`;
export const imagePath  = (genId: string) => `generations/${genId}.jpg`;
export const uploadPath = (uploadId: string, ext: string) => `uploads/${uploadId}.${ext}`;

const LOCAL_DIR = path.join(process.cwd(), ".data", "generations");

export function usingBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function storeVideo(genId: string, sourceUrl: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not download render (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

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
    return `/api/media/${genId}`;
  }

  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.mp4`), buf);
  return `/api/media/${genId}`;
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

export async function storeImageBytes(genId: string, buf: Buffer): Promise<string> {
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(imagePath(genId), buf, {
      access: "private",
      contentType: "image/jpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return `/api/media/${genId}`;
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.jpg`), buf);
  return `/api/media/${genId}`;
}

export async function readImageBytes(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
  if (usingBlob()) return readBlob(imagePath(genId));
  return readFile(path.join(LOCAL_DIR, `${genId}.jpg`));
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
export async function deleteVideo(genId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) return;
  for (const target of [videoPath(genId), imagePath(genId)]) {
    try {
      if (usingBlob()) {
        const { del } = await import("@vercel/blob");
        await del(target);
      } else {
        const { rm } = await import("node:fs/promises");
        await rm(path.join(LOCAL_DIR, path.basename(target)), { force: true });
      }
    } catch { /* orphan cleanup is best-effort */ }
  }
}

/** Best-effort removal of an upload's stored file (blob URL, pathname, or local). */
export async function deleteUpload(uploadId: string, ext: string, storedUrl: string): Promise<void> {
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
  } catch { /* best-effort */ }
}

/* ── Chunked uploads ──────────────────────────────────────────────────────
 * Vercel caps a request body at 4.5MB, but reference media runs to 30MB
 * (images) or 200MB (videos). The browser slices the file and posts each
 * chunk through our authed route; finish() reassembles them server-side and
 * writes ONE final private object. Bytes are never transformed.
 * -------------------------------------------------------------------- */

const CHUNK_DIR = path.join(process.cwd(), ".data", "chunks");
const chunkPath = (sess: string, i: number) => `chunks/${sess}/${i}`;

export async function storeChunk(sess: string, i: number, buf: Buffer): Promise<void> {
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(chunkPath(sess, i), buf, {
      access: "private", contentType: "application/octet-stream",
      addRandomSuffix: false, allowOverwrite: true,
    });
    return;
  }
  await mkdir(path.join(CHUNK_DIR, sess), { recursive: true });
  await writeFile(path.join(CHUNK_DIR, sess, String(i)), buf);
}

export async function assembleChunks(sess: string, count: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      usingBlob()
        ? await readBlob(chunkPath(sess, i))
        : await readFile(path.join(CHUNK_DIR, sess, String(i)))
    );
  }
  return Buffer.concat(parts);
}

export async function deleteChunks(sess: string, count: number): Promise<void> {
  try {
    if (usingBlob()) {
      const { del } = await import("@vercel/blob");
      await del(Array.from({ length: count }, (_, i) => chunkPath(sess, i)));
    } else {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(CHUNK_DIR, sess), { recursive: true, force: true });
    }
  } catch { /* best-effort */ }
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
  sess: string, count: number, uploadId: string, ext: string, contentType: string
): Promise<{ sha256: string; bytes: number; headChunk: Buffer }> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  let total = 0;
  let headChunk: Buffer | null = null;

  const pathnameFor = uploadPath(uploadId, ext);

  async function* chunks(): AsyncGenerator<Buffer> {
    for (let i = 0; i < count; i++) {
      const buf = usingBlob()
        ? await readBlob(`chunks/${sess}/${i}`)
        : await readFile(path.join(CHUNK_DIR, sess, String(i)));
      if (i === 0) headChunk = buf;
      hash.update(buf);
      total += buf.length;
      yield buf;
    }
  }

  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    const { Readable } = await import("node:stream");
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
    const { Readable } = await import("node:stream");
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
  uploadId: string, ext: string
): Promise<{ stream: ReadableStream; size: number | null }> {
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error("bad upload id");
  if (usingBlob()) {
    const { get } = await import("@vercel/blob");
    const found = await get(uploadPath(uploadId, ext), { access: "private" });
    if (!found?.stream) throw new Error("blob not found");
    return { stream: found.stream as ReadableStream, size: found.blob?.size ?? null };
  }
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  const file = path.join(UPLOAD_DIR, `${uploadId}.${ext}`);
  const st = await stat(file);
  const { Readable } = await import("node:stream");
  return {
    stream: Readable.toWeb(createReadStream(file)) as ReadableStream,
    size: st.size,
  };
}
