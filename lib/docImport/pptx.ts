import { MAX_SLIDES } from "./limits";
import { mediaImages, openOffice, relationships, scanPart } from "./ooxml";
import { DocImportError, TextBudget, type Deadline, type DocSection, type ExtractedDocument, type Warnings } from "./types";
import { localName } from "./xml";
import type { ZipArchive } from "./zip";

const LABEL = "This presentation";
const SLIDE = /\/relationships\/slide$/;
const NOTES = /\/relationships\/notesSlide$/;

/** Paragraphs of one slide or notes part: each <a:p> is a line, its <a:t> runs joined. Every character is counted as it arrives. */
function paragraphs(zip: ZipArchive, part: string, deadline: Deadline, warnings: Warnings, budget: TextBudget): string[] {
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
      else if ((name === "br" || name === "tab") && inParagraph) {
        budget.add(1);
        line += name === "br" ? "\n" : "\t";
      }
    } else if (event.type === "close") {
      if (name === "p" && --inParagraph === 0) {
        if (line.trim()) {
          budget.add(1);
          lines.push(line.trimEnd());
        }
      } else if (name === "t") inText--;
    } else if (inText > 0) {
      budget.add(event.text.length);
      line += event.text;
    }
  }, deadline, warnings);
  return lines;
}

/**
 * .pptx: slides in the order presentation.xml lists them, each slide's text
 * with its speaker notes (the first notes relationship only), and the
 * pictures in ppt/media. A slide or notes target outside the package, or
 * marked External, is never followed. No part is read twice in one import:
 * a slide listed twice, or notes shared between slides, are read once.
 * Text is counted as it is read, so the character limit refuses at once.
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
      // Refused as soon as the list passes the limit, not after reading all of it.
      if (order.length > MAX_SLIDES)
        throw new DocImportError("limit", `This presentation has more than ${MAX_SLIDES} slides. Nothing was imported.`);
    }
  }, deadline, warnings);

  const budget = new TextBudget(LABEL);
  // The parts already read count as visited: a slide or notes target naming one is not read again.
  const visited = new Set<string>([main, "ppt/_rels/presentation.xml.rels"]);
  let text = "";
  const sections: DocSection[] = [];
  let index = 0;
  for (const id of order) {
    deadline.check();
    const rel = rels.get(id);
    if (!rel || !SLIDE.test(rel.type) || !rel.target || !zip.entries.has(rel.target)) {
      if (rel?.external) warnings.add("A slide links to something outside the file; it was not followed.");
      else warnings.add("A slide listed by the presentation is missing and was skipped.");
      continue;
    }
    if (visited.has(rel.target)) {
      warnings.add("A slide listed twice (or naming a part already read) was read once.");
      continue;
    }
    visited.add(rel.target);
    index++;
    const lines = paragraphs(zip, rel.target, deadline, warnings, budget);
    const slideRels = [...relationships(zip, rel.target, LABEL, deadline, warnings).values()];
    if (slideRels.some((other) => other.external)) warnings.add("A slide links to something outside the file; it was not followed.");
    const notesRel = slideRels.find((other) => NOTES.test(other.type));
    if (notesRel?.target && zip.entries.has(notesRel.target) && !visited.has(notesRel.target)) {
      visited.add(notesRel.target);
      const notes = paragraphs(zip, notesRel.target, deadline, warnings, budget).filter((line) => !/^\d+$/.test(line.trim()));
      if (notes.length) {
        budget.add(8);
        lines.push("", "Notes:", ...notes);
      }
    }
    budget.add(2);
    if (text) text += "\n\n";
    const start = text.length;
    text += lines.join("\n");
    sections.push({ kind: "slide", index, title: lines.find((line) => line.trim())?.trim().slice(0, 200), start, end: text.length });
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
