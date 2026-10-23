import { identifyImage } from "../imagemeta";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_TOTAL_BYTES, MAX_XML_PART_BYTES } from "./limits";
import { DocImportError, type Deadline, type ExtractedImage, type Warnings } from "./types";
import { attr, decodeXmlBytes, localName, scanXml, type XmlEvent } from "./xml";
import { openZip, resolvePartPath, zipDir, type ZipArchive } from "./zip";
import { OFFICE_MAIN_PART } from "./detect";

/**
 * What .docx, .pptx and .xlsx share: the package is opened with the bounded
 * zip reader, its main part must exist (so a deck renamed .docx is caught),
 * every XML part is read with the DTD-free scanner, relationships are
 * resolved inside the package only (an External target is never followed),
 * and embedded pictures are typed from their bytes.
 */

export type OfficeKind = "docx" | "pptx" | "xlsx";

const LABEL: Record<OfficeKind, string> = {
  docx: "This Word document",
  pptx: "This presentation",
  xlsx: "This workbook",
};

const NAME_OF: Record<OfficeKind, string> = { docx: "a Word document", pptx: "a presentation", xlsx: "a workbook" };

export function openOffice(kind: OfficeKind, bytes: Buffer): ZipArchive {
  const label = LABEL[kind];
  const zip = openZip(bytes, label);
  if (!zip.entries.has("[Content_Types].xml") || !zip.entries.has(OFFICE_MAIN_PART[kind])) {
    const real = (Object.keys(OFFICE_MAIN_PART) as OfficeKind[]).find((other) => zip.entries.has(OFFICE_MAIN_PART[other]));
    throw new DocImportError(
      "type_mismatch",
      `This file is named .${kind} but ${real ? `it is ${NAME_OF[real]}` : "it is not an Office document"}. Nothing was imported.`,
    );
  }
  return zip;
}

/** One XML part as text. Office parts never carry a DOCTYPE, so one is refused outright. */
export function partText(zip: ZipArchive, name: string, label: string): string {
  const text = decodeXmlBytes(zip.read(name, MAX_XML_PART_BYTES), label);
  if (/<!doctype|<!entity/i.test(text))
    throw new DocImportError("unsafe", `${label} declares a document type, which the importer does not read. Nothing was imported.`);
  return text;
}

export function scanPart(
  zip: ZipArchive,
  name: string,
  label: string,
  onEvent: (event: XmlEvent) => void,
  deadline: Deadline,
  warnings: Warnings,
) {
  deadline.check();
  const result = scanXml(partText(zip, name, label), onEvent, { doctype: "refuse", label, deadline });
  if (result.unknownEntities)
    warnings.add(`${label} uses ${result.unknownEntities} unknown character references; they were kept as written.`);
}

export type Relationship = { id: string; type: string; target: string | null; external: boolean };

/** A part's relationships (`_rels/<part>.rels`), each target resolved inside the package or null. */
export function relationships(zip: ZipArchive, part: string, label: string, deadline: Deadline, warnings: Warnings): Map<string, Relationship> {
  const dir = zipDir(part);
  const rels = `${dir ? dir + "/" : ""}_rels/${part.slice(dir ? dir.length + 1 : 0)}.rels`;
  const out = new Map<string, Relationship>();
  if (!zip.entries.has(rels)) return out;
  scanPart(zip, rels, label, (event) => {
    if (event.type !== "open" || localName(event.name) !== "Relationship") return;
    const id = attr(event.attrs, "Id") ?? "";
    const external = (attr(event.attrs, "TargetMode") ?? "").toLowerCase() === "external";
    const rawTarget = attr(event.attrs, "Target") ?? "";
    out.set(id, {
      id,
      type: attr(event.attrs, "Type") ?? "",
      external,
      target: external ? null : resolvePartPath(dir, rawTarget),
    });
  }, deadline, warnings);
  return out;
}

/** Text of every element with this local name, one string per element. */
export function textOf(zip: ZipArchive, part: string, label: string, element: string, deadline: Deadline, warnings: Warnings): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  scanPart(zip, part, label, (event) => {
    if (event.type === "open" && localName(event.name) === element) {
      if (depth++ === 0) current = "";
    } else if (event.type === "close" && localName(event.name) === element) {
      if (--depth === 0) out.push(current);
    } else if (event.type === "text" && depth > 0) current += event.text;
  }, deadline, warnings);
  return out;
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

/**
 * Pictures under the package's media folder (word/media, ppt/media,
 * xl/media), typed from their bytes. A format the importer does not list
 * (EMF, WMF, video) is counted in a warning, never guessed.
 */
export function mediaImages(zip: ZipArchive, folder: string, deadline: Deadline, warnings: Warnings): ExtractedImage[] {
  const names = [...zip.entries.keys()].filter((name) => name.startsWith(folder) && !name.endsWith("/")).sort();
  const images: ExtractedImage[] = [];
  let skipped = 0;
  let kept = 0;
  for (const name of names) {
    deadline.check();
    const entry = zip.entries.get(name)!;
    if (entry.size > MAX_IMAGE_BYTES) {
      warnings.add(`An embedded picture larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB was skipped.`);
      continue;
    }
    if (images.length >= MAX_IMAGES || kept + entry.size > MAX_IMAGES_TOTAL_BYTES) {
      warnings.add(`Only the first ${images.length} embedded pictures were kept.`);
      break;
    }
    const bytes = zip.read(name, MAX_IMAGE_BYTES);
    const meta = identifyImage(bytes);
    const ext = meta ? IMAGE_EXT[meta.mime] : undefined;
    if (!meta || !ext) {
      skipped++;
      continue;
    }
    images.push({ name: name.slice(name.lastIndexOf("/") + 1).slice(0, 120), mime: meta.mime, ext, bytes });
    kept += bytes.length;
  }
  if (skipped) warnings.add(`${skipped} embedded files are in formats the importer does not keep (for example EMF or video).`);
  return images;
}
