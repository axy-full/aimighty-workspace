/**
 * The PDF command's contract (Slice 1 of the engine stack, owner 15 Oct 2026): our own deck pages in as HTML, a PDF out.
 *
 *   spec.json   { "version": 1, "composition": "pdf", "pdf": { "pages": 12, "trimMm": { "width": 338.667, "height": 190.5 }, "bleedMm": 0, "images": ["i1.jpg"] } }
 *   input/      deck.html, and each image the spec names
 *   output/     deck.pdf, result.json
 *
 * Pure: no files, no browser, safe in the app and in the worker. The page is ours (the app writes it from its own templates
 * and escapes every word of content), and this file is the second lock: an allow-list of tags and attributes, no script,
 * no link, no address that is not a file in the session, and one Content-Security-Policy that the browser itself enforces.
 */

export const PDF_COMPOSITION = "pdf" as const;
export const PDF_HTML_FILE = "deck.html";
export const PDF_OUTPUT_FILE = "deck.pdf";

export const PDF_LIMITS = Object.freeze({
  pages: 60,
  htmlBytes: 3 * 1024 * 1024,
  images: 40,
  imageBytes: 20 * 1024 * 1024,
  imagesTotalBytes: 120 * 1024 * 1024,
  pdfBytes: 150 * 1024 * 1024,
  minMm: 50,
  maxMm: 1000,
  maxBleedMm: 10,
});

/** The typeface the worker image carries (SIL OFL, remotion/public/fonts). Pages name these files; the command copies them in. */
export const PDF_FONTS = Object.freeze(["outfit-latin-wght-normal.woff2", "outfit-latin-ext-wght-normal.woff2"]);
export const PDF_FONT_FAMILY = "ParticlDeck";

/** What the browser is allowed to load, enforced by the browser: nothing but files that sit beside the page. No script, no network. */
export const PDF_CSP = "default-src 'none'; img-src file:; font-src file:; style-src 'unsafe-inline'";

export type PdfSpec = {
  version: 1;
  composition: typeof PDF_COMPOSITION;
  pdf: { pages: number; trimMm: { width: number; height: number }; bleedMm: number; images: string[] };
};

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const IMAGE_NAME = /^i[1-9][0-9]{0,2}\.(png|jpg|webp)$/;
export const isDeckImageName = (value: unknown): value is string => typeof value === "string" && IMAGE_NAME.test(value);

const isRec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const mmOk = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= PDF_LIMITS.minMm && value <= PDF_LIMITS.maxMm;

export function isPdfSpec(spec: unknown): boolean {
  return isRec(spec) && spec.composition === PDF_COMPOSITION;
}

/** The media box the page will have, in millimetres: the trimmed page plus the bleed on every side. */
export const mediaMm = (pdf: PdfSpec["pdf"]) => ({ width: pdf.trimMm.width + 2 * pdf.bleedMm, height: pdf.trimMm.height + 2 * pdf.bleedMm });

export function validatePdfSpec(spec: unknown): Checked<PdfSpec> {
  const errors: string[] = [];
  if (!isRec(spec)) return { ok: false, errors: ["spec.json must be an object."] };
  for (const key of Object.keys(spec)) if (!["version", "composition", "pdf"].includes(key)) errors.push(`spec.${key} is not allowed.`);
  if (spec.version !== 1) errors.push("spec.version must be 1.");
  if (spec.composition !== PDF_COMPOSITION) errors.push(`spec.composition must be "${PDF_COMPOSITION}".`);
  const pdf = spec.pdf;
  if (!isRec(pdf)) return { ok: false, errors: [...errors, "spec.pdf is required."] };
  for (const key of Object.keys(pdf)) if (!["pages", "trimMm", "bleedMm", "images"].includes(key)) errors.push(`spec.pdf.${key} is not allowed.`);
  const pages = pdf.pages;
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > PDF_LIMITS.pages) errors.push(`spec.pdf.pages must be a whole number from 1 to ${PDF_LIMITS.pages}.`);
  const trim = pdf.trimMm;
  if (!isRec(trim) || !mmOk(trim.width) || !mmOk(trim.height)) errors.push(`spec.pdf.trimMm must give a width and a height from ${PDF_LIMITS.minMm} to ${PDF_LIMITS.maxMm} mm.`);
  const bleed = pdf.bleedMm;
  if (typeof bleed !== "number" || !Number.isFinite(bleed) || bleed < 0 || bleed > PDF_LIMITS.maxBleedMm) errors.push(`spec.pdf.bleedMm must be from 0 to ${PDF_LIMITS.maxBleedMm} mm.`);
  const images = pdf.images;
  if (!Array.isArray(images) || images.length > PDF_LIMITS.images) errors.push(`spec.pdf.images must be a list of at most ${PDF_LIMITS.images} names.`);
  else {
    if (images.some((name) => !isDeckImageName(name))) errors.push("spec.pdf.images names must look like i1.jpg, i2.png or i3.webp.");
    if (new Set(images).size !== images.length) errors.push("spec.pdf.images names must be different.");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: spec as unknown as PdfSpec };
}

/** What a file's first bytes say it is, for the three picture kinds the pages may hold. */
export function imageKindOf(head: Uint8Array): "png" | "jpg" | "webp" | null {
  const b = Buffer.from(head);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/* ---- the page ---- */

/** Tags the templates use. Nothing that loads, runs or links is on the list. */
const TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "main", "section", "header", "footer", "div", "p", "h1", "h2", "h3", "ul", "ol", "li",
  "span", "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td", "strong", "em", "br",
]);
const VOID = new Set(["meta", "img", "br"]);
/** Attributes the templates use, and where. `style` is not one: styling lives in the one <style> block. */
const ATTRS: Record<string, readonly string[]> = {
  "*": ["class", "lang"],
  meta: ["charset", "http-equiv", "content"],
  img: ["src", "alt", "class"],
  th: ["scope", "colspan", "class"],
  td: ["colspan", "class"],
};

/** The first thing wrong with a deck page, as a sentence; an empty list is a page the worker may print. */
export function checkDeckHtml(html: unknown, images: readonly string[]): string[] {
  if (typeof html !== "string") return ["deck.html is not text."];
  const errors: string[] = [];
  if (html.length === 0 || html.length > PDF_LIMITS.htmlBytes) return [`deck.html must be from 1 byte to ${PDF_LIMITS.htmlBytes} bytes.`];
  if (/[\u0000]/.test(html)) return ["deck.html holds a NUL character."];
  if (html.includes("<!--")) errors.push("deck.html must not hold comments.");
  const allowedImages = new Set(images.map((name) => `assets/${name}`));
  const allowedFonts = new Set(PDF_FONTS.map((name) => `fonts/${name}`));
  const note = (message: string) => { if (errors.length < 12 && !errors.includes(message)) errors.push(message); };

  /* The <style> blocks are raw text: checked on their own, then taken out. */
  let rest = html.replace(/<style>([\s\S]*?)<\/style>/gi, (_all, css: string) => {
    if (css.includes("\\")) note("The style block must not use backslash escapes.");
    /* Only two at-rules are ours (the typeface and the page size); any other, and any function that loads, is refused. */
    if (/@(?!font-face\b|page\b)|image-set\(|(?<![-\w])src\(|expression\(|behavior\s*:/i.test(css)) note("The style block uses something that loads or runs.");
    if (css.includes("<")) note("The style block must not hold a tag.");
    for (const match of css.matchAll(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi)) {
      const target = match[2].trim();
      if (!allowedFonts.has(target) && !allowedImages.has(target)) note(`The style block names a file that is not in this session: ${target.slice(0, 60)}.`);
    }
    if (/url\(/i.test(css.replace(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi, ""))) note("The style block holds a url() the command cannot read.");
    return "<style></style>";
  });
  if (/<style/i.test(rest.replace(/<style><\/style>/gi, ""))) note("A style tag was not closed.");

  let cspSeen = 0;
  let charsetSeen = 0;
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  rest = rest.replace(/<!doctype html>/i, "").replace(TAG, (_all, close: string, nameRaw: string, attrs: string, selfClose: string) => {
    const name = nameRaw.toLowerCase();
    if (!TAGS.has(name)) { note(`The tag <${name}> is not allowed.`); return ""; }
    if (close) { if (attrs.trim() || VOID.has(name)) note(`A closing </${name}> is not valid here.`); return ""; }
    if (selfClose && !VOID.has(name)) note(`<${name}/> must be written with a closing tag.`);
    const seen = new Set<string>();
    for (const attr of attrs.matchAll(/\s+([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const key = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (seen.has(key)) note(`<${name}> repeats ${key}.`);
      seen.add(key);
      if (!(ATTRS["*"].includes(key) || (ATTRS[name] ?? []).includes(key))) { note(`The attribute ${key} is not allowed on <${name}>.`); continue; }
      if (name === "img" && key === "src" && !allowedImages.has(value)) note(`An image names a file that is not in this session: ${value.slice(0, 60)}.`);
      if (name === "meta" && key === "http-equiv" && value.toLowerCase() !== "content-security-policy") note("The only meta rule allowed is the content security policy.");
      if (name === "meta" && key === "content" && attrs.toLowerCase().includes("content-security-policy")) { if (value === PDF_CSP) cspSeen += 1; else note("The content security policy is not the one the command requires."); }
      if (name === "meta" && key === "charset") { if (value.toLowerCase() === "utf-8") charsetSeen += 1; else note("The page must be UTF-8."); }
    }
    if (name === "img" && !seen.has("src")) note("An image has no file.");
    if (name === "meta" && !seen.has("charset") && !seen.has("http-equiv")) note("A meta tag must declare the charset or the content security policy.");
    return "";
  });
  if (rest.includes("<")) note("deck.html holds markup the command cannot read.");
  /* An address in the words themselves is only words, but a scheme in text that a browser may treat as a link is never needed. */
  if (cspSeen !== 1) note("The page must carry the content security policy exactly once.");
  if (charsetSeen !== 1) note("The page must declare UTF-8 once.");
  return errors;
}

/** What a PDF holds, read from its bytes: Chrome writes a plain PDF 1.4 with one page object each (no object streams). */
export function pdfFacts(bytes: Uint8Array): { header: boolean; pages: number; mediaPt: { width: number; height: number } | null } {
  const head = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
  const text = Buffer.from(bytes).toString("latin1");
  const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(text);
  return { header: head.startsWith("%PDF-"), pages, mediaPt: box ? { width: Number(box[1]), height: Number(box[2]) } : null };
}

/** Whether a media box matches the spec's page (a point is 1/72 in; Chrome rounds to its own device units). */
export function mediaMatches(pt: { width: number; height: number } | null, pdf: PdfSpec["pdf"]): boolean {
  if (!pt) return false;
  const want = mediaMm(pdf);
  const w = (want.width * 72) / 25.4;
  const h = (want.height * 72) / 25.4;
  return Math.abs(pt.width - w) <= 2 && Math.abs(pt.height - h) <= 2;
}
