/**
 * Our own deck pages (Slice 1 of the engine stack): what a treatment, a pitch deck and a PPM deck are made of, before they are
 * written as HTML (lib/pdf/html.ts) and printed to PDF on the export worker (remotion/node/pdf.ts). Pure: no database, no
 * network. Every word on a page is content, escaped by the HTML writer; nothing in a request can add markup.
 */
export const DECK_KINDS = ["treatment", "pitch", "ppm", "film"] as const;
export type DeckKind = (typeof DECK_KINDS)[number];

/** The page sizes decks come in, in millimetres, landscape: a 16:9 slide (13.333 x 7.5 in), A4 and US Letter. */
export const PAGE_SIZES = Object.freeze({
  slide: { width: 338.667, height: 190.5 },
  a4: { width: 297, height: 210 },
  letter: { width: 279.4, height: 215.9 },
});
export type PageSize = keyof typeof PAGE_SIZES;
/** Each kind's own page, unless the request names another. */
export const DEFAULT_PAGE: Record<DeckKind, PageSize> = { treatment: "slide", pitch: "slide", ppm: "a4", film: "slide" };
/** The bleed a printer may ask for, in millimetres: none, or 3 mm each side (the page grows by twice that; artwork runs to the new edge). */
export const BLEEDS = [0, 3] as const;

/** The words a person sees for each kind. */
export const KIND_LABEL: Record<DeckKind, string> = { treatment: "Treatment", pitch: "Pitch deck", ppm: "PPM deck", film: "Film deck" };

export const MAX_PAGES = 60;
export const MAX_IMAGES = 24;
export const TEXT_MAX = 1800;

export type DeckPage =
  | { type: "cover"; title: string; subtitle?: string; meta?: string[]; logo?: string; /** The word over the title (default: the kind's own). */ eyebrow?: string; /** A film deck has two covers over the same pages: a quiet Treatment and a bold Pitch. */ style?: "treatment" | "pitch" }
  | { type: "text"; eyebrow?: string; heading: string; paragraphs: string[] }
  | { type: "facts"; eyebrow?: string; heading: string; rows: [string, string][] }
  | { type: "bullets"; eyebrow?: string; heading: string; items: string[] }
  | { type: "images"; eyebrow?: string; heading: string; items: { file: string; caption: string }[] }
  | { type: "table"; eyebrow?: string; heading: string; columns: { label: string; pct: number }[]; rows: string[][] };

export type DeckDoc = {
  kind: DeckKind;
  title: string;
  size: PageSize;
  bleedMm: number;
  pages: DeckPage[];
  /** File names of the pictures the pages use (i1.jpg …), in the order they were bound. */
  images: string[];
};

/** Page size in millimetres as printed, bleed included. */
export function mediaOf(doc: Pick<DeckDoc, "size" | "bleedMm">) {
  const trim = PAGE_SIZES[doc.size];
  return { width: trim.width + 2 * doc.bleedMm, height: trim.height + 2 * doc.bleedMm };
}

/** Text as it goes on a page: line breaks kept as paragraph breaks, other control characters and runs of space gone. */
export function plain(value: unknown, max = TEXT_MAX): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}
export const oneLine = (value: unknown, max = 160) => plain(value, max).replace(/\s*\n\s*/g, " ");

/**
 * Text cut into pages that fit, at paragraph then sentence then word breaks, never in the middle of a word. `max` is the
 * characters one page holds; a deck page is not scrolled, so nothing may be left to overflow.
 */
export function paginateText(paragraphs: readonly string[], max: number): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  let used = 0;
  const push = () => { if (page.length) pages.push(page); page = []; used = 0; };
  for (const paragraph of paragraphs.map((p) => p.trim()).filter(Boolean)) {
    let rest = paragraph;
    while (rest.length) {
      const room = max - used;
      if (rest.length <= room) { page.push(rest); used += rest.length + 40; rest = ""; break; }
      if (room < 120 && page.length) { push(); continue; }
      const window = rest.slice(0, Math.max(room, 120));
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      const at = cut > window.length * 0.4 ? cut + 1 : Math.max(window.lastIndexOf(" "), Math.floor(window.length * 0.4));
      page.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
      push();
    }
  }
  push();
  return pages;
}

/** How many characters of body text one page holds at each size (a headline and a footer already taken off). */
export function textBudget(size: PageSize): number {
  return size === "slide" ? 640 : 1100;
}

/** The page's height in layout units (one unit is 1% of its width): what a table fits on. */
export function pageUnits(size: PageSize): number {
  const s = PAGE_SIZES[size];
  return (100 * s.height) / s.width;
}

const TABLE_U = 84; // the content width in units (8 each side)
const CELL_FONT = 0.95; // a table cell's text size in units
const CELL_LINES_MAX = 8;

/** How many characters of one cell fit on a line of a column `pct` wide. */
const perLineOf = (pct: number) => Math.max(4, Math.floor((TABLE_U * pct / 100 - 1.6) / (CELL_FONT * 0.55)));

/** A cell's words as the table can hold them: at most eight lines of its column, cut with an ellipsis (the CSV keeps every word). */
export function clampCell(value: string, pct: number): string {
  const max = perLineOf(pct) * CELL_LINES_MAX;
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Rows cut into pages by their estimated height, so no row is clipped. Column widths are percentages of the table. */
export function paginateRows(columns: readonly { pct: number }[], rows: readonly string[][], size: PageSize): string[][][] {
  const budget = pageUnits(size) - 28; // the margins, the headline, the header row and the footer
  const pages: string[][][] = [];
  let page: string[][] = [];
  let used = 0;
  for (const row of rows) {
    let lines = 1;
    row.forEach((cell, index) => {
      const perLine = perLineOf(columns[index]?.pct ?? 10);
      lines = Math.max(lines, cell.split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0));
    });
    const height = Math.min(lines, CELL_LINES_MAX + 1) * CELL_FONT * 1.3 + 1.4;
    if (page.length && used + height > budget) { pages.push(page); page = []; used = 0; }
    page.push([...row]);
    used += height;
  }
  if (page.length) pages.push(page);
  return pages;
}

/** Facts (a label and its words) cut into pages by their estimated height: the words of one row run to several lines. */
export function paginateFacts(rows: readonly [string, string][], size: PageSize): [string, string][][] {
  const budget = pageUnits(size) - 27 - 8; // the margins, the headline, then the footer's room
  const pages: [string, string][][] = [];
  let page: [string, string][] = [];
  let used = 0;
  for (const row of rows) {
    const lines = Math.max(Math.ceil(row[1].length / 52), Math.ceil(row[0].length / 14), 1);
    const height = lines * 1.75 * 1.4 + 1.9;
    if (page.length && used + height > budget) { pages.push(page); page = []; used = 0; }
    page.push(row);
    used += height;
  }
  if (page.length) pages.push(page);
  return pages;
}

/** List items cut into pages by their estimated height. */
export function paginateItems(items: readonly string[], size: PageSize): string[][] {
  const budget = pageUnits(size) - 31;
  const pages: string[][] = [];
  let page: string[] = [];
  let used = 0;
  for (const item of items) {
    const height = Math.max(1, Math.ceil(item.length / 66)) * 1.9 * 1.4 + 1.7;
    if (page.length && used + height > budget) { pages.push(page); page = []; used = 0; }
    page.push(item);
    used += height;
  }
  if (page.length) pages.push(page);
  return pages;
}
