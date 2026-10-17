import { MAX_TEXT_CHARS } from "./limits";
import { DocImportError, type Deadline, type ExtractedDocument, type Warnings } from "./types";
import { decodeXmlBytes, localName, scanXml } from "./xml";

/**
 * An SVG's <text> nodes, and nothing else. The file is only ever read as
 * text by the DTD-free scanner: it is never rendered, so <script>, event
 * attributes, <foreignObject>, CSS, <image href>, <use href> and external
 * references are never executed or followed; their content is not even
 * collected. A DOCTYPE is stepped over unread (editors write one), so a
 * declared entity is never expanded: `&xxe;` stays the five characters it is.
 */

/** Elements whose content is never collected, even inside <text>. */
const IGNORED = new Set(["script", "style", "foreignObject", "title", "desc", "metadata"]);

export async function extractSvg(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const label = "This SVG";
  const source = decodeXmlBytes(bytes, label);
  const lines: string[] = [];
  let inText = 0;
  let ignored = 0;
  let line = "";
  const result = scanXml(source, (event) => {
    if (event.type === "text") {
      if (inText && !ignored) line += event.text;
      return;
    }
    const name = localName(event.name);
    if (event.type === "open") {
      if (IGNORED.has(name)) ignored++;
      else if (name === "text") {
        if (inText++ === 0) line = "";
      } else if (name === "tspan" && inText && line && !/\s$/.test(line)) line += " ";
      return;
    }
    if (IGNORED.has(name)) ignored = Math.max(0, ignored - 1);
    else if (name === "text" && --inText === 0) {
      const clean = line.replace(/\s+/g, " ").trim();
      if (clean) lines.push(clean);
    }
  }, { doctype: "skip", label, deadline });
  if (localName(result.root) !== "svg")
    throw new DocImportError("type_mismatch", "This file is named .svg but it is not an SVG image. Nothing was imported.");
  if (result.skippedDoctype) warnings.add("This SVG declares a document type; it was not read.");
  if (result.unknownEntities)
    warnings.add(`This SVG uses ${result.unknownEntities} entity references the importer does not expand; they were kept as written.`);
  const text = lines.join("\n");
  if (text.length > MAX_TEXT_CHARS)
    throw new DocImportError("limit", "This SVG has more than one million characters of text. Nothing was imported.");
  if (!text) warnings.add("This SVG has no text nodes. Text converted to outlines cannot be read.");
  return {
    kind: "svg",
    format: "plain",
    text,
    sections: [{ kind: "image", index: 1, start: 0, end: text.length }],
    images: [],
    warnings: [],
  };
}
