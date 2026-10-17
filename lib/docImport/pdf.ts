import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { MAX_PDF_PAGES, MAX_TEXT_CHARS } from "./limits";
import { DocImportError, type Deadline, type DocSection, type ExtractedDocument, type Warnings } from "./types";

/**
 * The text layer of a PDF through pdfjs-dist (Apache-2.0, already pinned),
 * using its Node build. No OCR here: a scanned PDF comes back with empty
 * pages and a warning.
 *
 * Settings, each on purpose: `data` is the bytes (no URL, so no range or
 * stream requests); `enableXfa: false` (no XFA forms); `disableFontFace` and
 * `useSystemFonts: false` (nothing installed or loaded from the system);
 * `useWasm: false`; `stopAtErrors: true` (a damaged file is refused, not
 * half-read); cMaps come from the package's own folder on disk. Embedded
 * JavaScript and PDF actions are never run: text extraction does not
 * execute them, and no scripting sandbox is created. pdfjs-dist 6 no longer
 * compiles fonts to JavaScript at all (its Node build contains no eval or
 * new Function; the old isEvalSupported switch is gone with it).
 */

type PdfJs = typeof import("pdfjs-dist");

let loaded: Promise<PdfJs> | null = null;
const localRequire = createRequire(path.join(process.cwd(), "package.json"));

function pdfjsRoot(): string {
  return path.dirname(localRequire.resolve("pdfjs-dist/package.json"));
}

async function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    const root = pdfjsRoot();
    const lib = (await import(
      /* webpackIgnore: true */ pathToFileURL(path.join(root, "legacy/build/pdf.mjs")).href
    )) as PdfJs;
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(root, "legacy/build/pdf.worker.mjs")).href;
    return lib;
  })();
  return loaded;
}

type TextItem = { str: string; hasEOL?: boolean };

export async function extractPdf(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: path.join(pdfjsRoot(), "cmaps") + path.sep,
    cMapPacked: true,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    verbosity: 0,
  });
  const timer = setTimeout(() => void task.destroy().catch(() => {}), deadline.remainingMs());
  try {
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      deadline.check();
      if (error instanceof Error && error.name === "PasswordException")
        throw new DocImportError("encrypted", "This PDF is password protected. Export an unlocked copy and retry.");
      throw new DocImportError("damaged", "This PDF is damaged or incomplete. Nothing was imported.");
    }
    if (document.numPages > MAX_PDF_PAGES)
      throw new DocImportError("limit", `This PDF has ${document.numPages} pages; the import limit is ${MAX_PDF_PAGES}. Nothing was imported.`);
    let text = "";
    const sections: DocSection[] = [];
    const empty: number[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      deadline.check();
      let pageText = "";
      try {
        const page = await document.getPage(number);
        try {
          const content = await page.getTextContent();
          for (const item of content.items as TextItem[]) {
            if (typeof item.str !== "string") continue;
            pageText += item.str + (item.hasEOL ? "\n" : "");
          }
        } finally {
          page.cleanup();
        }
      } catch (error) {
        deadline.check();
        if (error instanceof DocImportError) throw error;
        throw new DocImportError("damaged", "This PDF is damaged or incomplete. Nothing was imported.");
      }
      pageText = pageText.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n").map((line) => line.trimEnd()).join("\n").trim();
      if (pageText.replace(/[\s\d.]/g, "").length < 8) empty.push(number);
      if (text) text += "\n\n";
      const start = text.length;
      text += pageText;
      sections.push({ kind: "page", index: number, start, end: text.length });
      if (text.length > MAX_TEXT_CHARS)
        throw new DocImportError("limit", "This PDF has more than one million characters of text. Nothing was imported.");
    }
    if (empty.length === document.numPages)
      warnings.add("This PDF has no text layer (it may be a scan). Nothing was read from its pages.");
    else if (empty.length)
      warnings.add(`Pages ${empty.slice(0, 20).join(", ")}${empty.length > 20 ? " and more" : ""} have little or no text (they may be scans).`);
    return { kind: "pdf", format: "plain", text, sections, images: [], warnings: [] };
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}
