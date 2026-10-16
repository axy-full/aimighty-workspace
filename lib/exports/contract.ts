import { z } from "zod";
import type { CompositionId } from "../../remotion/src/lib/types";

/**
 * The export tool's public shapes (the route, MCP and the tests all read these).
 *
 * An export turns media a workspace already holds (takes and uploads) into a finished file with our own Remotion
 * templates: captions on a cut, title and end cards, 16:9 and 9:16 versions, 6/15/30 s cutdowns, the final MP4. It is
 * FREE to customers (0 cr, "Free") for as long as Remotion costs us nothing; the owner sets any future price, and code
 * never adds one. Nothing in this file or its neighbours reserves, charges or refunds credits.
 */

/** The templates a request may name. `fixture-clip` is for tests and timing only and is never offered. */
export const EXPORT_COMPOSITIONS = ["captions", "title-card", "end-card", "reframe", "cutdown", "final"] as const satisfies readonly CompositionId[];
export type ExportComposition = (typeof EXPORT_COMPOSITIONS)[number];

export const EXPORT_STATUSES = ["queued", "rendering", "saving", "ready", "failed", "cancelled"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const EXPORT_TERMINAL: readonly ExportStatus[] = ["ready", "failed", "cancelled"];
export const isTerminal = (status: string) => (EXPORT_TERMINAL as readonly string[]).includes(status);

/** What every export costs the customer. */
export const EXPORT_PRICE_LABEL = "Free";
export const NOTHING_BILLED = "Nothing billed.";

export type ExportOutput = {
  kind: "video" | "still";
  uploadId: string;
  /** Served by the workspace's own upload route, so the same access rules apply. */
  url: string;
  filename: string;
  mime: string;
  bytes: number;
  frame?: number;
};

export type ExportJob = {
  id: string;
  requestId: string;
  composition: ExportComposition;
  status: ExportStatus;
  /** Exports ahead of this one while it is queued (running anywhere, and this workspace's earlier queued ones); null otherwise. */
  ahead: number | null;
  /** The line a screen shows for the queue: "Export queued — 2 ahead of you". Null unless queued. */
  queueLine: string | null;
  createdAt: number;
  updatedAt: number;
  /** Why it failed or was ended; says "Nothing billed." when it did not complete. */
  error: string | null;
  price: { credits: 0; label: typeof EXPORT_PRICE_LABEL };
  outputs: ExportOutput[];
};

/**
 * A request. `props` are the template's props with every media file named by a handle instead of a path:
 * `{ "upload": "<upload id>" }` or `{ "take": "<take id>" }` (a clip may add `"hasAudio": true`, to use its sound).
 * The server resolves each handle inside the caller's own workspace, fills in each file's length and size, and checks
 * the result against the template's own rules (remotion/src/lib/validate.ts) before anything is stored.
 */
export const exportRequestSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    composition: z.enum(EXPORT_COMPOSITIONS),
    props: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export class ExportError extends Error {
  constructor(message: string, public status = 400, public retryAfterSeconds?: number) {
    super(message);
    this.name = "ExportError";
  }
}
