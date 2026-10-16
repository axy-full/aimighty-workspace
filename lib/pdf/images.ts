import { db, ready } from "../db";
import { mayReadTake } from "../draftProject";
import { openMediaStream, openUploadStream } from "../storage";
import { uploadOpenableBy } from "../uploadAccess";
import { PDF_LIMITS, imageKindOf } from "../../remotion/src/lib/pdf";
import { PdfError, type DeckRequest } from "./contract";
import type { BoundPicture } from "./builders";

/**
 * The pictures of a deck: handles in the request, files in the worker.
 *
 * A request names a picture by handle (`{ "upload": id }` or `{ "take": id }`), never by path or address. Each handle is resolved
 * inside the caller's own workspace (the tenant database is the boundary: an id from another workspace is simply not found), and
 * the caller's own reach decides the rest, as for an export: an upload opens for its uploader or once shared work holds it
 * (lib/uploadAccess.ts); a take is readable by whoever may read its board (lib/draftProject.ts). Anything the caller cannot reach
 * answers exactly as an id that does not exist. What goes to the worker is what the bytes are (PNG, JPEG or WebP), not what a record says.
 */
export type Viewer = { id: string; role?: string };
export type Picture = { name: string; bytes: Buffer };

export type PictureSource = {
  /** The bytes of one handle, or a PdfError saying why not. */
  load(handle: { upload?: string; take?: string }, viewer: Viewer, limit: number): Promise<Buffer>;
};

const gone = (what: string) => new PdfError(`${what} isn't available in this workspace.`, 404);

async function read(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new PdfError("A picture is larger than 20 MB, which is the most a deck takes.", 413);
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export const workspacePictures: PictureSource = {
  async load(handle, viewer, limit) {
    await ready();
    if (handle.take) {
      const row = (await db().execute({ sql: "SELECT id,kind,status,project_id FROM generations WHERE id=? AND deleted=0", args: [handle.take] })).rows[0];
      if (!row || row.kind !== "image" || !(await mayReadTake(viewer, row.project_id == null ? null : String(row.project_id)))) throw gone("That take");
      if (row.status === "queued" || row.status === "running") throw new PdfError("That take is still being made. Use it when it is ready.", 409);
      if (row.status !== "succeeded") throw gone("That take");
      return read(await openMediaStream(String(row.id), "image"), limit);
    }
    const row = (await db().execute({ sql: "SELECT id,ext,stored_url,bytes FROM uploads WHERE id=?", args: [handle.upload!] })).rows[0];
    if (!row || !(await uploadOpenableBy(handle.upload!, viewer))) throw gone("That upload");
    if (Number(row.bytes) > limit) throw new PdfError("A picture is larger than 20 MB, which is the most a deck takes.", 413);
    const opened = await openUploadStream(String(row.id), String(row.ext), null, String(row.stored_url));
    return read(opened.stream as ReadableStream<Uint8Array>, limit);
  },
};

/** Bind a request's logo and pictures to files named i1.png, i2.jpg …: what the pages refer to and the worker is sent. */
export async function bindPictures(
  request: Pick<DeckRequest, "images" | "logo">,
  viewer: Viewer,
  source: PictureSource = workspacePictures,
): Promise<{ files: Picture[]; logo: string | null; pictures: BoundPicture[] }> {
  const files: Picture[] = [];
  let total = 0;
  const bind = async (handle: { upload?: string; take?: string }): Promise<string> => {
    const bytes = await source.load(handle, viewer, PDF_LIMITS.imageBytes);
    total += bytes.length;
    if (total > PDF_LIMITS.imagesTotalBytes) throw new PdfError("The pictures together are larger than 120 MB, which is the most a deck takes.", 413);
    const kind = imageKindOf(bytes.subarray(0, 16));
    if (!kind) throw new PdfError("A picture must be a PNG, JPEG or WebP image.", 415);
    const name = `i${files.length + 1}.${kind}`;
    files.push({ name, bytes });
    return name;
  };
  const logo = request.logo ? await bind({ upload: request.logo.upload }) : null;
  const pictures: BoundPicture[] = [];
  for (const item of request.images ?? []) pictures.push({ file: await bind({ upload: item.upload, take: item.take }), caption: item.caption ?? "" });
  return { files, logo, pictures };
}
