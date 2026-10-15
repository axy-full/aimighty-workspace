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

export type ZipEntry = { name: string; bytes: number; open: () => Promise<ReadableStream<Uint8Array>> };

/** A zip of the entries, written to the stream as it is read: one entry at a time, one chunk at a time, honouring back-pressure. */
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
          reader = (await entries[index].open()).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          file!.push(new Uint8Array(0), true);
          reader = null;
          file = null;
          continue;
        }
        file!.push(value, false);
        return; // one chunk per pull: the consumer's pace decides the next
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => {});
      archive = null;
    },
  });
}

export type ExportZip = { filename: string; bytes: number; stream: ReadableStream<Uint8Array> };

/** The zip of a ready export, for its owner. 404 for an export that is not theirs or not there; 409 until it is ready. */
export async function exportZip(owner: string, id: string, deps: ExportDeps = {}): Promise<ExportZip> {
  const job: ExportJob = await getExport(owner, id, deps);
  if (job.status !== "ready") throw new ExportError("That export is not ready yet.", 409);
  if (!job.outputs.length) throw new ExportError("That export has no files.", 404);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const output of job.outputs) {
    const row = (await db().execute({ sql: "SELECT ext, stored_url, bytes FROM uploads WHERE id=?", args: [output.uploadId] })).rows[0];
    if (!row) throw new ExportError("A file of that export is not available any more.", 404);
    const bytes = Number(row.bytes);
    total += bytes;
    // A name once only: a second file with the same name is numbered, never overwritten.
    let name = output.filename;
    for (let n = 2; seen.has(name); n += 1) name = output.filename.replace(/(\.[^.]+)?$/, `-${n}$1`);
    seen.add(name);
    const ext = String(row.ext);
    const stored = row.stored_url == null ? undefined : String(row.stored_url);
    entries.push({ name, bytes, open: async () => (await openUploadStream(output.uploadId, ext, null, stored)).stream as ReadableStream<Uint8Array> });
  }
  if (total > ZIP_LIMIT_BYTES) throw new ExportError("That export is too large to download as one zip. Download its files one by one.", 413);
  return { filename: `export-${id.slice(7, 15)}.zip`, bytes: total, stream: zipStream(entries) };
}
