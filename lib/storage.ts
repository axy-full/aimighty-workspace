import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Ark's video_url expires (~24h). We copy every finished render into our own
 * storage the first time we see it complete, so links never rot.
 *
 * Vercel Blob when BLOB_READ_WRITE_TOKEN is present, local disk otherwise.
 */

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
    const blob = await put(`generations/${genId}.mp4`, buf, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });
    return blob.url;
  }

  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, `${genId}.mp4`), buf);
  return `/api/media/${genId}`;
}

export async function readLocalVideo(genId: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(genId)) throw new Error("bad id");
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
    const blob = await put(`uploads/${uploadId}.${ext}`, buf, {
      access: "public", contentType, addRandomSuffix: false,
    });
    return { url: blob.url, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const file = path.join(UPLOAD_DIR, `${uploadId}.${ext}`);
  await writeFile(file, buf);

  // Hash what actually landed on disk, not what we held in memory.
  const written = await readFile(file);
  return { url: `/api/uploads/${uploadId}`, sha256: createHash("sha256").update(written).digest("hex") };
}

export async function readUploadBytes(uploadId: string, ext: string, storedUrl: string): Promise<Buffer> {
  if (usingBlob() || /^https?:\/\//.test(storedUrl)) {
    const res = await fetch(storedUrl);
    if (!res.ok) throw new Error(`Could not read upload ${uploadId} (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error("bad upload id");
  return readFile(path.join(UPLOAD_DIR, `${uploadId}.${ext}`));
}
