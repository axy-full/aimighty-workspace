import { db, ready } from "@/lib/db";
import { engineMock } from "@/lib/mock";
import { presignedReadUrl, uploadPath } from "@/lib/storage";
import { doclingConfig, doclingWorker } from "./doclingClient";
import type { WorkerOpened, WorkerPage } from "./shapes";

/**
 * The reader the lane calls, page by page: open a file, then ask for each page in turn. Under ENGINE_MOCK=1 it is the mock;
 * elsewhere the Docling worker when `DOCLING_WORKER_URL` and its secret are set (lib/reading/doclingClient.ts); otherwise none,
 * and the lane answers that reading is not available, with nothing billed. The worker itself is its own PR (ops/docling-worker).
 */
export type ReadingWorker = {
  open(file: { uploadId: string; sha256: string; mime: string; bytes: number }, signal: AbortSignal): Promise<WorkerOpened>;
  page(n: number, signal: AbortSignal): Promise<WorkerPage>;
};

/** A mock reader: two synthetic pages for a paged file, one page without geometry for anything else. Reads no byte. */
export function mockWorker(): ReadingWorker {
  let paged = true;
  return {
    async open(file) {
      paged = file.mime === "application/pdf";
      return { pages: paged ? 2 : 1, geometry: paged ? "page" : "none", readerVersion: "mock-1" };
    },
    async page(n) {
      if (!paged) return { page: 1, blocks: [{ kind: "paragraph", x0: 0, y0: 0, x1: 1, y1: 1, text: "Synthetic text.", confidence: null }] };
      return {
        page: n,
        blocks: [
          { kind: "heading", x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.1, text: `Synthetic page ${n}`, confidence: null },
          { kind: "paragraph", x0: 0.1, y0: 0.15, x1: 0.9, y1: 0.6, text: "Synthetic paragraph.", confidence: 0.98 },
        ],
      };
    },
  };
}

/**
 * The signed URL the worker fetches an upload from: the workspace's own object (the current tenant's database and storage
 * prefix), short-lived. Only called after the lane has checked the caller may open the upload.
 */
async function uploadUrl(file: { uploadId: string }): Promise<string> {
  await ready();
  const row = (await db().execute({ sql: "SELECT ext, stored_url FROM uploads WHERE id = ? LIMIT 1", args: [file.uploadId] })).rows[0];
  if (!row) throw new Error("no such upload");
  return presignedReadUrl(uploadPath(file.uploadId, String(row.ext)), 0.25, row.stored_url == null ? null : String(row.stored_url));
}

/** The reader for this process: the mock under ENGINE_MOCK=1, else the Docling worker when it is set up, else none. */
export function workerFor(env: Readonly<Record<string, string | undefined>> = process.env): ReadingWorker | null {
  if (engineMock()) return mockWorker();
  const config = doclingConfig(env);
  return config ? doclingWorker(config, { fileUrl: uploadUrl }) : null;
}
