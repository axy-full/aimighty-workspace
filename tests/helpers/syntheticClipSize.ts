import { readFileSync } from "node:fs";

/**
 * A SYNTHETIC test clip: the 1.5 s fixture (tests/fixtures/astra-source.mp4, 720×1280) with only the picture size in its header
 * rewritten, so a reader of the header (lib/videoMetadata.server.ts) measures `width`×`height`. Its frames are not re-encoded;
 * it exists to test a decision made on the measured size (a source already at 4K), never to be played. Nothing is stored on disk.
 */
export function syntheticClipOfSize(width: number, height: number): Buffer {
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 0xffff)) throw new Error("A whole picture size up to 65535.");
  const clip = Buffer.from(readFileSync("tests/fixtures/astra-source.mp4"));
  /* The visual sample entry inside stsd: width and height are the two 16-bit fields 24 bytes after its header. */
  const entry = clip.indexOf("avc1", clip.indexOf("stsd"));
  if (entry < 0) throw new Error("The fixture has no avc1 sample entry.");
  clip.writeUInt16BE(width, entry + 28);
  clip.writeUInt16BE(height, entry + 30);
  /* The track header's presentation size: two 16.16 fixed-point fields at the end of tkhd. */
  const tkhd = clip.indexOf("tkhd");
  const end = tkhd - 4 + clip.readUInt32BE(tkhd - 4);
  clip.writeUInt32BE(width * 65536, end - 8);
  clip.writeUInt32BE(height * 65536, end - 4);
  return clip;
}
