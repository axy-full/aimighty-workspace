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
      access: "private", contentType, addRandomSuffix: false,
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
