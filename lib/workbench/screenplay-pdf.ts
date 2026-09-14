"use client";
import {
  assemblePages,
  MAX_PDF_BYTES,
  MAX_SCRIPT_CHARS,
  MAX_SCRIPT_PAGES,
  screenplayPageText,
  type ScreenplayImport,
} from "./screenplay";

export async function extractScreenplayPdf(
  file: File,
  signal: AbortSignal,
  progress: (page: number, total: number) => void,
): Promise<ScreenplayImport> {
  if (file.size > MAX_PDF_BYTES)
    throw new Error("Use a PDF up to 20 MB. Nothing was imported.");
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
  let timedOut = false;
  const cancel = () => {
    void task.destroy();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 120_000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_SCRIPT_PAGES)
      throw new Error(
        `This PDF has ${document.numPages} pages; the import limit is ${MAX_SCRIPT_PAGES}. Nothing was imported.`,
      );
    const texts: string[] = [];
    let characters = 0;
    for (let number = 1; number <= document.numPages; number++) {
      if (signal.aborted || timedOut) throw new Error("Import cancelled.");
      const page = await document.getPage(number);
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
      page.cleanup();
      progress(number, document.numPages);
    }
    return { ...assemblePages(texts), sha256 };
  } catch (error) {
    if (signal.aborted) throw new Error("Import cancelled.");
    if (timedOut)
      throw new Error(
        "This PDF could not be extracted within two minutes. Nothing was imported. Export a simpler text PDF or run OCR first.",
      );
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error("Export an unlocked copy of the PDF before importing.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await task.destroy();
  }
}
