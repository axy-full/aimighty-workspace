import { latin1, MalformedFileError, PartBudget, u32be, u32le, UnsupportedStructureError, UnverifiedRewriteError } from "./metadataBytes";

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
 *
 * Every walk is bounded: at most MAX_PARTS boxes or chunks per rewrite, and
 * no step is worse than linear (or n log n) in the size of the tables.
 */

/* ── MP4 / MOV ────────────────────────────────────────────────────────── */

type Box = { type: string; start: number; end: number; header: number };
/** Chunk-offset entries (stco or co64) inside a rebuilt box, as positions relative to that box's bytes. */
type Patch = { at: number; count: number; wide: boolean };
type Built = { bytes: Buffer; patches: Patch[] };
type Range = { start: number; length: number };
/** One rewrite's input and its walk budget. */
type Ctx = { buf: Buffer; budget: PartBudget };

/** XMP's box in an MP4 (XMP Specification Part 3): a top-level uuid box with this id. */
const XMP_UUID = Buffer.from("be7acfcb97a942e89c71999491e3afac", "hex");
/** Boxes that only describe: user data (iTunes-style tags, encoder name, dates, places), meta (and its XMP and item data), uuid extensions (C2PA's and XMP's), padding. */
const DESCRIPTIVE = new Set(["udta", "meta", "uuid", "free", "skip", "wide"]);
/** Top-level boxes of a fragmented or segmented file; their absolute and relative offsets are not rewritten here. */
const FRAGMENTED = new Set(["moof", "mfra", "sidx", "ssix", "styp", "emsg", "prft"]);

function readBoxes(ctx: Ctx, from: number, to: number, topLevel: boolean, buf: Buffer = ctx.buf): Box[] {
  const boxes: Box[] = [];
  let pos = from;
  while (pos < to) {
    ctx.budget.take("MP4 boxes");
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

const children = (ctx: Ctx, box: Box) => readBoxes(ctx, box.start + box.header, box.end, false);
const childOf = (ctx: Ctx, box: Box | undefined, type: string) => box && children(ctx, box).find((b) => b.type === type);
const raw = (ctx: Ctx, box: Box): Built => ({ bytes: Buffer.from(ctx.buf.subarray(box.start, box.end)), patches: [] });

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
function withoutTimes(ctx: Ctx, box: Box): Built {
  const built = raw(ctx, box);
  const at = box.header, version = built.bytes[at];
  const span = version === 1 ? 16 : 8;
  if (built.bytes.length < at + 4 + span) throw new MalformedFileError(`short ${box.type}`);
  built.bytes.fill(0, at + 4, at + 4 + span);
  return built;
}

const handlerType = (ctx: Ctx, hdlr: Box): string => {
  if (hdlr.end - hdlr.start < hdlr.header + 24) throw new MalformedFileError("short hdlr");
  return ctx.buf.toString("latin1", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12);
};

/** hdlr keeps its handler type; its free-text name (often the muxer's or a vendor's) becomes empty. */
function neutralHandler(ctx: Ctx, box: Box): Built {
  handlerType(ctx, box);
  const fixed = ctx.buf.subarray(box.start + box.header, box.start + box.header + 24);
  return { bytes: Buffer.concat([u32be(8 + 24 + 1), latin1("hdlr"), fixed, Buffer.from([0])]), patches: [] };
}

/** The trak's handler type (vide, soun, meta, ...), read from mdia/hdlr. */
function trakHandler(ctx: Ctx, trak: Box): string | null {
  const hdlr = childOf(ctx, childOf(ctx, trak, "mdia"), "hdlr");
  return hdlr ? handlerType(ctx, hdlr) : null;
}

/**
 * Where a track's samples lie, chunk by chunk, from its own stsc, stsz (or
 * stz2) and stco/co64, in the coordinates of `ctx.buf`. Linear in the table
 * sizes: the stsc runs are walked with one pointer, and a fixed sample size
 * is multiplied, never summed sample by sample.
 */
function chunkRanges(ctx: Ctx, trak: Box): Range[] {
  const { buf } = ctx;
  const stbl = childOf(ctx, childOf(ctx, childOf(ctx, trak, "mdia"), "minf"), "stbl");
  const tables = stbl ? children(ctx, stbl) : [];
  const find = (type: string) => tables.find((b) => b.type === type);
  const stsc = find("stsc"), sizes = find("stsz") ?? find("stz2"), offsets = find("stco") ?? find("co64");
  if (!stsc || !sizes || !offsets) throw new UnsupportedStructureError("a track without plain sample tables");
  const u32 = (box: Box, at: number) => {
    if (box.start + at + 4 > box.end) throw new MalformedFileError(`short ${box.type}`);
    return buf.readUInt32BE(box.start + at);
  };
  /* Sample sizes: stsz (a fixed size, or one u32 each) or stz2 (4, 8 or 16 bits each). */
  let fixed = 0, sampleCount: number, sizeAt: (i: number) => number;
  if (sizes.type === "stsz") {
    fixed = u32(sizes, 12); sampleCount = u32(sizes, 16);
    if (!fixed && sizes.start + 20 + sampleCount * 4 > sizes.end) throw new MalformedFileError("stsz entries run past the box");
    sizeAt = (i) => buf.readUInt32BE(sizes.start + 20 + i * 4);
  } else {
    const field = buf[sizes.start + 15];
    sampleCount = u32(sizes, 16);
    if (![4, 8, 16].includes(field) || sizes.start + 20 + Math.ceil((sampleCount * field) / 8) > sizes.end) throw new MalformedFileError("bad stz2");
    sizeAt = field === 16 ? (i) => buf.readUInt16BE(sizes.start + 20 + i * 2)
      : field === 8 ? (i) => buf[sizes.start + 20 + i]
      : (i) => (buf[sizes.start + 20 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 0x0f;
  }
  const runCount = u32(stsc, 12);
  if (stsc.start + 16 + runCount * 12 > stsc.end) throw new MalformedFileError("stsc entries run past the box");
  const runFirst = (r: number) => buf.readUInt32BE(stsc.start + 16 + r * 12);
  const runPer = (r: number) => buf.readUInt32BE(stsc.start + 20 + r * 12);
  const wide = offsets.type === "co64";
  const chunkCount = u32(offsets, 12);
  if (offsets.start + 16 + chunkCount * (wide ? 8 : 4) > offsets.end) throw new MalformedFileError(`${offsets.type} entries run past the box`);
  if (chunkCount > 0 && (runCount === 0 || runFirst(0) !== 1)) throw new MalformedFileError("stsc does not start at chunk 1");
  const ranges: Range[] = [];
  const chunkBudget = new PartBudget();
  let run = 0, sample = 0;
  for (let index = 0; index < chunkCount; index++) {
    chunkBudget.take("chunks in one MP4 track");
    while (run + 1 < runCount && runFirst(run + 1) <= index + 1) {
      if (runFirst(run + 1) <= runFirst(run)) throw new MalformedFileError("stsc runs out of order");
      run++;
    }
    const start = wide ? Number(buf.readBigUInt64BE(offsets.start + 16 + index * 8)) : buf.readUInt32BE(offsets.start + 16 + index * 4);
    const count = Math.min(runPer(run), Math.max(0, sampleCount - sample));
    let length = 0;
    if (fixed) length = fixed * count;
    else for (let k = 0; k < count; k++) length += sizeAt(sample + k);
    sample += count;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start + length > buf.length) throw new MalformedFileError("a chunk runs past the file");
    ranges.push({ start, length });
  }
  return ranges;
}

/** stsd: a visual entry's compressor name and the QuickTime vendor/quality fields, an audio entry's vendor field, zeroed in place. */
function cleanSampleDescriptions(ctx: Ctx, box: Box, handler: string | null): Built {
  const built = raw(ctx, box);
  const local = built.bytes;
  const first = box.header + 8;
  if (local.length < first) throw new MalformedFileError("short stsd");
  for (const entry of readBoxes(ctx, first, local.length, false, local)) {
    const size = entry.end - entry.start;
    if (handler === "vide" && size >= 86) { local.fill(0, entry.start + 16, entry.start + 32); local.fill(0, entry.start + 50, entry.start + 82); }
    if (handler === "soun" && size >= 28) local.fill(0, entry.start + 20, entry.start + 24);
  }
  return built;
}

function chunkOffsets(ctx: Ctx, box: Box, wide: boolean): Built {
  const built = raw(ctx, box);
  const at = box.header + 8;
  if (built.bytes.length < at) throw new MalformedFileError(`short ${box.type}`);
  const count = built.bytes.readUInt32BE(box.header + 4);
  if (at + count * (wide ? 8 : 4) > built.bytes.length) throw new MalformedFileError(`${box.type} entries run past the box`);
  return { bytes: built.bytes, patches: [{ at, count, wide }] };
}

function stbl(ctx: Ctx, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(ctx, box)) {
    if (child.type === "saio") throw new UnsupportedStructureError("sample auxiliary offsets (saio)");
    if (DESCRIPTIVE.has(child.type)) continue;
    if (child.type === "stsd") parts.push(cleanSampleDescriptions(ctx, child, handler));
    else if (child.type === "stco") parts.push(chunkOffsets(ctx, child, false));
    else if (child.type === "co64") parts.push(chunkOffsets(ctx, child, true));
    else parts.push(raw(ctx, child));
  }
  return container("stbl", parts);
}

function minf(ctx: Ctx, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(ctx, box)) {
    if (DESCRIPTIVE.has(child.type)) continue;
    if (child.type === "stbl") parts.push(stbl(ctx, child, handler));
    else if (child.type === "hdlr") parts.push(neutralHandler(ctx, child));
    else parts.push(raw(ctx, child)); // vmhd, smhd, hmhd, nmhd, sthd, gmhd, dinf
  }
  return container("minf", parts);
}

function mdia(ctx: Ctx, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(ctx, box)) {
    if (child.type === "mdhd") parts.push(withoutTimes(ctx, child));
    else if (child.type === "hdlr") parts.push(neutralHandler(ctx, child));
    else if (child.type === "minf") parts.push(minf(ctx, child, handler));
    else if (child.type === "elng") parts.push(raw(ctx, child));
  }
  return container("mdia", parts);
}

const TRAK_STRUCTURE = new Set(["tref", "trgr", "edts", "tapt"]);
function trak(ctx: Ctx, box: Box, handler: string | null): Built {
  const parts: Built[] = [];
  for (const child of children(ctx, box)) {
    if (child.type === "tkhd") parts.push(withoutTimes(ctx, child));
    else if (child.type === "mdia") parts.push(mdia(ctx, child, handler));
    else if (TRAK_STRUCTURE.has(child.type)) parts.push(raw(ctx, child));
  }
  return container("trak", parts);
}

type Movie = Built & { kept: Range[][]; blank: Range[] };
function moov(ctx: Ctx, box: Box): Movie {
  const parts: Built[] = [];
  const kept: Range[][] = [], blank: Range[] = [];
  for (const child of children(ctx, box)) {
    if (child.type === "mvex") throw new UnsupportedStructureError("fragmented MP4 (mvex)");
    if (child.type === "cmov") throw new UnsupportedStructureError("compressed movie header (cmov)");
    if (child.type === "mvhd") parts.push(withoutTimes(ctx, child));
    else if (child.type === "trak") {
      const handler = trakHandler(ctx, child);
      // A timed-metadata track: dropped whole, and its samples in mdat are blanked (zeroed) in cleanMp4.
      if (handler === "meta") { blank.push(...chunkRanges(ctx, child)); continue; }
      kept.push(chunkRanges(ctx, child));
      parts.push(trak(ctx, child, handler));
    } else if (child.type === "iods" || child.type === "pssh") parts.push(raw(ctx, child));
  }
  return { ...container("moov", parts), kept, blank };
}

/** The kept tracks of a rewritten file, read back through its own tables. */
function readBack(out: Buffer): Range[][] {
  const ctx: Ctx = { buf: out, budget: new PartBudget() };
  const movie = readBoxes(ctx, 0, out.length, true).find((b) => b.type === "moov");
  if (!movie) throw new UnverifiedRewriteError("no moov in the rewrite");
  return children(ctx, movie).filter((b) => b.type === "trak").map((t) => chunkRanges(ctx, t));
}

/**
 * Removed: every top-level box but ftyp, moov and mdat (so uuid boxes,
 * C2PA's included, top-level meta, free/skip/wide padding); inside moov,
 * udta (title, artist, encoder, dates, places, iTunes-style ilst tags), meta,
 * uuid and padding at every level, timed-metadata tracks, and every box not
 * needed to play (moov keeps mvhd, trak, iods, pssh; trak keeps tkhd, tref,
 * trgr, edts, tapt, mdia). A timed-metadata track's samples, which sit in
 * mdat, are overwritten with zeros (mdat keeps its size). Neutralised
 * in place: the creation and modification times in mvhd/tkhd/mdhd (zero),
 * handler names (empty), the compressor name and QuickTime vendor fields of
 * each sample description (zero).
 * Kept unchanged: ftyp, every mdat (but those zeroed samples), the sample
 * tables and codec configuration. Chunk offsets (stco/co64) are rewritten for
 * the new layout, and the result is read back: every kept track's every chunk
 * must hold the same bytes as in the delivered file, or the rewrite is thrown
 * away (UnverifiedRewriteError, file stored as delivered).
 * Refused (UnsupportedStructureError, file stored as delivered): fragmented
 * files, a compressed movie header, sample auxiliary offsets, a track without
 * plain sample tables, a zeroed range that would touch a kept track's samples
 * or an mdat header, more than MAX_PARTS boxes or chunks.
 */
export function cleanMp4(buf: Buffer, marker: Buffer | null): Buffer {
  const ctx: Ctx = { buf, budget: new PartBudget() };
  const top = readBoxes(ctx, 0, buf.length, true);
  if (top[0]?.type !== "ftyp") throw new MalformedFileError("ftyp is not first");
  if (top.some((box) => FRAGMENTED.has(box.type))) throw new UnsupportedStructureError("fragmented MP4");
  const movies = top.filter((box) => box.type === "moov");
  if (movies.length !== 1) throw new MalformedFileError(`${movies.length} moov boxes`);
  const movie = moov(ctx, movies[0]);
  const markerBox = marker ? Buffer.concat([u32be(8 + 16 + marker.length), latin1("uuid"), XMP_UUID, marker]) : null;

  const pieces: Buffer[] = [];
  /** Each mdat's payload in the delivered file and where it lands in the rewrite, in file order (so sorted). */
  const media: { start: number; end: number; moved: number }[] = [];
  let length = 0;
  const put = (piece: Buffer) => { pieces.push(piece); length += piece.length; };
  for (const [index, box] of top.entries()) {
    if (index === 0) { put(buf.subarray(box.start, box.end)); if (markerBox) put(markerBox); }
    else if (box.type === "moov") put(movie.bytes);
    else if (box.type === "mdat") { media.push({ start: box.start + box.header, end: box.end, moved: length + box.header }); put(buf.subarray(box.start, box.end)); }
  }
  /** The mdat payload holding this offset (binary search), or undefined. */
  const holderOf = (offset: number) => {
    let low = 0, high = media.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (offset < media[mid].start) high = mid - 1;
      else if (offset > media[mid].end) low = mid + 1;
      else return media[mid];
    }
    return undefined;
  };
  const relocate = (offset: number): number => {
    const holder = holderOf(offset);
    if (!holder) throw new UnsupportedStructureError("a chunk offset outside the media data");
    return holder.moved + (offset - holder.start);
  };

  /* A blanked range must lie inside one mdat payload and touch no kept sample. */
  const keptSorted = movie.kept.flat().filter((r) => r.length > 0).sort((a, b) => a.start - b.start);
  /** furthest[i]: the furthest end of any kept range among the first i+1 by start. */
  const furthest: number[] = [];
  for (const [i, r] of keptSorted.entries()) furthest.push(Math.max(i ? furthest[i - 1] : 0, r.start + r.length));
  for (const range of movie.blank) {
    if (range.length === 0) continue;
    const end = range.start + range.length;
    const holder = holderOf(range.start);
    if (!holder || end > holder.end) throw new UnsupportedStructureError("a timed-metadata chunk outside one media box");
    let low = 0, high = keptSorted.length; // how many kept ranges start before this one ends
    while (low < high) { const mid = (low + high) >> 1; if (keptSorted[mid].start < end) low = mid + 1; else high = mid; }
    if (low > 0 && furthest[low - 1] > range.start) throw new UnsupportedStructureError("a timed-metadata chunk overlaps a kept track");
  }

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
  pieces.length = 0;
  for (const range of movie.blank) if (range.length > 0) out.fill(0, relocate(range.start), relocate(range.start) + range.length);

  /* Read the rewrite back: the same kept tracks, chunk for chunk, byte for byte. */
  const after = readBack(out);
  if (after.length !== movie.kept.length) throw new UnverifiedRewriteError("track count changed");
  for (const [t, chunks] of movie.kept.entries()) {
    if (after[t].length !== chunks.length) throw new UnverifiedRewriteError("chunk count changed");
    for (const [c, range] of chunks.entries()) {
      const moved = after[t][c];
      if (moved.length !== range.length || !out.subarray(moved.start, moved.start + moved.length).equals(buf.subarray(range.start, range.start + range.length)))
        throw new UnverifiedRewriteError("a chunk does not read back the same");
    }
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
  const budget = new PartBudget();
  while (pos + 8 <= end) {
    budget.take("WAV chunks");
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
  const budget = new PartBudget();
  while (start + 10 <= buf.length && buf.toString("latin1", start, start + 3) === "ID3") {
    budget.take("MP3 tags");
    start += 10 + syncsafe(buf, start + 6) + (buf[start + 5] & 0x10 ? 10 : 0);
  }
  if (start > buf.length) throw new MalformedFileError("ID3v2 tag runs past the file");
  let end = buf.length;
  for (let trimmed = true; trimmed;) {
    budget.take("MP3 tags");
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
