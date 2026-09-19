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
  // ISO BMFF with an audio-only brand (M4A / M4B); other brands are video (lib/imagemeta.ts).
  if (ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4);
    if (brand === "M4A " || brand === "M4B ") return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
  }
  return null;
}

/** File extensions the bounded inspector can read (mp3, wav, m4a/aac, plus mp4/mov audio tracks). */
export const INSPECTABLE_AUDIO_EXTS = new Set(["mp3", "wav", "wave", "m4a", "aac", "mp4", "m4b", "mov"]);
export const isAudioMime = (mime: string | null | undefined) => /^audio\//i.test(String(mime ?? ""));
