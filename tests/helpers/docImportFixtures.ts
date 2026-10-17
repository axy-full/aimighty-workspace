/**
 * Synthetic documents for the importer's unit specs, built in memory: no
 * real client document is ever a fixture. Includes a zip writer that can
 * lie (declared sizes, overlapping data, encryption flags) so the zip-bomb
 * defences can be tested against the exact shapes they refuse. Test helper only.
 */
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

export type ZipInput = {
  name: string;
  data: Buffer | string;
  /** 0 stored, 8 deflate (default). */
  method?: 0 | 8;
  /** Write this uncompressed size in the central directory instead of the real one. */
  declaredSize?: number;
  /** Extra general-purpose flags (0x1 marks the entry encrypted). */
  flags?: number;
};

type Written = { name: Buffer; method: number; flags: number; crc: number; csize: number; size: number; offset: number };

function localRecord(name: Buffer, method: number, flags: number, crc: number, csize: number, size: number) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(csize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function centralRecord(entry: Written) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.flags | 0x800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.csize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endRecord(count: number, cdSize: number, cdOffset: number) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  return end;
}

export function zip(inputs: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const written: Written[] = [];
  let offset = 0;
  for (const input of inputs) {
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, "utf8");
    const method = input.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(input.name, "utf8");
    const entry: Written = {
      name,
      method,
      flags: input.flags ?? 0,
      crc: crc32(raw),
      csize: body.length,
      size: input.declaredSize ?? raw.length,
      offset,
    };
    const local = localRecord(name, method, entry.flags, entry.crc, entry.csize, entry.size);
    parts.push(local, body);
    offset += local.length + body.length;
    written.push(entry);
  }
  const central = Buffer.concat(written.map(centralRecord));
  return Buffer.concat([...parts, central, endRecord(written.length, central.length, offset)]);
}

/**
 * Two directory entries whose data is the same bytes: entry "inner" lives
 * inside the stored data of entry "outer". The shape of the non-recursive
 * "overlapping files" zip bomb.
 */
export function overlappingZip(outerName: string, innerName: string, innerData: string): Buffer {
  const innerRaw = Buffer.from(innerData, "utf8");
  const innerBody = deflateRawSync(innerRaw);
  const innerNameBytes = Buffer.from(innerName, "utf8");
  const innerLocal = Buffer.concat([localRecord(innerNameBytes, 8, 0, crc32(innerRaw), innerBody.length, innerRaw.length), innerBody]);
  const outerNameBytes = Buffer.from(outerName, "utf8");
  const outerLocal = localRecord(outerNameBytes, 0, 0, crc32(innerLocal), innerLocal.length, innerLocal.length);
  const outer: Written = { name: outerNameBytes, method: 0, flags: 0, crc: crc32(innerLocal), csize: innerLocal.length, size: innerLocal.length, offset: 0 };
  const inner: Written = { name: innerNameBytes, method: 8, flags: 0, crc: crc32(innerRaw), csize: innerBody.length, size: innerRaw.length, offset: outerLocal.length };
  const data = Buffer.concat([outerLocal, innerLocal]);
  const central = Buffer.concat([centralRecord(outer), centralRecord(inner)]);
  return Buffer.concat([data, central, endRecord(2, central.length, data.length)]);
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

/** A minimal .docx. `documentXml` replaces the generated body when given (for hostile parts). */
export function docx(paragraphs: string[], options: { image?: Buffer; documentXml?: string; extra?: ZipInput[] } = {}): Buffer {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`).join("");
  const drawing = options.image
    ? `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    : "";
  const document = options.documentXml ?? xml(`<w:document ${W}><w:body>${body}${drawing}</w:body></w:document>`);
  return zip([
    {
      name: "[Content_Types].xml",
      data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    },
    { name: "_rels/.rels", data: xml(`<Relationships ${PKG_REL}><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: document },
    {
      name: "word/_rels/document.xml.rels",
      data: xml(`<Relationships ${PKG_REL}>${options.image ? `<Relationship Id="rIdImg" Type="${REL}/image" Target="media/image1.png"/>` : ""}</Relationships>`),
    },
    ...(options.image ? [{ name: "word/media/image1.png", data: options.image, method: 0 as const }] : []),
    ...(options.extra ?? []),
  ]);
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** A minimal .pptx: slides of paragraphs, optional speaker notes, optional pictures in ppt/media. */
export function pptx(slides: { paragraphs: string[]; notes?: string[] }[], options: { images?: { name: string; data: Buffer }[]; slideXml?: string } = {}): Buffer {
  const entries: ZipInput[] = [
    { name: "[Content_Types].xml", data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: "_rels/.rels", data: xml(`<Relationships ${PKG_REL}><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`) },
    {
      name: "ppt/presentation.xml",
      data: xml(`<p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: xml(`<Relationships ${PKG_REL}>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`),
    },
  ];
  const para = (text: string) => `<a:p><a:r><a:t>${esc(text)}</a:t></a:r></a:p>`;
  slides.forEach((slide, i) => {
    entries.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: i === 0 && options.slideXml ? options.slideXml : xml(`<p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody>${slide.paragraphs.map(para).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    });
    const rels = [
      ...(slide.notes ? [`<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`] : []),
      ...(options.images ?? []).map((image, n) => `<Relationship Id="rIdI${n}" Type="${REL}/image" Target="../media/${image.name}"/>`),
    ];
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: xml(`<Relationships ${PKG_REL}>${rels.join("")}</Relationships>`) });
    if (slide.notes)
      entries.push({
        name: `ppt/notesSlides/notesSlide${i + 1}.xml`,
        data: xml(`<p:notes ${P}><p:cSld><p:spTree><p:sp><p:txBody>${slide.notes.map(para).join("")}${para(String(i + 1))}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`),
      });
  });
  for (const image of options.images ?? []) entries.push({ name: `ppt/media/${image.name}`, data: image.data, method: 0 });
  return zip(entries);
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A minimal .xlsx: string cells go through sharedStrings, numbers inline. */
export function xlsx(sheets: { name: string; rows: (string | number)[][]; hidden?: boolean }[], options: { sharedStringsXml?: string } = {}): Buffer {
  const shared: string[] = [];
  const indexOf = (text: string) => {
    const at = shared.indexOf(text);
    if (at !== -1) return at;
    shared.push(text);
    return shared.length - 1;
  };
  const col = (n: number) => {
    let s = "";
    for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const sheetXml = sheets.map((sheet) =>
    xml(`<worksheet ${S}><sheetData>${sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) =>
      typeof value === "number"
        ? `<c r="${col(c)}${r + 1}"><v>${value}</v></c>`
        : value === "" ? "" : `<c r="${col(c)}${r + 1}" t="s"><v>${indexOf(value)}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`),
  );
  return zip([
    { name: "[Content_Types].xml", data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: "_rels/.rels", data: xml(`<Relationships ${PKG_REL}><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    {
      name: "xl/workbook.xml",
      data: xml(`<workbook ${S}><sheets>${sheets.map((sheet, i) => `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"${sheet.hidden ? ' state="hidden"' : ""}/>`).join("")}</sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: xml(`<Relationships ${PKG_REL}>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    {
      name: "xl/sharedStrings.xml",
      data: options.sharedStringsXml ?? xml(`<sst ${S} count="${shared.length}" uniqueCount="${shared.length}">${shared.map((text) => `<si><t>${esc(text)}</t></si>`).join("")}</sst>`),
    },
  ]);
}

/** A Final Draft file from raw <Paragraph> markup. */
export const fdx = (content: string, prolog = "") =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n${prolog}<FinalDraft DocumentType="Script" Template="No" Version="5"><Content>${content}</Content><TitlePage><Content><Paragraph><Text>TITLE PAGE TEXT</Text></Paragraph></Content></TitlePage></FinalDraft>`, "utf8");

export const para = (type: string, text: string, attrs = "") => `<Paragraph Type="${type}"${attrs}><Text>${esc(text)}</Text></Paragraph>`;

/** A PDF with one line of Helvetica text per page, xref offsets computed. */
export function pdf(pages: string[]): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/([\\()])/g, "\\$1")}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const FONT: Record<string, string[]> = {
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A greyscale PNG of block capitals (H E L O W R D and space), large enough for OCR. */
export function textPng(text: string, scale = 6): Buffer {
  const cell = 6;
  const width = (text.length * cell + 4) * scale;
  const height = 11 * scale;
  const pixels = Buffer.alloc(width * height, 255);
  [...text].forEach((ch, i) =>
    FONT[ch].forEach((row, y) =>
      [...row].forEach((bit, x) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) pixels[((y + 2) * scale + dy) * width + (i * cell + x + 2) * scale + dx] = 0;
      }),
    ),
  );
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  return pngFrom(width, height, deflateSync(raw));
}

/** A PNG header that declares any size, with a token pixel stream: the "pixel bomb" shape. */
export function declaredPng(width: number, height: number): Buffer {
  return pngFrom(width, height, deflateSync(Buffer.alloc(16)));
}

function pngFrom(width: number, height: number, idat: Buffer) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An uncompressed little-endian greyscale TIFF of the given size (white). */
export function tiff(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height, 255);
  const tags: [number, number, number, number][] = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, 8],
    [277, 3, 1, 1],
    [278, 3, 1, height],
    [279, 4, 1, pixels.length],
  ];
  const ifdOffset = 8 + pixels.length;
  const ifd = Buffer.alloc(2 + tags.length * 12 + 4);
  ifd.writeUInt16LE(tags.length, 0);
  tags.forEach(([tag, type, count, value], i) => {
    const at = 2 + i * 12;
    ifd.writeUInt16LE(tag, at);
    ifd.writeUInt16LE(type, at + 2);
    ifd.writeUInt32LE(count, at + 4);
    if (type === 3) ifd.writeUInt16LE(value, at + 8);
    else ifd.writeUInt32LE(value, at + 8);
  });
  const head = Buffer.alloc(8);
  head.write("II", 0, "latin1");
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdOffset, 4);
  return Buffer.concat([head, pixels, ifd]);
}
