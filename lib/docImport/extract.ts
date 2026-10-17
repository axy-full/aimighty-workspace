import { detectDocument } from "./detect";
import { DEFAULT_TIMEOUT_MS } from "./limits";
import type { ImageOptions } from "./image";
import { Deadline, DocImportError, Warnings, type DocKind, type ExtractedDocument } from "./types";

/**
 * One entry point for every format: check the name and the real type, pick
 * the extractor, run it under one deadline, and return the one normalized
 * shape. Pure: it reads only the bytes it is given, stores nothing, calls no
 * model and spends nothing. Extractors load lazily so a deck never loads
 * the PDF or OCR code.
 */

export type ExtractOptions = ImageOptions & {
  /** The whole file's budget, OCR included. */
  timeoutMs?: number;
  clock?: () => number;
};

type Extractor = (bytes: Buffer, deadline: Deadline, warnings: Warnings, options: ExtractOptions) => Promise<ExtractedDocument>;

const EXTRACTORS: Record<DocKind, () => Promise<Extractor>> = {
  docx: async () => (await import("./docx")).extractDocx,
  pdf: async () => (await import("./pdf")).extractPdf,
  fdx: async () => (await import("./fdx")).extractFdx,
  pptx: async () => (await import("./pptx")).extractPptx,
  xlsx: async () => (await import("./xlsx")).extractXlsx,
  svg: async () => (await import("./svg")).extractSvg,
  image: async () => {
    const { extractImage } = await import("./image");
    return (bytes, deadline, warnings, options) => extractImage(bytes, deadline, warnings, options);
  },
};

export async function extractDocument(filename: string, bytes: Buffer, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const detected = detectDocument(filename, bytes);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const outer = options.signal;
  const abort = () => controller.abort();
  outer?.addEventListener("abort", abort, { once: true });
  const deadline = new Deadline(timeoutMs, controller.signal, options.clock);
  const warnings = new Warnings();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DocImportError("timeout", "Reading this file took too long. Nothing was imported."));
    }, timeoutMs);
  });
  try {
    const extractor = await EXTRACTORS[detected.kind]();
    const result = await Promise.race([
      extractor(bytes, deadline, warnings, { ...options, signal: controller.signal }),
      timedOut,
    ]);
    deadline.check();
    for (const warning of result.warnings) warnings.add(warning);
    return { ...result, warnings: warnings.list() };
  } catch (error) {
    if (error instanceof DocImportError) throw error;
    // Never pass a parser's own message on, nor log it: it can quote the
    // file. The error's class name is enough to find the parser at fault.
    console.warn(JSON.stringify({ event: "doc_import_unexpected_error", kind: detected.kind, error: error instanceof Error ? error.name : typeof error }));
    throw new DocImportError("damaged", "This file could not be read. Nothing was imported.");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    controller.abort();
  }
}
