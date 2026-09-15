"use client";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  assemblePages,
  MAX_PDF_BYTES,
  MAX_SCRIPT_CHARS,
  MAX_SCRIPT_PAGES,
  screenplayPageText,
  type ScreenplayImport,
} from "./screenplay";

/** No PDF actions, embedded scripts or network document URLs are passed to PDF.js. */
export async function withScreenplayPdf<T>(
  file: File,
  signal: AbortSignal,
  timeout: number,
  work: (
    document: PDFDocumentProxy,
    sha256: string,
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  if (file.size > MAX_PDF_BYTES)
    throw new Error("Use a PDF up to 20 MB. Nothing was imported.");
  if (signal.aborted) throw new Error("Import cancelled.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-"))
    throw new Error("This file is not a readable PDF.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc =
    "/vendor/pdfjs-6.3.289/pdf.worker.min.mjs";
  if (signal.aborted) throw new Error("Import cancelled.");
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: "/vendor/pdfjs-6.3.289/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs-6.3.289/standard_fonts/",
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    disableAutoFetch: true,
  });
  const lifetime = new AbortController();
  let timedOut = false;
  const cancel = () => {
    lifetime.abort();
    void task.destroy().catch(() => {});
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeout);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_SCRIPT_PAGES)
      throw new Error(
        `This PDF has ${document.numPages} pages; the import limit is ${MAX_SCRIPT_PAGES}. Nothing was imported.`,
      );
    if (signal.aborted || timedOut) throw new Error("Import cancelled.");
    return await work(document, sha256, lifetime.signal);
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        "Import cancelled. Completed OCR pages remain in this import.",
      );
    if (timedOut)
      throw new Error(
        "The PDF operation reached its time limit. Nothing was saved; completed OCR pages remain available to resume.",
      );
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error("Export an unlocked copy of the PDF before importing.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    lifetime.abort();
    await task.destroy().catch(() => {});
  }
}

export async function extractScreenplayPdf(
  file: File,
  signal: AbortSignal,
  progress: (page: number, total: number) => void,
): Promise<ScreenplayImport> {
  return withScreenplayPdf(
    file,
    signal,
    120_000,
    async (document, sha256, lifetime) => {
      const texts: string[] = [];
      let characters = 0;
      for (let number = 1; number <= document.numPages; number++) {
        if (lifetime.aborted) throw new Error("Import cancelled.");
        const page = await document.getPage(number);
        try {
          const content = await page.getTextContent();
          const text = screenplayPageText(
            content.items.filter((item) => "str" in item),
          );
          characters += text.length + 3;
          if (characters > MAX_SCRIPT_CHARS)
            throw new Error(
              "The extracted screenplay exceeds one million characters. Nothing was imported.",
            );
          texts.push(text);
          progress(number, document.numPages);
        } finally {
          page.cleanup();
        }
      }
      return { ...assemblePages(texts), sha256 };
    },
  );
}

/** One bounded raster at a time; free its backing store even when rendering fails. */
export async function renderScreenplayPage(
  page: PDFPageProxy,
  signal: AbortSignal,
  scale = 2,
): Promise<Blob> {
  const original = page.getViewport({ scale: 1 });
  if (
    ![original.width, original.height].every((v) => Number.isFinite(v) && v > 0)
  )
    throw new Error("This PDF page has invalid dimensions.");
  const bounded = Math.min(
    scale,
    3072 / Math.max(original.width, original.height),
    Math.sqrt(4_000_000 / (original.width * original.height)),
  );
  const viewport = page.getViewport({ scale: bounded });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  if (!canvas.width || !canvas.height)
    throw new Error("This PDF page has unsupported dimensions.");
  const task = page.render({ canvas, viewport, background: "white" });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 60_000);
  try {
    if (signal.aborted) throw new Error("Import cancelled.");
    await task.promise;
    if (signal.aborted) throw new Error("Import cancelled.");
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Could not render this PDF page.")),
        "image/png",
      ),
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    canvas.width = canvas.height = 0;
  }
}

export async function screenplayPagePreview(
  file: File,
  number: number,
  signal: AbortSignal,
) {
  return withScreenplayPdf(
    file,
    signal,
    60_000,
    async (document, _sha256, lifetime) => {
      const page = await document.getPage(number);
      try {
        return await renderScreenplayPage(page, lifetime, 1.25);
      } finally {
        page.cleanup();
      }
    },
  );
}
