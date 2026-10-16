import { z } from "zod";
import { BLEEDS, DECK_KINDS, MAX_IMAGES, PAGE_SIZES, TEXT_MAX } from "./deck";

/**
 * The deck PDF tool's public shapes (the route, MCP and the tests all read these). A deck PDF turns what a workspace already
 * holds (a treatment, a board, or the words an agent writes for a pitch) into a PDF with our own templates. It is FREE to
 * customers (0 cr, "Free"); nothing in this folder reserves, charges or refunds credits. A paid step a deck depends on
 * (a picture to be made first) is its own tool, priced and approved on its own path before the deck is asked for.
 */
export const PDF_PRICE = Object.freeze({ credits: 0, label: "Free" as const });
export const NOTHING_BILLED = "Nothing billed.";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
/** A picture is named by handle, never by path or address: one of the workspace's own uploads, or one of its own still takes. */
const handle = z
  .object({ upload: id.optional(), take: id.optional(), caption: z.string().max(120).optional() })
  .strict()
  .refine((value) => [value.upload, value.take].filter((x) => x !== undefined).length === 1, { message: 'Name exactly one of "upload" or "take".' });
const text = z.string().max(TEXT_MAX);

const section = z
  .object({ heading: z.string().min(1).max(100), paragraphs: z.array(text).max(12).optional(), bullets: z.array(z.string().max(160)).max(24).optional() })
  .strict();

export const deckRequestSchema = z
  .object({
    kind: z.enum(DECK_KINDS),
    title: z.string().max(120).optional(),
    /** A treatment: the production it belongs to. */
    projectId: id.optional(),
    /** A PPM deck: the board's own id. */
    board: id.optional(),
    /** A pitch deck: the words, written by the caller. */
    pitch: z.object({ logline: z.string().max(300).optional(), audience: z.string().max(120).optional(), sections: z.array(section).min(1).max(14) }).strict().optional(),
    images: z.array(handle).max(MAX_IMAGES).optional(),
    logo: z.object({ upload: id }).strict().optional(),
    page: z.enum(Object.keys(PAGE_SIZES) as [keyof typeof PAGE_SIZES, ...(keyof typeof PAGE_SIZES)[]]).optional(),
    bleedMm: z.number().refine((n) => (BLEEDS as readonly number[]).includes(n), { message: "bleedMm is 0 or 3." }).optional(),
  })
  .strict();
export type DeckRequest = z.infer<typeof deckRequestSchema>;

export type DeckPdf = {
  uploadId: string;
  url: string;
  filename: string;
  mime: "application/pdf";
  bytes: number;
  pages: number;
  kind: (typeof DECK_KINDS)[number];
  price: typeof PDF_PRICE;
};

export class PdfError extends Error {
  constructor(message: string, public status = 400, public retryAfterSeconds?: number) {
    super(message);
    this.name = "PdfError";
  }
}
