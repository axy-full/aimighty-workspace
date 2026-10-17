import mammoth from "mammoth";
import { zipSync } from "fflate";
import { MAX_DOCX_XML_BYTES, MAX_DOCX_XML_EVENTS, MAX_TEXT_CHARS } from "./limits";
import { mediaImages, openOffice, partText } from "./ooxml";
import { DocImportError, TextBudget, type Deadline, type ExtractedDocument, type Warnings } from "./types";
import { localName, scanXml } from "./xml";

/**
 * .docx through mammoth (BSD-2-Clause, pinned in package.json).
 *
 * mammoth is never handed the uploaded bytes. The package is opened with the
 * bounded zip reader, and only the parts mammoth needs for text are taken:
 * DOCX_PARTS below, nothing else (no media, fonts, embedded objects, custom
 * XML or anything a relationship names). Each is inflated within its
 * declared size and checked against its CRC, refused if it declares a
 * DOCTYPE or ENTITY, and fully scanned with the DTD-free reader in refuse
 * mode under one shared budget of MAX_DOCX_XML_EVENTS events and
 * MAX_DOCX_XML_BYTES bytes. The scan also counts the text mammoth could
 * produce (every <w:t> character, and one for each tab, break or symbol), so
 * a document past MAX_TEXT_CHARS is refused before mammoth builds its DOM.
 * mammoth then receives a NEW zip, rebuilt uncompressed from those parts.
 * extractRawText takes no options: it cannot read linked files from disk
 * (externalFileAccess stays at its default, off) and fetches nothing. Its
 * warnings quote the document (style names), so none is passed on: they
 * become one fixed warning.
 */

const DOCX_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "word/numbering.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
  "word/comments.xml",
];

/** Elements mammoth turns into one character of raw text each. */
const ONE_CHARACTER = new Set(["tab", "br", "cr", "sym", "noBreakHyphen", "softHyphen", "ptab"]);

export async function extractDocx(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const label = "This Word document";
  const zip = openOffice("docx", bytes);
  const parts: Record<string, Uint8Array> = Object.create(null);
  const events = { remaining: MAX_DOCX_XML_EVENTS };
  const budget = new TextBudget(label);
  let total = 0;
  for (const name of DOCX_PARTS) {
    if (!zip.entries.has(name)) continue;
    deadline.check();
    total += zip.entries.get(name)!.size;
    if (total > MAX_DOCX_XML_BYTES)
      throw new DocImportError("limit", `${label} is larger than the importer reads. Nothing was imported.`);
    const text = partText(zip, name, label);
    let inText = 0;
    scanXml(text, (event) => {
      if (event.type === "text") {
        if (inText) budget.add(event.text.length);
        return;
      }
      const local = localName(event.name);
      if (local === "t") inText += event.type === "open" ? 1 : -1;
      else if (event.type === "open" && ONE_CHARACTER.has(local)) budget.add(1);
      else if (event.type === "open" && local === "p") budget.add(2);
    }, { doctype: "refuse", label, deadline, eventBudget: events });
    parts[name] = Buffer.from(text, "utf8");
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
  if (result.messages.length) warnings.add("Some Word formatting was not recognised; the text was kept.");
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
