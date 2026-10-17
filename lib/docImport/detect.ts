import { identifyImage } from "../imagemeta";
import { MAX_SOURCE_BYTES } from "./limits";
import { DocImportError, type DocKind } from "./types";
import { isZip } from "./zip";
import { rootElementName } from "./xml";

/**
 * Which extractor a file goes to, decided by its extension and then
 * confirmed from its bytes. A file whose bytes are another type than its
 * name says is refused, naming what it really is when that is known. The
 * zip formats are confirmed again by their main part once the package is
 * open (see OFFICE_MAIN_PART), since every Office file is "a zip".
 */

const BY_EXTENSION: Record<string, DocKind> = {
  docx: "docx",
  pdf: "pdf",
  fdx: "fdx",
  fdxt: "fdx",
  pptx: "pptx",
  xlsx: "xlsx",
  jpg: "image",
  jpeg: "image",
  png: "image",
  tif: "image",
  tiff: "image",
  svg: "svg",
};

/** Older binary Office formats: refused with the format to save as instead. */
const LEGACY: Record<string, string> = { doc: ".docx", xls: ".xlsx", ppt: ".pptx" };

/** The part that proves which Office format a package is. */
export const OFFICE_MAIN_PART: Record<"docx" | "pptx" | "xlsx", string> = {
  docx: "word/document.xml",
  pptx: "ppt/presentation.xml",
  xlsx: "xl/workbook.xml",
};

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** A plain name for what the bytes look like, for the mismatch message. */
export function describeBytes(bytes: Buffer): string | null {
  if (bytes.subarray(0, 1024).includes("%PDF-")) return "a PDF";
  if (isZip(bytes)) return "a zip package";
  const image = identifyImage(bytes);
  if (image) return `a ${image.ext.toUpperCase()} image`;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "a compressed (gzip) file";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "an older Office file";
  const head = bytes.subarray(0, 4096).toString("utf8");
  const root = rootElementName(head);
  if (root === "FinalDraft") return "a Final Draft file";
  if (root && root.replace(/^.*:/, "") === "svg") return "an SVG image";
  return null;
}

function mismatch(extension: string, bytes: Buffer): never {
  const real = describeBytes(bytes);
  throw new DocImportError(
    "type_mismatch",
    `This file is named .${extension} but ${real ? `it is ${real}` : "its contents are not that format"}. Nothing was imported.`,
  );
}

export type Detected = { kind: DocKind; extension: string; mime?: string };

/** The extractor for this file, or a refusal. Checks size, extension and the real type. */
export function detectDocument(filename: string, bytes: Buffer): Detected {
  const extension = extensionOf(filename);
  if (LEGACY[extension])
    throw new DocImportError("unsupported", `Save this file as ${LEGACY[extension]} and import that.`);
  const kind = BY_EXTENSION[extension];
  if (!kind)
    throw new DocImportError(
      "unsupported",
      "Import a .docx, .pdf, .fdx, .fdxt, .pptx, .xlsx, .jpg, .png, .tiff or .svg file.",
    );
  const max = MAX_SOURCE_BYTES[kind];
  if (bytes.length > max)
    throw new DocImportError("too_large", `Use a file up to ${Math.round(max / (1024 * 1024))} MB. Nothing was imported.`);
  if (!bytes.length) throw new DocImportError("damaged", "This file is empty. Nothing was imported.");

  switch (kind) {
    case "docx":
    case "pptx":
    case "xlsx":
      if (!isZip(bytes)) mismatch(extension, bytes);
      return { kind, extension };
    case "pdf":
      if (!bytes.subarray(0, 1024).includes("%PDF-")) mismatch(extension, bytes);
      return { kind, extension, mime: "application/pdf" };
    case "image": {
      const meta = identifyImage(bytes);
      if (!meta || meta.mime !== IMAGE_MIME_BY_EXTENSION[extension]) mismatch(extension, bytes);
      return { kind, extension, mime: meta.mime };
    }
    case "fdx":
    case "svg": {
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) mismatch(extension, bytes);
      const root = rootElementName(bytes.subarray(0, 64 * 1024).toString("utf8"));
      const expected = kind === "fdx" ? "FinalDraft" : "svg";
      if (!root || root.replace(/^.*:/, "") !== expected) mismatch(extension, bytes);
      return { kind, extension, mime: kind === "svg" ? "image/svg+xml" : "application/xml" };
    }
  }
}
