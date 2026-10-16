import { Zip, ZipPassThrough } from "fflate";
import { db } from "../db";
import { openUploadStream } from "../storage";
import { ExportError, type ExportJob } from "./contract";
import { getExport, type ExportDeps } from "./jobs";

/**
 * Download all: the files of one ready export (its video and its subtitle files) as one .zip, streamed. Nothing is
 * held: each file is read from storage chunk by chunk into the archive, which is written out as it grows, and is stored
 * (not compressed: a video does not shrink). Only the export's owner can ask (the same rule as reading the export), and
 * only the files that export made are in it.
 *
 * ZIP64 is not used, so the archive must stay under 4 GB: a ProRes export is at most about 1.4 GB, and a request that
 * would pass the limit is refused rather than written wrong.
 */
export const ZIP_LIMIT_BYTES = 3.5 * 1024 * 1024 * 1024;

/** A file of the archive, already OPENED: the stream is read from storage, never opened later from inside the response. */
export type ZipEntry = { name: string; bytes: number; stream: ReadableStream<Uint8Array> };

/** A zip of the entries, written to the stream as it is read: one entry at a time, one chunk at a time, honouring back-pressure. A cancel closes every file that is still open. */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  let archive: Zip | null = null;
  let index = -1;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let file: ZipPassThrough | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      archive = new Zip((error, chunk, final) => {
        if (error) { controller.error(error); return; }
        if (chunk.byteLength) controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    async pull() {
      if (!archive) return;
      for (;;) {
        if (!reader) {
          index += 1;
          if (index >= entries.length) { archive.end(); archive = null; return; }
          file = new ZipPassThrough(entries[index].name);
          archive.add(file);
          reader = entries[index].stream.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          file!.push(new Uint8Array(0), true);
          reader = null;
          file = null;
          continue;
        }
        /* An empty chunk adds nothing to the archive and so would leave this pull without output: read on instead of stalling. */
        if (value.byteLength === 0) continue;
        file!.push(value, false);
        return; // one chunk per pull: the consumer's pace decides the next
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => {});
      /* Every file not yet read is already open: let go of them all. */
      for (const entry of entries.slice(index + 1)) await entry.stream.cancel().catch(() => {});
      archive = null;
    },
  });
}

export type ExportZip = { filename: string; bytes: number; stream: ReadableStream<Uint8Array> };

export type ZipOptions = {
  /** Opens one stored file as a stream; the real one is the storage's (a test may substitute it). */
  open?: (uploadId: string, ext: string, storedUrl: string | undefined) => Promise<ReadableStream<Uint8Array>>;
};

const openStored: NonNullable<ZipOptions["open"]> = async (uploadId, ext, storedUrl) => (await openUploadStream(uploadId, ext, null, storedUrl)).stream as ReadableStream<Uint8Array>;
const GONE = "A file of that export is not available any more.";

/**
 * The zip of a ready export, for its owner. 404 for an export that is not theirs or not there, or one of whose files is gone; 409
 * until it is ready. **Every file is opened here, before the response exists**, while the workspace is still in scope (the response
 * body is read later, outside it, so a file opened then would lose the workspace's key check and its path prefix), and a file that
 * is missing from storage is a clean 404, not a 200 that stops half way.
 */
export async function exportZip(owner: string, id: string, deps: ExportDeps = {}, options: ZipOptions = {}): Promise<ExportZip> {
  const job: ExportJob = await getExport(owner, id, deps);
  if (job.status !== "ready") throw new ExportError("That export is not ready yet.", 409);
  if (!job.outputs.length) throw new ExportError("That export has no files.", 404);
  const rows: { name: string; uploadId: string; ext: string; stored: string | undefined; bytes: number }[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const output of job.outputs) {
    const row = (await db().execute({ sql: "SELECT ext, stored_url, bytes FROM uploads WHERE id=?", args: [output.uploadId] })).rows[0];
    if (!row) throw new ExportError(GONE, 404);
    /* A size that is empty or not a whole, non-negative number would slip past the limit below (as NaN, or as 0): refuse it. */
    const bytes = Number(row.bytes);
    if (row.bytes == null || String(row.bytes).trim() === "" || !Number.isSafeInteger(bytes) || bytes < 0) throw new ExportError(GONE, 404);
    total += bytes;
    // A name once only: a second file with the same name is numbered, never overwritten.
    let name = output.filename;
    for (let n = 2; seen.has(name); n += 1) name = output.filename.replace(/(\.[^.]+)?$/, `-${n}$1`);
    seen.add(name);
    rows.push({ name, uploadId: output.uploadId, ext: String(row.ext), stored: row.stored_url == null ? undefined : String(row.stored_url), bytes });
  }
  if (total > ZIP_LIMIT_BYTES) throw new ExportError("That export is too large to download as one zip. Download its files one by one.", 413);
  const open = options.open ?? openStored;
  const entries: ZipEntry[] = [];
  try {
    for (const row of rows) entries.push({ name: row.name, bytes: row.bytes, stream: await open(row.uploadId, row.ext, row.stored) });
  } catch {
    for (const entry of entries) await entry.stream.cancel().catch(() => {});
    throw new ExportError(GONE, 404);
  }
  return { filename: `export-${id.slice(7, 15)}.zip`, bytes: total, stream: zipStream(entries) };
}
