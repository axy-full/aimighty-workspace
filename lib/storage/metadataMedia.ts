import { latin1, MalformedFileError, u32be, u32le, UnsupportedStructureError } from "./metadataBytes";

/*
 * Video and audio: MP4/MOV (ISO base media), WAV (RIFF) and MP3, rewritten in
 * pure TypeScript with no ffmpeg. The coded picture and sound (an MP4's mdat,
 * a WAV's data, an MP3's frames) are copied byte for byte and never decoded
 * or re-encoded. `marker` (an XMP packet) is written in the place the XMP
 * specification (Part 3) gives each format; null writes nothing.
 *
 * Not reached by any rewrite here, because it is inside the coded stream
 * rather than the container: an encoder's own note in the video bitstream (an
 * H.264/H.265 SEI "user data" message, where x264 writes its version and
 * settings) and the encoder name in an MP3's first (Xing/LAME) frame. Neither
 * `ffmpeg -map_metadata -1 -c copy` removes those either.
 */

/* ── MP4 / MOV ────────────────────────────────────────────────────────── */

type Box = { type: string; start: number; end: number; header: number };
/** Chunk-offset entries (stco or co64) inside a rebuilt box, as positions relative to that box's bytes. */
type Patch = { at: number; count: number; wide: boolean };
type Built = { bytes: Buffer; patches: Patch[] };

/** XMP's box in an MP4 (XMP Specification Part 3): a top-level uuid box with this id. */
const XMP_UUID = Buffer.from("be7acfcb97a942e89c71999491e3afac", "hex");
/** Boxes that only describe: user data (iTunes-style tags, encoder name, dates, places), meta (and its XMP and item data), uuid extensions (C2PA's and XMP's), padding. */
const DESCRIPTIVE = new Set(["udta", "meta", "uuid", "free", "skip", "wide"]);
/** Top-level boxes of a fragmented or segmented file; their absolute and relative offsets are not rewritten here. */
const FRAGMENTED = new Set(["moof", "mfra", "sidx", "ssix", "styp", "emsg", "prft"]);

function readBoxes(buf: Buffer, from: number, to: number, topLevel: boolean): Box[] {
  const boxes: Box[] = [];
  let pos = from;
  while (pos < to) {
    if (pos + 8 > to) throw new MalformedFileError("truncated box header");
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) throw new MalformedFileError("truncated box header");
      const large = buf.readBigUInt64BE(pos + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedFileError("box too large");
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      if (!topLevel) throw new MalformedFileError("open-ended box inside a container");
      size = to - pos;
    }
    if (size < header || pos + size > to) throw new MalformedFileError(`box ${JSON.stringify(type)} runs past its parent`);
    boxes.push({ type, start: pos, end: pos + size, header });
    pos += size;
  }
  return boxes;
}

const children = (buf: Buffer, box: Box) => readBoxes(buf, box.start + box.header, box.end, false);
const raw = (buf: Buffer, box: Box): Built => ({ bytes: Buffer.from(buf.subarray(box.start, box.end)), patches: [] });

function container(type: string, parts: Built[]): Built {
  let offset = 8;
  const patches: Patch[] = [];
  for (const part of parts) {
    for (const patch of part.patches) patches.push({ ...patch, at: patch.at + offset });
    offset += part.bytes.length;
  }
  return { bytes: Buffer.concat([u32be(offset), latin1(type), ...parts.map((part) => part.bytes)]), patches };
}

/** mvhd, tkhd, mdhd: the creation and modification times set to zero (the box keeps its size). */
function withoutTimes(buf: Buffer, box: Box): Built {
  const built = raw(buf, box);
  const at = box.header, version = built.bytes[at];
  const span = version === 1 ? 16 : 8;
  if (built.bytes.length < at + 4 + span) throw new MalformedFileError(`short ${box.type}`);
  built.bytes.fill(0, at + 4, at + 4 + span);
  return built;
}

const handlerType = (buf: Buffer, hdlr: Box): string => {
  if (hdlr.end - hdlr.start < hdlr.header + 24) throw new MalformedFileError("short hdlr");
  return buf.toString("latin1", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12);
};

/** hdlr keeps its handler type; its free-text name (often the muxer's or a vendor's) becomes empty. */
function neutralHandler(buf: Buffer, box: Box): Built {
  handlerType(buf, box);
  const fixed = buf.subarray(box.start + box.header, box.start + box.header + 24);
  return { bytes: Buffer.concat([u32be(8 + 24 + 1), latin1("hdlr"), fixed, Buffer.from([0])]), patches: [] };
}

/** The trak's handler type (vide, soun, meta, ...), read from mdia/hdlr. */
function trakHandler(buf: Buffer, trak: Box): string | null {
  const mdia = children(buf, trak).find((box) => box.type === "mdia");
  const hdlr = mdia && children(buf, mdia).find((box) => box.type === "hdlr");
  return hdlr ? handlerType(buf, hdlr) : null;
}

/** stsd: a visual entry's compressor name and the QuickTime vendor/quality fields, an audio entry's vendor field, zeroed in place. */
function cleanSampleDescriptions(buf: Buffer, box: Box, handler: string | null): Built {
  const built = raw(buf, box);
  const local = built.bytes;
  const first = box.header + 8;
  if (local.length < first) throw new MalformedFileError("short stsd");
  for (const entry of readBoxes(local, first, local.length, false)) {
    const size = entry.end - entry.start;
    if (handler === "vide" && size >= 86) { local.fill(0, entry.start + 16, entry.start + 32); local.fill(0, entry.start + 50, entry.start + 82); }
    if (handler === "soun" && size >= 28) local.fill(0, entry.start + 20, entry.start + 24);
  }
  return built;
}

function chunkOffsets(buf: Buffer, box: Box, wide: boolean): Built {
  const built = raw(buf, box);
  const at = box.header + 8;
  if (built.bytes.length < at) throw new MalformedFileError(`short ${box.type}`);
  const count = built.bytes.readUInt32BE(box.header + 4);
  if (at + count * (wide ? 8 : 4) > built.bytes.length) throw new MalformedFileError(`${box.type} entries run past the box`);
  return { bytes: built.bytes, patches: [{ at, count, wide }] };
}

function stbl(buf: Buffer, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(buf, box)) {
    if (child.type === "saio") throw new UnsupportedStructureError("sample auxiliary offsets (saio)");
    if (DESCRIPTIVE.has(child.type)) continue;
    if (child.type === "stsd") parts.push(cleanSampleDescriptions(buf, child, handler));
    else if (child.type === "stco") parts.push(chunkOffsets(buf, child, false));
    else if (child.type === "co64") parts.push(chunkOffsets(buf, child, true));
    else parts.push(raw(buf, child));
  }
  return container("stbl", parts);
}

function minf(buf: Buffer, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(buf, box)) {
    if (DESCRIPTIVE.has(child.type)) continue;
    if (child.type === "stbl") parts.push(stbl(buf, child, handler));
    else if (child.type === "hdlr") parts.push(neutralHandler(buf, child));
    else parts.push(raw(buf, child)); // vmhd, smhd, hmhd, nmhd, sthd, gmhd, dinf
  }
  return container("minf", parts);
}

function mdia(buf: Buffer, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(buf, box)) {
    if (child.type === "mdhd") parts.push(withoutTimes(buf, child));
    else if (child.type === "hdlr") parts.push(neutralHandler(buf, child));
    else if (child.type === "minf") parts.push(minf(buf, child, handler));
    else if (child.type === "elng") parts.push(raw(buf, child));
  }
  return container("mdia", parts);
}

const TRAK_STRUCTURE = new Set(["tref", "trgr", "edts", "tapt"]);
function trak(buf: Buffer, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(buf, box)) {
    if (child.type === "tkhd") parts.push(withoutTimes(buf, child));
    else if (child.type === "mdia") parts.push(mdia(buf, child, handler));
    else if (TRAK_STRUCTURE.has(child.type)) parts.push(raw(buf, child));
  }
  return container("trak", parts);
}

/** Where a track's samples lie in the file, chunk by chunk, from its own stsc, stsz and stco/co64. */
function chunkRanges(buf: Buffer, trak: Box): { start: number; length: number }[] {
  const find = (parent: Box | undefined, type: string) => parent && children(buf, parent).find((box) => box.type === type);
  const stbl = find(find(find(trak, "mdia"), "minf"), "stbl");
  const stsc = find(stbl, "stsc"), stsz = find(stbl, "stsz"), offsets = find(stbl, "stco") ?? find(stbl, "co64");
  if (!stsc || !stsz || !offsets) throw new UnsupportedStructureError("a timed-metadata track without plain sample tables");
  const wide = offsets.type === "co64";
  const read = (box: Box, at: number) => { if (box.start + at + 4 > box.end) throw new MalformedFileError(`short ${box.type}`); return buf.readUInt32BE(box.start + at); };
  const fixed = read(stsz, 12), samples = read(stsz, 16);
  const runs = Array.from({ length: read(stsc, 12) }, (_, i) => ({ first: read(stsc, 16 + i * 12), per: read(stsc, 20 + i * 12) }));
  const ranges: { start: number; length: number }[] = [];
  let sample = 0;
  for (let index = 0, count = read(offsets, 12); index < count; index++) {
    if (wide && offsets.start + 24 + index * 8 > offsets.end) throw new MalformedFileError("short co64");
    const start = wide ? Number(buf.readBigUInt64BE(offsets.start + 16 + index * 8)) : read(offsets, 16 + index * 4);
    const run = runs.filter((r) => r.first <= index + 1).at(-1);
    if (!run) throw new MalformedFileError("stsc does not cover chunk 1");
    let length = 0;
    for (let k = 0; k < run.per && sample < samples; k++, sample++) length += fixed || read(stsz, 20 + sample * 4);
    ranges.push({ start, length });
  }
  return ranges;
}

function moov(buf: Buffer, box: Box): Built & { blank: { start: number; length: number }[] } {
  const parts: Built[] = [];
  const blank: { start: number; length: number }[] = [];
  for (const child of children(buf, box)) {
    if (child.type === "mvex") throw new UnsupportedStructureError("fragmented MP4 (mvex)");
    if (child.type === "cmov") throw new UnsupportedStructureError("compressed movie header (cmov)");
    if (child.type === "mvhd") parts.push(withoutTimes(buf, child));
    else if (child.type === "trak") {
      const handler = trakHandler(buf, child);
      // A timed-metadata track: dropped whole, and its samples in mdat are blanked (zeroed) below.
      if (handler === "meta") { blank.push(...chunkRanges(buf, child)); continue; }
      parts.push(trak(buf, child, handler));
    } else if (child.type === "iods" || child.type === "pssh") parts.push(raw(buf, child));
  }
  return { ...container("moov", parts), blank };
}

/**
 * Removed: every top-level box but ftyp, moov and mdat (so uuid boxes,
 * C2PA's included, top-level meta, free/skip/wide padding); inside moov,
 * udta (title, artist, encoder, dates, places, iTunes-style ilst tags), meta,
 * uuid and padding at every level, timed-metadata tracks, and every box not
 * needed to play (moov keeps mvhd, trak, iods, pssh; trak keeps tkhd, tref,
 * trgr, edts, tapt, mdia). A timed-metadata track's samples, which sit in
 * mdat, are overwritten with zeros (mdat keeps its size). Neutralised in place: the creation and modification
 * times in mvhd/tkhd/mdhd (zero), handler names (empty), the compressor name
 * and QuickTime vendor fields of each sample description (zero).
 * Kept unchanged: ftyp, every mdat (but those zeroed samples), the sample
 * tables and codec configuration.
 * Chunk offsets (stco/co64) are rewritten for the new layout.
 * Refused (UnsupportedStructureError, file stored as delivered): fragmented
 * files, a compressed movie header, sample auxiliary offsets.
 */
export function cleanMp4(buf: Buffer, marker: Buffer | null): Buffer {
  const top = readBoxes(buf, 0, buf.length, true);
  if (top[0]?.type !== "ftyp") throw new MalformedFileError("ftyp is not first");
  if (top.some((box) => FRAGMENTED.has(box.type))) throw new UnsupportedStructureError("fragmented MP4");
  const movies = top.filter((box) => box.type === "moov");
  if (movies.length !== 1) throw new MalformedFileError(`${movies.length} moov boxes`);
  const movie = moov(buf, movies[0]);
  const markerBox = marker ? Buffer.concat([u32be(8 + 16 + marker.length), latin1("uuid"), XMP_UUID, marker]) : null;

  const pieces: Buffer[] = [];
  const media: { start: number; end: number; moved: number }[] = [];
  let length = 0;
  const put = (piece: Buffer) => { pieces.push(piece); length += piece.length; };
  for (const [index, box] of top.entries()) {
    if (index === 0) { put(buf.subarray(box.start, box.end)); if (markerBox) put(markerBox); }
    else if (box.type === "moov") put(movie.bytes);
    else if (box.type === "mdat") { media.push({ start: box.start, end: box.end, moved: length }); put(buf.subarray(box.start, box.end)); }
  }
  const relocate = (offset: number): number => {
    const holder = media.find((m) => offset >= m.start && offset <= m.end);
    if (!holder) throw new UnsupportedStructureError("a chunk offset outside the media data");
    return holder.moved + (offset - holder.start);
  };
  for (const patch of movie.patches) {
    for (let i = 0; i < patch.count; i++) {
      const at = patch.at + i * (patch.wide ? 8 : 4);
      if (patch.wide) {
        const value = movie.bytes.readBigUInt64BE(at);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedFileError("chunk offset too large");
        movie.bytes.writeBigUInt64BE(BigInt(relocate(Number(value))), at);
      } else {
        const moved = relocate(movie.bytes.readUInt32BE(at));
        if (moved > 0xffffffff) throw new UnsupportedStructureError("a 32-bit chunk offset past 4 GiB");
        movie.bytes.writeUInt32BE(moved, at);
      }
    }
  }
  const out = Buffer.concat(pieces, length);
  for (const range of movie.blank) {
    if (range.length === 0) continue;
    const start = relocate(range.start);
    if (relocate(range.start + range.length) - start !== range.length) throw new UnsupportedStructureError("a timed-metadata chunk across media boxes");
    out.fill(0, start, start + range.length);
  }
  return out;
}

/* ── WAV ──────────────────────────────────────────────────────────────── */

const WAV_AUDIO_CHUNKS = new Set(["fmt ", "fact", "data"]);

/**
 * Removed: every chunk but fmt, fact and data (so LIST/INFO tags, id3/ID3,
 * bext broadcast metadata, iXML, axml, _PMX XMP, cue points and labels, smpl,
 * inst, acid, cart, umid, JUNK/PAD); anything past the RIFF length.
 * Kept unchanged: fmt, fact and the sample data. RF64/BW64 files are not
 * recognised as WAV and are stored as delivered.
 */
export function cleanWav(buf: Buffer, marker: Buffer | null): Buffer {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") throw new MalformedFileError("not RIFF/WAVE");
  const end = 8 + buf.readUInt32LE(4);
  if (end > buf.length) throw new MalformedFileError("RIFF length runs past the file");
  const parts: Buffer[] = [];
  let pos = 12, sawFormat = false, sawData = false;
  while (pos + 8 <= end) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (pos + 8 + size > end) throw new MalformedFileError(`chunk ${JSON.stringify(id)} runs past the file`);
    if (WAV_AUDIO_CHUNKS.has(id)) {
      parts.push(buf.subarray(pos, pos + 8 + size));
      if (size & 1) parts.push(Buffer.from([0]));
      if (id === "data") sawData = true;
    }
    if (id === "fmt ") {
      sawFormat = true;
      if (marker) parts.push(latin1("_PMX"), u32le(marker.length), marker, ...(marker.length & 1 ? [Buffer.from([0])] : []));
    }
    pos += 8 + size + (size & 1);
  }
  if (!sawFormat || !sawData) throw new MalformedFileError("no fmt or data chunk");
  const body = Buffer.concat(parts);
  return Buffer.concat([latin1("RIFF"), u32le(4 + body.length), latin1("WAVE"), body]);
}

/* ── MP3 ──────────────────────────────────────────────────────────────── */

const syncsafe = (buf: Buffer, at: number) => ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14) | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);
const toSyncsafe = (n: number) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);

/** An ID3v2.3 tag holding one PRIV frame owned by "XMP", the place XMP Part 3 gives MP3. */
function id3Marker(marker: Buffer): Buffer {
  const body = Buffer.concat([latin1("XMP\0"), marker]);
  const frame = Buffer.concat([latin1("PRIV"), u32be(body.length), Buffer.from([0, 0]), body]);
  return Buffer.concat([latin1("ID3"), Buffer.from([3, 0, 0]), toSyncsafe(frame.length), frame]);
}

/**
 * Removed: every ID3v2 tag at the start (with its pictures, comments, encoder
 * and C2PA GEOB frames), and at the end any ID3v1 (and Enhanced TAG+), APEv2,
 * appended ID3v2.4 and Lyrics3v2 tag. Kept unchanged: the MPEG frames.
 */
export function cleanMp3(buf: Buffer, marker: Buffer | null): Buffer {
  let start = 0;
  while (start + 10 <= buf.length && buf.toString("latin1", start, start + 3) === "ID3") {
    start += 10 + syncsafe(buf, start + 6) + (buf[start + 5] & 0x10 ? 10 : 0);
  }
  if (start > buf.length) throw new MalformedFileError("ID3v2 tag runs past the file");
  let end = buf.length;
  for (let trimmed = true; trimmed;) {
    trimmed = false;
    const left = end - start;
    if (left >= 128 && buf.toString("latin1", end - 128, end - 125) === "TAG") {
      end -= 128;
      if (end - start >= 227 && buf.toString("latin1", end - 227, end - 223) === "TAG+") end -= 227;
      trimmed = true;
    } else if (left >= 32 && buf.toString("latin1", end - 32, end - 24) === "APETAGEX") {
      const total = buf.readUInt32LE(end - 20) + (buf.readUInt32LE(end - 12) & 0x80000000 ? 32 : 0);
      if (total < 32 || total > left) throw new MalformedFileError("APE tag runs past the file");
      end -= total;
      trimmed = true;
    } else if (left >= 10 && buf.toString("latin1", end - 10, end - 7) === "3DI") {
      const total = syncsafe(buf, end - 4) + 20;
      if (total > left) throw new MalformedFileError("appended ID3v2 tag runs past the file");
      end -= total;
      trimmed = true;
    } else if (left >= 15 && buf.toString("latin1", end - 9, end) === "LYRICS200") {
      const size = Number(buf.toString("latin1", end - 15, end - 9));
      if (!Number.isInteger(size) || size + 15 > left) throw new MalformedFileError("Lyrics3 tag runs past the file");
      end -= size + 15;
      trimmed = true;
    }
  }
  if (end - start < 4 || buf[start] !== 0xff || (buf[start + 1] & 0xe0) !== 0xe0) throw new MalformedFileError("no MPEG frame after the tags");
  return Buffer.concat([...(marker ? [id3Marker(marker)] : []), buf.subarray(start, end)]);
}
