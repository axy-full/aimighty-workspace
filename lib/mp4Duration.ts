/**
 * The length of an MP4 in seconds, read from its container header alone (`moov` > `mvhd`: a timescale and a duration). No decoder, no files: it is handed the bytes
 * and reads a few dozen of them. Used to settle a vendor's clip at what it measures rather than at what was asked for (lib/veoVideo.ts). Null for anything it
 * cannot read with certainty: a missing or truncated header, a zero timescale, a length that is not a sensible clip length. A caller then keeps the quote.
 */
const MAX_SECONDS = 3600;

function boxes(buf: Buffer, from: number, to: number): { type: string; start: number; end: number; body: number }[] {
  const out: { type: string; start: number; end: number; body: number }[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      const big = buf.readBigUInt64BE(at + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return out;
}

export function mp4DurationSeconds(buf: Buffer): number | null {
  try {
    const moov = boxes(buf, 0, buf.length).find((b) => b.type === "moov");
    if (!moov) return null;
    const mvhd = boxes(buf, moov.body, moov.end).find((b) => b.type === "mvhd");
    if (!mvhd) return null;
    const v = mvhd.body;
    if (v + 4 > mvhd.end) return null;
    const version = buf[v];
    let timescale: number, duration: number;
    if (version === 0) {
      if (v + 20 > mvhd.end) return null;
      timescale = buf.readUInt32BE(v + 12);
      duration = buf.readUInt32BE(v + 16);
    } else if (version === 1) {
      if (v + 32 > mvhd.end) return null;
      timescale = buf.readUInt32BE(v + 20);
      const big = buf.readBigUInt64BE(v + 24);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      duration = Number(big);
    } else return null;
    if (!timescale || !duration) return null;
    const seconds = duration / timescale;
    return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS ? Math.round(seconds * 1000) / 1000 : null;
  } catch {
    return null;
  }
}
