import { z } from "zod";

/**
 * Every shape the reading lane passes, checked with Zod at each edge (docs/reading-lane-plan.md, Step 2; the tables' columns in
 * docs/reading-tables-schema.md). A block's box is fractions of its page, origin top-left (decision 1); a block's text is at most
 * MAX_BLOCK_TEXT characters, longer text split into parts, never cut (decision 2); a file without pages is page 1, the whole page,
 * geometry "none" (decision 3).
 */

export const MAX_BLOCK_TEXT = 4000;
/** The largest upload there is (lib/uploadReservations.ts: 2 GiB); a larger one is never read. */
export const MAX_READ_BYTES = 2 * 1024 ** 3;

export const BLOCK_KINDS = [
  "title", "heading", "paragraph", "list_item", "table", "caption", "footnote", "page_header", "page_footer", "picture", "formula", "code", "other",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const ERROR_CODES = ["worker_unavailable", "timeout", "too_large", "encrypted", "unreadable", "bad_block"] as const;
export type ReadingErrorCode = (typeof ERROR_CODES)[number];

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const unit = z.number().finite().min(0).max(1);
const box = { x0: unit, y0: unit, x1: unit, y1: unit };
const ordered = (b: { x0: number; y0: number; x1: number; y1: number }) => b.x0 <= b.x1 && b.y0 <= b.y1;

/** What the tool takes, from any caller (rule 11): the upload, and the project it was asked from, which is a record only (decision 7). */
export const readDocumentInput = z.object({ uploadId: z.string().regex(ID), projectId: z.string().regex(ID).optional() }).strict();
export type ReadDocumentInput = z.infer<typeof readDocumentInput>;

/** The worker's answer to opening a file: how many pages, whether they have geometry, and its version. */
export const workerOpened = z.object({
  pages: z.number().int().min(1),
  geometry: z.enum(["page", "none"]),
  readerVersion: z.string().min(1).max(80),
}).strict();
export type WorkerOpened = z.infer<typeof workerOpened>;

/** One block as the worker gives it: its text may be long; the lane splits it. */
export const workerBlock = z.object({ kind: z.enum(BLOCK_KINDS), ...box, text: z.string().max(1_000_000), confidence: unit.nullable() }).strict().refine(ordered);
/** One page as the worker gives it. */
export const workerPage = z.object({ page: z.number().int().min(1), blocks: z.array(workerBlock).max(5000) }).strict();
export type WorkerPage = z.infer<typeof workerPage>;

/** One stored block (document_blocks): reading order `seq` across the reading, `part` within a split block. */
export const readingBlock = z.object({
  page: z.number().int().min(1),
  seq: z.number().int().min(0),
  part: z.number().int().min(0),
  kind: z.enum(BLOCK_KINDS),
  ...box,
  text: z.string().max(MAX_BLOCK_TEXT),
  confidence: unit.nullable(),
}).strict().refine(ordered);
export type ReadingBlock = z.infer<typeof readingBlock>;

/** What the tool answers. Never the file's text in an error; a code only. */
export const readDocumentOutput = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("done"),
    pages: z.number().int().min(1),
    geometry: z.enum(["page", "none"]),
    readerVersion: z.string(),
    blocks: z.array(readingBlock),
    /* False until the reading tables' migration is in: the store is stubbed, so nothing is kept. */
    stored: z.boolean(),
  }).strict(),
  z.object({ state: z.literal("failed"), errorCode: z.enum(ERROR_CODES), message: z.string() }).strict(),
  z.object({ state: z.literal("off"), message: z.string() }).strict(),
]);
export type ReadDocumentOutput = z.infer<typeof readDocumentOutput>;
