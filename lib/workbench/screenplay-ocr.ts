"use client";
import { ScreenplayOcrWorker } from "./ocr-worker";
import { renderScreenplayPage, withScreenplayPdf } from "./screenplay-pdf";
import { applyOcrPage, remainingOcrPages } from "./screenplay-ocr-state";
import type { ScreenplayImport } from "./screenplay";

export async function recognizeScreenplayPdf(
  file: File,
  initial: ScreenplayImport,
  signal: AbortSignal,
  completed: (result: ScreenplayImport) => void,
  progress: (message: string) => void,
) {
  return withScreenplayPdf(
    file,
    signal,
    30 * 60_000,
    async (document, sha256, lifetime) => {
      if (
        sha256 !== initial.sha256 ||
        document.numPages !== initial.pages.length
      )
        throw new Error("The original PDF changed. Start a new import.");
      let result = initial,
        currentPage = 0;
      const remaining = remainingOcrPages(result);
      if (!remaining.length) return result;
      const worker = new ScreenplayOcrWorker(lifetime, (fraction) =>
        progress(
          `Recognizing page ${currentPage} of ${document.numPages} · ${Math.round(fraction * 100)}%`,
        ),
      );
      try {
        progress("Loading local English OCR…");
        await worker.initialize();
        for (const number of remaining) {
          if (lifetime.aborted) throw new Error("OCR cancelled.");
          currentPage = number;
          progress(`Rendering page ${number} of ${document.numPages}…`);
          const page = await document.getPage(number);
          try {
            const raster = await renderScreenplayPage(page, lifetime);
            progress(`Recognizing page ${number} of ${document.numPages}…`);
            const recognized = await worker.recognize(
              new Uint8Array(await raster.arrayBuffer()),
            );
            if (lifetime.aborted) throw new Error("OCR cancelled.");
            result = applyOcrPage(
              result,
              number,
              recognized.text,
              recognized.confidence,
            );
            completed(result);
          } finally {
            page.cleanup();
          }
        }
        return result;
      } finally {
        worker.terminate();
      }
    },
  );
}
