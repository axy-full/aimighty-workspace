import { engineMock } from "@/lib/mock";
import type { WorkerOpened, WorkerPage } from "./shapes";

/**
 * The reader the lane calls, page by page: open a file, then ask for each page in turn. The Docling worker and its client
 * (ops/docling-worker, docs/reading-lane-plan.md Step 2) come in their own PR; until then the only reader is the mock, under
 * ENGINE_MOCK=1, and anywhere else the lane answers that reading is not available, with nothing billed.
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

/** The reader for this process: the mock under ENGINE_MOCK=1, else none yet. */
export function workerFor(): ReadingWorker | null {
  return engineMock() ? mockWorker() : null;
}
