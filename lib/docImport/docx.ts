import mammoth from "mammoth";
import { zipSync } from "fflate";
import { MAX_TEXT_CHARS } from "./limits";
import { mediaImages, openOffice, partText } from "./ooxml";
import { DocImportError, type Deadline, type ExtractedDocument, type Warnings } from "./types";

/**
 * .docx through mammoth (BSD-2-Clause, pinned in package.json).
 *
 * mammoth is never handed the uploaded bytes. The package is opened with the
 * bounded zip reader first; every part is inflated within its declared size
 * and checked against its CRC; every XML part is refused if it declares a
 * DOCTYPE or ENTITY; and mammoth receives a NEW zip, rebuilt uncompressed
 * from those checked XML parts only. So mammoth's own unzip
 * cannot be the one a zip bomb aims at, and it has no pictures to read.
 * extractRawText takes no options: it cannot read linked files from disk
 * (externalFileAccess stays at its default, off) and fetches nothing.
 */
export async function extractDocx(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const label = "This Word document";
  const zip = openOffice("docx", bytes);
  const parts: Record<string, Uint8Array> = Object.create(null);
  for (const name of zip.entries.keys()) {
    deadline.check();
    // Only XML parts: mammoth reads nothing else for text, so pictures,
    // fonts and embedded objects never reach it.
    if (/\.(xml|rels)$/i.test(name)) parts[name] = Buffer.from(partText(zip, name, label), "utf8");
  }
  const rebuilt = Buffer.from(zipSync(parts, { level: 0 }));
  deadline.check();
  let result: { value: string; messages: { type: string; message: string }[] };
  try {
    result = await mammoth.extractRawText({ buffer: rebuilt });
  } catch {
    throw new DocImportError("damaged", `${label} is damaged or incomplete. Nothing was imported.`);
  }
  deadline.check();
  for (const message of result.messages.slice(0, 10))
    if (message.type === "warning") warnings.add(`Word: ${String(message.message).slice(0, 200)}`);
  const text = result.value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_TEXT_CHARS)
    throw new DocImportError("limit", "This document has more than one million characters of text. Nothing was imported.");
  const images = mediaImages(zip, "word/media/", deadline, warnings);
  return {
    kind: "docx",
    format: "plain",
    text,
    sections: [{ kind: "document", index: 1, start: 0, end: text.length }],
    images,
    warnings: [],
  };
}
