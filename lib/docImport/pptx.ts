import { MAX_SLIDES, MAX_TEXT_CHARS } from "./limits";
import { mediaImages, openOffice, relationships, scanPart } from "./ooxml";
import { DocImportError, type Deadline, type DocSection, type ExtractedDocument, type Warnings } from "./types";
import { localName } from "./xml";
import type { ZipArchive } from "./zip";

const LABEL = "This presentation";
const SLIDE = /\/relationships\/slide$/;
const NOTES = /\/relationships\/notesSlide$/;

/** Paragraphs of one slide or notes part: each <a:p> is a line, its <a:t> runs joined. */
function paragraphs(zip: ZipArchive, part: string, deadline: Deadline, warnings: Warnings): string[] {
  const lines: string[] = [];
  let line = "";
  let inParagraph = 0;
  let inText = 0;
  scanPart(zip, part, LABEL, (event) => {
    const name = event.type === "text" ? "" : localName(event.name);
    if (event.type === "open") {
      if (name === "p") {
        if (inParagraph++ === 0) line = "";
      } else if (name === "t") inText++;
      else if (name === "br" && inParagraph) line += "\n";
      else if (name === "tab" && inParagraph) line += "\t";
    } else if (event.type === "close") {
      if (name === "p" && --inParagraph === 0) {
        if (line.trim()) lines.push(line.trimEnd());
      } else if (name === "t") inText--;
    } else if (inText > 0) line += event.text;
  }, deadline, warnings);
  return lines;
}

/**
 * .pptx: slides in the order presentation.xml lists them, each slide's text
 * with its speaker notes, and the pictures in ppt/media. A slide or notes
 * target outside the package, or marked External, is never followed.
 */
export async function extractPptx(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const zip = openOffice("pptx", bytes);
  const main = "ppt/presentation.xml";
  const rels = relationships(zip, main, LABEL, deadline, warnings);
  const order: string[] = [];
  scanPart(zip, main, LABEL, (event) => {
    if (event.type === "open" && localName(event.name) === "sldId") {
      // <p:sldId id="256" r:id="rId2"/>: the prefixed id names the relationship.
      const key = Object.keys(event.attrs).find((name) => name.includes(":") && localName(name) === "id");
      if (key) order.push(event.attrs[key]);
    }
  }, deadline, warnings);
  if (order.length > MAX_SLIDES)
    throw new DocImportError("limit", `This presentation has ${order.length} slides; the import limit is ${MAX_SLIDES}. Nothing was imported.`);

  let text = "";
  const sections: DocSection[] = [];
  let index = 0;
  for (const id of order) {
    deadline.check();
    const rel = rels.get(id);
    if (!rel || !SLIDE.test(rel.type) || !rel.target || !zip.entries.has(rel.target)) {
      warnings.add("A slide listed by the presentation is missing and was skipped.");
      continue;
    }
    index++;
    const lines = paragraphs(zip, rel.target, deadline, warnings);
    const slideRels = relationships(zip, rel.target, LABEL, deadline, warnings);
    for (const other of slideRels.values()) {
      if (other.external) warnings.add("A slide links to something outside the file; it was not followed.");
      if (NOTES.test(other.type) && other.target && zip.entries.has(other.target)) {
        const notes = paragraphs(zip, other.target, deadline, warnings).filter((line) => !/^\d+$/.test(line.trim()));
        if (notes.length) lines.push("", "Notes:", ...notes);
      }
    }
    if (text) text += "\n\n";
    const start = text.length;
    text += lines.join("\n");
    sections.push({ kind: "slide", index, title: lines.find((line) => line.trim())?.trim().slice(0, 200), start, end: text.length });
    if (text.length > MAX_TEXT_CHARS)
      throw new DocImportError("limit", "This presentation has more than one million characters of text. Nothing was imported.");
  }
  return {
    kind: "pptx",
    format: "plain",
    text,
    sections,
    images: mediaImages(zip, "ppt/media/", deadline, warnings),
    warnings: [],
  };
}
