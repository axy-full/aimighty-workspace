import { MAX_CELLS, MAX_COLUMNS, MAX_SHEETS, MAX_TEXT_CHARS } from "./limits";
import { mediaImages, openOffice, relationships, scanPart } from "./ooxml";
import { DocImportError, type Deadline, type DocSection, type ExtractedDocument, type Warnings } from "./types";
import { attr, localName } from "./xml";
import type { ZipArchive } from "./zip";

const LABEL = "This workbook";
const WORKSHEET = /\/relationships\/worksheet$/;

/** Shared strings: each <si>'s text runs joined, phonetic guides (<rPh>) left out. */
function sharedStrings(zip: ZipArchive, part: string | null, deadline: Deadline, warnings: Warnings): string[] {
  if (!part || !zip.entries.has(part)) return [];
  const out: string[] = [];
  let current = "";
  let inItem = false;
  let inPhonetic = 0;
  let inText = 0;
  scanPart(zip, part, LABEL, (event) => {
    if (event.type === "text") {
      if (inItem && inText && !inPhonetic) current += event.text;
      return;
    }
    const name = localName(event.name);
    if (event.type === "open") {
      if (name === "si") {
        inItem = true;
        current = "";
      } else if (name === "rPh") inPhonetic++;
      else if (name === "t") inText++;
    } else if (name === "si") {
      inItem = false;
      out.push(current);
      if (out.length > MAX_CELLS)
        throw new DocImportError("limit", `This workbook has more than ${MAX_CELLS} cells. Nothing was imported.`);
    } else if (name === "rPh") inPhonetic--;
    else if (name === "t") inText--;
  }, deadline, warnings);
  return out;
}

/** "BC12" → 54 (0-based column), or -1. */
function columnOf(reference: string | undefined): number {
  const letters = /^([A-Z]{1,3})\d*$/.exec(reference ?? "")?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * .xlsx: sheets in workbook order, each as tab-separated rows of the values
 * Excel last calculated (formulas are never evaluated), and the pictures in
 * xl/media. Limits: MAX_SHEETS sheets, MAX_CELLS cells, MAX_COLUMNS columns.
 */
export async function extractXlsx(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const zip = openOffice("xlsx", bytes);
  const main = "xl/workbook.xml";
  const rels = relationships(zip, main, LABEL, deadline, warnings);
  const sheets: { name: string; rid: string; hidden: boolean }[] = [];
  scanPart(zip, main, LABEL, (event) => {
    if (event.type !== "open" || localName(event.name) !== "sheet") return;
    const key = Object.keys(event.attrs).find((name) => name.includes(":") && localName(name) === "id");
    sheets.push({
      name: (attr(event.attrs, "name") ?? "").slice(0, 100),
      rid: key ? event.attrs[key] : "",
      hidden: (attr(event.attrs, "state") ?? "visible") !== "visible",
    });
  }, deadline, warnings);
  if (sheets.length > MAX_SHEETS)
    throw new DocImportError("limit", `This workbook has ${sheets.length} sheets; the import limit is ${MAX_SHEETS}. Nothing was imported.`);
  const sharedPart = [...rels.values()].find((rel) => /\/relationships\/sharedStrings$/.test(rel.type))?.target ?? null;
  const shared = sharedStrings(zip, sharedPart, deadline, warnings);

  let cells = 0;
  let text = "";
  const sections: DocSection[] = [];
  let index = 0;
  for (const sheet of sheets) {
    deadline.check();
    const rel = rels.get(sheet.rid);
    if (!rel || !WORKSHEET.test(rel.type) || !rel.target || !zip.entries.has(rel.target)) {
      if (rel && !WORKSHEET.test(rel.type)) warnings.add(`"${sheet.name}" is a chart or macro sheet; it has no cells to read.`);
      else warnings.add(`A sheet listed by the workbook is missing and was skipped.`);
      continue;
    }
    if (sheet.hidden) warnings.add(`"${sheet.name}" is a hidden sheet; its cells were read too.`);
    index++;
    const rows: string[] = [];
    let row: string[] = [];
    let cell: { column: number; type: string; value: string; inline: string } | null = null;
    let inValue = 0;
    let inInline = 0;
    let wide = false;
    scanPart(zip, rel.target, LABEL, (event) => {
      if (event.type === "text") {
        if (!cell) return;
        if (inValue) cell.value += event.text;
        else if (inInline) cell.inline += event.text;
        return;
      }
      const name = localName(event.name);
      if (event.type === "open") {
        if (name === "row") row = [];
        else if (name === "c") {
          if (++cells > MAX_CELLS)
            throw new DocImportError("limit", `This workbook has more than ${MAX_CELLS} cells. Nothing was imported.`);
          cell = { column: columnOf(attr(event.attrs, "r")), type: attr(event.attrs, "t") ?? "n", value: "", inline: "" };
        } else if (name === "v" && cell) inValue++;
        else if (name === "t" && cell && cell.type === "inlineStr") inInline++;
        return;
      }
      if (name === "v") inValue = Math.max(0, inValue - 1);
      else if (name === "t") inInline = Math.max(0, inInline - 1);
      else if (name === "c" && cell) {
        const value =
          cell.type === "s" ? (shared[Number(cell.value)] ?? "")
          : cell.type === "inlineStr" ? cell.inline
          : cell.type === "b" ? (cell.value === "1" ? "TRUE" : "FALSE")
          : cell.value;
        const column = cell.column < 0 ? row.length : cell.column;
        if (column >= MAX_COLUMNS) wide = true;
        else if (value !== "") {
          while (row.length < column) row.push("");
          row[column] = value.replace(/[\t\r\n]+/g, " ");
        }
        cell = null;
      } else if (name === "row") {
        if (row.some((value) => value !== "")) rows.push(row.join("\t").trimEnd());
      }
    }, deadline, warnings);
    if (wide) warnings.add(`"${sheet.name}" has cells past column ${MAX_COLUMNS}; those were skipped.`);
    if (text) text += "\n\n";
    const start = text.length;
    text += rows.join("\n");
    sections.push({ kind: "sheet", index, title: sheet.name || `Sheet ${index}`, start, end: text.length });
    if (text.length > MAX_TEXT_CHARS)
      throw new DocImportError("limit", "This workbook has more than one million characters of text. Nothing was imported.");
  }
  return {
    kind: "xlsx",
    format: "plain",
    text,
    sections,
    images: mediaImages(zip, "xl/media/", deadline, warnings),
    warnings: [],
  };
}
