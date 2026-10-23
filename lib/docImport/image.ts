import path from "node:path";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { identifyImage } from "../imagemeta";
import { MAX_OCR_PIXELS, MAX_OCR_SIDE, MAX_TEXT_CHARS, OCR_TIMEOUT_MS } from "./limits";
import { DocImportError, type Deadline, type ExtractedDocument, type Warnings } from "./types";

/**
 * Pictures (.jpg, .png, .tiff) read through Tesseract OCR (tesseract.js
 * 7.0.0, Apache-2.0, already pinned), on the server, in its own worker
 * thread, which is terminated when the image's time is up.
 *
 * Nothing is downloaded. tesseract.js is given a langPath that must be an
 * absolute directory on this machine (never a URL, so it never fetches and
 * never falls back to its CDN) and cacheMethod "none" (it never writes a
 * cache file). The directory is the installed @tesseract.js-data/eng
 * package unless server config names another (DOC_IMPORT_OCR_DATA_DIR, read
 * by name only). English is installed today. Hindi is a valid option whose
 * data is not installed yet: asking for it is refused with
 * "language_unavailable" until hin.traineddata.gz is in that directory.
 *
 * The picture's pixel size is read from its header before any decoding,
 * and a picture past MAX_OCR_PIXELS or MAX_OCR_SIDE is refused, so a tiny
 * file that declares an enormous canvas is never decoded.
 */

export type OcrLanguage = "eng" | "hin";
export const OCR_LANGUAGES: readonly OcrLanguage[] = ["eng", "hin"];

export type OcrResult = { text: string; confidence: number };
export type OcrEngine = (
  image: Buffer,
  options: { languages: OcrLanguage[]; timeoutMs: number; signal?: AbortSignal },
) => Promise<OcrResult>;

const localRequire = createRequire(path.join(process.cwd(), "package.json"));

/**
 * The local directory holding <code>.traineddata.gz, or a refusal. It must be
 * an absolute path with no scheme: tesseract.js fetches anything URL-shaped.
 */
export function ocrDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DOC_IMPORT_OCR_DATA_DIR?.trim();
  const dir = configured || path.join(path.dirname(localRequire.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
  // "//host/x" is absolute to the path module and protocol-relative to a URL parser: refused too.
  if (!path.isAbsolute(dir) || dir.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(dir) || dir.includes("\0"))
    throw new DocImportError("language_unavailable", "OCR is not set up on this server. Nothing was imported.");
  return path.resolve(dir);
}

/** The options every tesseract.js worker is created with: local data, no cache, no logging. */
export function tesseractWorkerOptions(langPath: string) {
  return { langPath, cacheMethod: "none", gzip: true, logger: () => {}, errorHandler: () => {} } as const;
}

/** Every requested language's data must already be on disk. Never a download. */
export async function checkOcrLanguages(languages: OcrLanguage[], dir: string) {
  for (const code of languages) {
    if (!OCR_LANGUAGES.includes(code)) throw new DocImportError("language_unavailable", "That OCR language is not offered.");
    try {
      await access(path.join(dir, `${code}.traineddata.gz`));
    } catch {
      throw new DocImportError(
        "language_unavailable",
        `OCR for ${code === "hin" ? "Hindi" : "English"} is not installed yet. Nothing was imported.`,
      );
    }
  }
}

/** The real engine: one tesseract.js worker per picture, terminated on time-out, abort or finish. */
export const tesseractOcr: OcrEngine = async (image, { languages, timeoutMs, signal }) => {
  const langPath = ocrDataDir();
  await checkOcrLanguages(languages, langPath);
  const { createWorker } = await import("tesseract.js");
  // The clock starts before the worker does, so a stalled start is cut off too.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DocImportError("timeout", "Reading this picture took too long. Nothing was imported.")), timeoutMs);
    signal?.addEventListener("abort", () => reject(new DocImportError("timeout", "The import was cancelled.")), { once: true });
  });
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let finished = false;
  try {
    // OEM 1 is the LSTM engine the installed "best_int" data is built for.
    const starting = createWorker(languages.join("+"), 1, tesseractWorkerOptions(langPath)).then((started) => {
      // A worker that finishes starting after the deadline is ended at once.
      if (finished) void started.terminate().catch(() => {});
      else worker = started;
      return started;
    });
    const ready = await Promise.race([starting, stopped]);
    const result = await Promise.race([ready.recognize(image), stopped]);
    return { text: result.data.text ?? "", confidence: result.data.confidence ?? 0 };
  } finally {
    finished = true;
    clearTimeout(timer);
    await worker?.terminate().catch(() => {});
  }
};

/**
 * A TIFF's first directory must name its width and its height once each. The
 * header sniffer keeps the last value it sees and a decoder may keep the
 * first, so a file that names them twice could pass the size check with one
 * size and be decoded at another. Each must also be a single SHORT (3) or
 * LONG (4): the sniffer reads any other type (LONG8, RATIONAL, an array) as
 * if it were one of those, which is a second way to report a false size.
 */
export function checkTiffSize(bytes: Buffer) {
  const le = bytes[0] === 0x49;
  const read16 = (at: number) => (le ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const read32 = (at: number) => (le ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  let seen = { width: 0, height: 0 };
  try {
    const ifd = read32(4);
    const count = read16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      const tag = read16(entry);
      if (tag !== 256 && tag !== 257) continue;
      const type = read16(entry + 2);
      if ((type !== 3 && type !== 4) || read32(entry + 4) !== 1)
        throw new DocImportError("unsafe", "This picture states its size in a form the importer does not read. Nothing was imported.");
      if (tag === 256) seen = { ...seen, width: seen.width + 1 };
      else seen = { ...seen, height: seen.height + 1 };
    }
  } catch (error) {
    if (error instanceof DocImportError) throw error;
    throw new DocImportError("damaged", "This picture's size cannot be read from its header. Nothing was imported.");
  }
  if (seen.width !== 1 || seen.height !== 1)
    throw new DocImportError("unsafe", "This picture names its size more than once (or not at all). Nothing was imported.");
}

export type ImageOptions = { ocr?: OcrEngine; languages?: OcrLanguage[]; signal?: AbortSignal };

export async function extractImage(
  bytes: Buffer,
  deadline: Deadline,
  warnings: Warnings,
  options: ImageOptions = {},
): Promise<ExtractedDocument> {
  const meta = identifyImage(bytes);
  if (!meta || meta.kind !== "image")
    throw new DocImportError("type_mismatch", "This file is not a picture the importer reads. Nothing was imported.");
  if (meta.mime === "image/tiff") checkTiffSize(bytes);
  const { width, height } = meta;
  if (!width || !height)
    throw new DocImportError("damaged", "This picture's size cannot be read from its header. Nothing was imported.");
  if (width > MAX_OCR_SIDE || height > MAX_OCR_SIDE || width * height > MAX_OCR_PIXELS)
    throw new DocImportError(
      "limit",
      `This picture is ${width} × ${height} pixels; the importer reads up to ${MAX_OCR_PIXELS / 1_000_000} megapixels. Nothing was imported.`,
    );
  const languages = options.languages?.length ? [...new Set(options.languages)] : (["eng"] as OcrLanguage[]);
  for (const code of languages)
    if (!OCR_LANGUAGES.includes(code)) throw new DocImportError("language_unavailable", "That OCR language is not offered.");
  deadline.check();
  const engine = options.ocr ?? tesseractOcr;
  let result: OcrResult;
  try {
    result = await engine(bytes, {
      languages,
      timeoutMs: Math.min(OCR_TIMEOUT_MS, deadline.remainingMs()),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DocImportError) throw error;
    throw new DocImportError("damaged", "This picture could not be read. Nothing was imported.");
  }
  deadline.check();
  const text = result.text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n").map((line) => line.trimEnd()).join("\n").trim();
  if (text.length > MAX_TEXT_CHARS)
    throw new DocImportError("limit", "This picture has more than one million characters of text. Nothing was imported.");
  if (!text) warnings.add("No text was found in this picture.");
  else if (result.confidence < 60)
    warnings.add(`OCR confidence is low (${Math.round(result.confidence)}%). Check the text against the picture.`);
  return {
    kind: "image",
    format: "plain",
    text,
    sections: [{ kind: "image", index: 1, start: 0, end: text.length }],
    images: [],
    warnings: [],
  };
}
