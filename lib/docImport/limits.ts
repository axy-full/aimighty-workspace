/**
 * Every limit the document importer enforces, in one place so the security
 * note and the code cannot drift. A file past any of these is refused with a
 * plain message and nothing is imported: no limit here silently truncates.
 */

const MiB = 1024 * 1024;

/** Largest source file accepted, by kind (bytes as uploaded). */
export const MAX_SOURCE_BYTES = {
  docx: 50 * MiB,
  pptx: 50 * MiB,
  xlsx: 50 * MiB,
  pdf: 50 * MiB,
  fdx: 10 * MiB,
  image: 20 * MiB,
  svg: 5 * MiB,
} as const;

/** The most text one import may produce (the screenplay importer's own ceiling). */
export const MAX_TEXT_CHARS = 1_000_000;
/** Pages read from a PDF; more and the file is refused. */
export const MAX_PDF_PAGES = 400;
/** Slides read from a deck. */
export const MAX_SLIDES = 300;
/** Sheets read from a workbook. */
export const MAX_SHEETS = 50;
/** Cells read across all sheets of a workbook. */
export const MAX_CELLS = 200_000;
/** Columns read per row; a cell further right is skipped with a warning. */
export const MAX_COLUMNS = 256;
/** Embedded images listed and stored per document. */
export const MAX_IMAGES = 200;
/** One embedded image's size. */
export const MAX_IMAGE_BYTES = 25 * MiB;
/** All embedded images kept from one document; past it the rest are skipped with a warning. */
export const MAX_IMAGES_TOTAL_BYTES = 100 * MiB;
/** Warnings kept per import; the rest are counted in one closing line. */
export const MAX_WARNINGS = 50;

/* ── Zip containers (.docx, .pptx, .xlsx) ─────────────────────────────── */

/** Entries in the central directory. */
export const MAX_ZIP_ENTRIES = 5_000;
/** Sum of every entry's declared uncompressed size. */
export const MAX_ZIP_TOTAL_BYTES = 256 * MiB;
/** One entry's uncompressed size. */
export const MAX_ZIP_ENTRY_BYTES = 64 * MiB;
/** One XML part's uncompressed size (document.xml, a slide, a sheet). */
export const MAX_XML_PART_BYTES = 32 * MiB;
/** Compression ratio allowed for an entry larger than RATIO_FLOOR_BYTES. Deflate tops out near 1032:1; real XML sits far below 100:1. */
export const MAX_ZIP_RATIO = 200;
export const RATIO_FLOOR_BYTES = 1 * MiB;

/* ── XML ──────────────────────────────────────────────────────────────── */

/** Element nesting depth. */
export const MAX_XML_DEPTH = 256;
/** Elements, closes and text runs in one XML part. */
export const MAX_XML_EVENTS = 5_000_000;

/* ── OCR ──────────────────────────────────────────────────────────────── */

/** Pixels in one image sent to OCR (width × height, from its header). */
export const MAX_OCR_PIXELS = 40_000_000;
/** Either side of an image sent to OCR. */
export const MAX_OCR_SIDE = 12_000;
/** One image's OCR; past it the OCR worker is terminated. */
export const OCR_TIMEOUT_MS = 60_000;

/** The whole extraction of one file, OCR included. */
export const DEFAULT_TIMEOUT_MS = 120_000;
