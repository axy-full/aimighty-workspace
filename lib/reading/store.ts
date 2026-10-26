import type { ReadingBlock, ReadingErrorCode } from "./shapes";

/**
 * Where a reading is kept: document_readings and document_blocks (docs/reading-tables-schema.md). Their migration (R1) waits for
 * the owner's yes after his backup, so until it is in, every write here is a stub: nothing is written, and the tool says so
 * (`stored: false`). R1 replaces `stubStore` with the real store behind the same shape; nothing else changes.
 */
export type ReadingMeta = {
  uploadId: string; sha256: string; projectId: string | null; askedBy: string;
  pages: number; geometry: "page" | "none"; readerVersion: string;
};

export type ReadingStore = {
  /** Whether this store keeps anything. */
  readonly keeps: boolean;
  begin(meta: ReadingMeta): Promise<string | null>;
  addPage(readingId: string | null, blocks: readonly ReadingBlock[]): Promise<void>;
  finish(readingId: string | null, outcome: { ok: true } | { ok: false; errorCode: ReadingErrorCode }): Promise<void>;
};

/** Until the migration: writes nothing. */
export const stubStore: ReadingStore = {
  keeps: false,
  async begin() { return null; },
  async addPage() {},
  async finish() {},
};
