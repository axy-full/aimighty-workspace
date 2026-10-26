import { crc32, latin1, MalformedFileError, PartBudget, u16be, u32be } from "./metadataBytes";

/*
 * Stills: JPEG and PNG, rewritten segment by segment / chunk by chunk. The
 * compressed picture data is copied byte for byte and never decoded, so the
 * pixels are exactly the vendor's. What is kept is what a decoder needs to
 * draw the picture, plus the colour profile (dropping it would change how the
 * colours look); everything else goes. `marker` (an XMP packet) is written in
 * the place the XMP specification gives each format; null writes nothing.
 */

/* ── JPEG ─────────────────────────────────────────────────────────────── */

const XMP_APP1_ID = latin1("http://ns.adobe.com/xap/1.0/\0");

/** APPn segments that carry colour, not description: the ICC profile (APP2) and Adobe's colour-transform flag (APP14). */
function colourAppSegment(marker: number, segment: Buffer): boolean {
  const body = segment.subarray(4);
  if (marker === 0xe2) return body.subarray(0, 12).equals(latin1("ICC_PROFILE\0"));
  if (marker === 0xee) return body.subarray(0, 5).equals(latin1("Adobe"));
  return false;
}

/**
 * Removed: every APPn segment (JFIF/JFXX thumbnails, EXIF, XMP and extended
 * XMP, IPTC/Photoshop IRB, MPF and its gain-map or second image, JUMBF/C2PA in
 * APP11, maker data) except the ICC profile and the Adobe colour-transform
 * segment; every COM comment; anything after the end-of-image marker.
 * Kept: the frame, tables, scans and restart markers, unchanged.
 */
export function cleanJpeg(bytes: Buffer, marker: Buffer | null): Buffer {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MalformedFileError("no JPEG start marker");
  const out: Buffer[] = [bytes.subarray(0, 2)];
  if (marker) {
    const body = Buffer.concat([XMP_APP1_ID, marker]);
    if (body.length + 2 > 0xffff) throw new MalformedFileError("marker too large for one segment");
    out.push(Buffer.from([0xff, 0xe1]), u16be(body.length + 2), body);
  }
  let pos = 2;
  const budget = new PartBudget();
  for (;;) {
    budget.take("JPEG segments");
    if (pos + 1 >= bytes.length) throw new MalformedFileError("no end-of-image marker");
    if (bytes[pos] !== 0xff) throw new MalformedFileError("expected a marker");
    while (pos + 1 < bytes.length && bytes[pos + 1] === 0xff) pos++; // fill bytes before a marker
    if (pos + 1 >= bytes.length) throw new MalformedFileError("no end-of-image marker");
    const code = bytes[pos + 1];
    if (code === 0xd9) { out.push(bytes.subarray(pos, pos + 2)); break; } // EOI; trailing bytes are dropped
    if (code === 0xd8) throw new MalformedFileError("second start marker");
    if (code === 0x00) throw new MalformedFileError("stuffed byte outside a scan");
    if ((code >= 0xd0 && code <= 0xd7) || code === 0x01) { out.push(bytes.subarray(pos, pos + 2)); pos += 2; continue; }
    if (pos + 4 > bytes.length) throw new MalformedFileError("truncated segment");
    const length = bytes.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > bytes.length) throw new MalformedFileError("segment runs past the file");
    const segment = bytes.subarray(pos, pos + 2 + length);
    const isApp = code >= 0xe0 && code <= 0xef;
    const isComment = code === 0xfe;
    if (!(isApp || isComment) || (isApp && colourAppSegment(code, segment))) out.push(segment);
    pos += 2 + length;
    if (code === 0xda) {
      // Entropy-coded data runs to the next marker that is neither a stuffed 0xFF00 nor a restart marker.
      const start = pos;
      while (pos + 1 < bytes.length && !(bytes[pos] === 0xff && bytes[pos + 1] !== 0x00 && !(bytes[pos + 1] >= 0xd0 && bytes[pos + 1] <= 0xd7))) pos++;
      if (pos + 1 >= bytes.length) throw new MalformedFileError("scan runs past the file");
      out.push(bytes.subarray(start, pos));
    }
  }
  return Buffer.concat(out);
}

/* ── PNG ──────────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ancillary chunks a decoder needs to draw the picture as made: transparency, colour, HDR levels, animation. */
const PNG_RENDERING_CHUNKS = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "mDCV", "cLLI", "sBIT", "acTL", "fcTL", "fdAT"]);

function pngChunk(type: string, data: Buffer): Buffer {
  const name = latin1(type);
  return Buffer.concat([u32be(data.length), name, data, u32be(crc32(name, data))]);
}

/**
 * Removed: every ancillary chunk that is not in PNG_RENDERING_CHUNKS, which
 * covers tEXt, zTXt and iTXt (XMP is an iTXt), eXIf, tIME, pHYs, bKGD, hIST,
 * sPLT, the C2PA caBX chunk and every private chunk; anything after IEND.
 * Kept: IHDR, PLTE, IDAT, IEND, any other critical chunk, and the rendering
 * chunks, unchanged (their CRCs included).
 */
export function cleanPng(bytes: Buffer, marker: Buffer | null): Buffer {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new MalformedFileError("no PNG signature");
  const out: Buffer[] = [PNG_SIGNATURE];
  let pos = 8, ended = false, first = true;
  const budget = new PartBudget();
  while (pos < bytes.length) {
    budget.take("PNG chunks");
    if (pos + 12 > bytes.length) throw new MalformedFileError("truncated chunk");
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString("latin1", pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new MalformedFileError("bad chunk type");
    const end = pos + 12 + length;
    if (end > bytes.length) throw new MalformedFileError("chunk runs past the file");
    if (first && type !== "IHDR") throw new MalformedFileError("IHDR is not first");
    first = false;
    const critical = type.charCodeAt(0) < 0x61; // upper-case first letter
    if (critical || PNG_RENDERING_CHUNKS.has(type)) out.push(bytes.subarray(pos, end));
    if (type === "IHDR" && marker) {
      // iTXt: keyword, NUL, compression flag 0, method 0, empty language tag, NUL, empty translated keyword, NUL, text.
      out.push(pngChunk("iTXt", Buffer.concat([latin1("XML:com.adobe.xmp\0"), Buffer.from([0, 0, 0, 0]), marker])));
    }
    pos = end;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended) throw new MalformedFileError("no IEND chunk");
  return Buffer.concat(out);
}
