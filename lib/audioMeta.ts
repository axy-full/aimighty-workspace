/**
 * Audio identification WITHOUT DECODING — the sound counterpart of
 * lib/imagemeta.ts. A few header bytes say what container an upload is;
 * nothing here reads the samples, and the bytes stored are the bytes that
 * arrived. The duration is NOT read here: MP3 and AAC lengths live in the
 * frames, so they are measured by the bounded inspector
 * (lib/mediaSource.server.ts), never guessed from a header.
 */
export type AudioMeta = { kind: "audio"; mime: string; ext: string };

const ascii = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString("latin1");

export function identifyAudio(buf: Buffer): AudioMeta | null {
  if (buf.length < 12) return null;
  // RIFF····WAVE
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE")
    return { kind: "audio", mime: "audio/wav", ext: "wav" };
  // ID3v2 tag, or a bare MPEG audio frame sync (0xFFE…, layer bits set).
  if (ascii(buf, 0, 3) === "ID3") return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  if (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2 && (buf[1] & 0x06) !== 0)
    return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  // ADTS AAC: sync 0xFFF with layer 00.
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return { kind: "audio", mime: "audio/aac", ext: "aac" };
  // ISO BMFF that carries sound and no picture; any other is video (lib/imagemeta.ts).
  if (mp4SoundOnly(buf)) return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
  return null;
}

const SOUND_BRANDS = new Set(["M4A ", "M4B ", "M4P "]);

/**
 * An MPEG-4 container with sound and no picture: an audio-only brand (an
 * .m4a, an iPhone voice memo, an .m4b book), or a generic isom/mp42 brand
 * (many Android recorders) whose movie header, when it is in these bytes,
 * lists sound tracks and no video track. A movie header written after the
 * media is out of reach here, so that file keeps the video answer.
 */
export function mp4SoundOnly(buf: Buffer): boolean {
  if (buf.length < 12 || ascii(buf, 4, 4) !== "ftyp") return false;
  if (SOUND_BRANDS.has(ascii(buf, 8, 4))) return true;
  try {
    const moov = boxes(buf, 0, buf.length).find((b) => b.type === "moov");
    if (!moov) return false;
    const handlers = boxes(buf, moov.start, moov.end)
      .filter((b) => b.type === "trak")
      .map((trak) => {
        const mdia = boxes(buf, trak.start, trak.end).find((b) => b.type === "mdia");
        const hdlr = mdia && boxes(buf, mdia.start, mdia.end).find((b) => b.type === "hdlr");
        // hdlr: version and flags, pre_defined, then the handler type.
        return hdlr && hdlr.start + 12 <= hdlr.end ? ascii(buf, hdlr.start + 8, 4) : "";
      });
    return handlers.includes("soun") && !handlers.includes("vide");
  } catch {
    return false;
  }
}

/** The boxes directly inside [start, end); stops at one that runs past the end, so a truncated header reads as absent. */
function boxes(buf: Buffer, start: number, end: number): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off), header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    out.push({ type: ascii(buf, off + 4, 4), start: off + header, end: off + size });
    off += size;
  }
  return out;
}

/** File extensions the bounded inspector can read (mp3, wav, m4a/aac, plus mp4/mov audio tracks). */
export const INSPECTABLE_AUDIO_EXTS = new Set(["mp3", "wav", "wave", "m4a", "aac", "mp4", "m4b", "mov"]);
export const isAudioMime = (mime: string | null | undefined) => /^audio\//i.test(String(mime ?? ""));
