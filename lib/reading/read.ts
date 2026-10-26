import { db, ready } from "@/lib/db";
import { engineEnabled } from "@/lib/engineGate";
import { READING } from "@/lib/copy";
import { currentTenant } from "@/lib/tenant";
import { isAgentId } from "@/lib/security/people-only";
import { uploadOpenableBy } from "@/lib/uploadAccess";
import { within } from "@/lib/abortWithin";
import {
  MAX_READ_BYTES, readDocumentInput, readDocumentOutput, readingBlock, workerOpened, workerPage,
  type ReadDocumentOutput, type ReadingBlock, type ReadingErrorCode,
} from "./shapes";
import { splitText } from "./split";
import { stubStore, type ReadingStore } from "./store";
import { workerFor, type ReadingWorker } from "./worker";
import { DoclingError } from "./doclingClient";

/**
 * `read_document`: a brief (any upload) read page by page into blocks with a page and a box (docs/reading-lane-plan.md, Step 2;
 * SOW v2 §9, §10 and Part II.1, cited only). Rule 11: the button, Atomik and an outside agent call this same tool. Off unless
 * `DOCLING_ENABLED` is exactly "1" for the workspace (lib/engineGate.ts); off, it answers so and reads nothing. Mock reader only
 * until the Docling worker's PR; no price yet (the Reading quote is its own money PR), so nothing here bills. The reading tables
 * wait for their migration, so the store is a stub and the answer says `stored: false`.
 *
 * Tenancy (rule 2): the upload is read from the workspace's own database, and only when the caller may open it; an upload they
 * may not open, or one that does not exist, is answered alike. An Atomik run reads as the person it acts for, never as itself.
 * No error, and nothing logged, carries the file's text.
 */
export const READ_DOCUMENT_TOOL = {
  id: "read_document",
  kind: "app" as const,
  provider: null,
  needs: ["DOCLING_ENABLED"] as string[],
  /* No route or MCP entry yet: they read and write through the store, which waits for the tables (R2). */
  route: null,
  inputs: { uploadId: "the upload to read (an id from the Library)", projectId: "optional: the project it was asked from; a record only" },
  price: { quote: "none yet: the Reading quote by page is its own money PR; while this is off, nothing is read or billed" },
  who: "any caller who may open the upload; an Atomik run reads as the person it acts for" as const,
};

export class ReadingError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) { super(message); this.name = "ReadingError"; }
}

/** How long one page may take before the reading fails with `timeout` (the lead's figure, a bound only; no page cap: 2 GiB is the ceiling). */
export const PAGE_MS = 120_000;

export type ReadDeps = {
  worker?: ReadingWorker | null;
  store?: ReadingStore;
  pageMs?: number;
  /** For an Atomik run: the person it acts for, from the run's own record, never from the model. */
  forPerson?: string;
};

const failed = (errorCode: ReadingErrorCode): ReadDocumentOutput =>
  ({ state: "failed", errorCode, message: errorCode === "worker_unavailable" ? READING.unavailable : errorCode === "too_large" ? READING.tooLarge : errorCode === "encrypted" ? READING.encrypted : READING.unreadable });

/* A worker call that ends when its signal does, whatever the worker does with the signal. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("timeout", "TimeoutError"));
    const stop = () => reject(new DOMException("timeout", "TimeoutError"));
    signal.addEventListener("abort", stop, { once: true });
    work.then((v) => { signal.removeEventListener("abort", stop); resolve(v); }, (e) => { signal.removeEventListener("abort", stop); reject(e); });
  });
}

export async function readDocument(raw: unknown, deps: ReadDeps = {}): Promise<ReadDocumentOutput> {
  const parsed = readDocumentInput.safeParse(raw);
  if (!parsed.success) throw new ReadingError(400, READING.badInput);
  const { uploadId, projectId } = parsed.data;
  const store = currentTenant();
  const user = store?.user;
  if (!store?.workspace || !user || user.disabled) throw new ReadingError(403, READING.noCaller);
  const viewerId = isAgentId(user.id) ? deps.forPerson : user.id;
  if (!viewerId || isAgentId(viewerId)) throw new ReadingError(403, READING.noCaller);

  if (!(await engineEnabled("DOCLING_ENABLED", store.workspace))) return { state: "off", message: READING.off };

  await ready();
  const row = (await db().execute({ sql: "SELECT sha256, mime, bytes FROM uploads WHERE id = ? LIMIT 1", args: [uploadId] })).rows[0];
  if (!row || !(await uploadOpenableBy(uploadId, { id: viewerId }))) throw new ReadingError(404, READING.noSuch);
  const file = { uploadId, sha256: String(row.sha256), mime: String(row.mime), bytes: Number(row.bytes) };
  if (!Number.isFinite(file.bytes) || file.bytes > MAX_READ_BYTES) return failed("too_large");

  const worker = deps.worker === undefined ? workerFor() : deps.worker;
  if (!worker) return failed("worker_unavailable");
  const keep = deps.store ?? stubStore;
  const pageMs = deps.pageMs ?? PAGE_MS;

  let readingId: string | null = null;
  const end = async (code: ReadingErrorCode) => { await keep.finish(readingId, { ok: false, errorCode: code }); return failed(code); };
  const codeOf = (error: unknown): ReadingErrorCode =>
    error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : error instanceof DoclingError ? error.code : "unreadable";

  let opened;
  try {
    const signal = within(pageMs);
    opened = workerOpened.safeParse(await bounded(worker.open(file, signal), signal));
  } catch (error) {
    return failed(codeOf(error));
  }
  if (!opened.success) return failed("bad_block");
  const { pages, geometry, readerVersion } = opened.data;
  readingId = await keep.begin({ uploadId, sha256: file.sha256, projectId: projectId ?? null, askedBy: user.id, pages, geometry, readerVersion });

  const blocks: ReadingBlock[] = [];
  for (let n = 1; n <= pages; n++) {
    let page;
    try {
      const signal = within(pageMs);
      page = workerPage.safeParse(await bounded(worker.page(n, signal), signal));
    } catch (error) {
      return end(codeOf(error));
    }
    /* A page that is not the one asked, or a block outside its page, is a bad block: nothing of it is kept. */
    if (!page.success || page.data.page !== n) return end("bad_block");
    const these: ReadingBlock[] = [];
    for (const b of page.data.blocks) {
      /* A file without pages is page 1, the whole page (decision 3). */
      const where = geometry === "none" ? { x0: 0, y0: 0, x1: 1, y1: 1 } : { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
      splitText(b.text).forEach((text, part) => {
        these.push(readingBlock.parse({ page: n, seq: blocks.length + these.length, part, kind: b.kind, ...where, text, confidence: b.confidence }));
      });
    }
    await keep.addPage(readingId, these);
    blocks.push(...these);
  }
  await keep.finish(readingId, { ok: true });
  return readDocumentOutput.parse({ state: "done", pages, geometry, readerVersion, blocks, stored: keep.keeps });
}
