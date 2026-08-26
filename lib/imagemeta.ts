/**
 * Image identification WITHOUT DECODING.
 *
 * This file deliberately contains no image library, no canvas, no resize and no
 * re-encode. It reads a few header bytes to learn the format and pixel
 * dimensions, and never touches the pixel data. The bytes we store are byte-for-
 * byte the bytes that were uploaded — see `docs` in README and the sha256 check
 * in the upload route.
 */

export type ImageMeta = {
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
};

const ascii = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString("latin1");

export function identifyImage(buf: Buffer): ImageMeta | null {
  if (buf.length < 16) return null;

  // ── PNG ──────────────────────────────────────────────────────────────
  if (buf[0] === 0x89 && ascii(buf, 1, 3) === "PNG") {
    // IHDR is always the first chunk: length(4) type(4) then w(4) h(4)
    return { mime: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // ── GIF ──────────────────────────────────────────────────────────────
  if (ascii(buf, 0, 3) === "GIF") {
    return { mime: "image/gif", ext: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // ── BMP ──────────────────────────────────────────────────────────────
  if (ascii(buf, 0, 2) === "BM") {
    return {
      mime: "image/bmp", ext: "bmp",
      width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)),
    };
  }

  // ── WEBP ─────────────────────────────────────────────────────────────
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") {
    const chunk = ascii(buf, 12, 4);
    if (chunk === "VP8X") {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { mime: "image/webp", ext: "webp", width: w, height: h };
    }
    if (chunk === "VP8 ") {
      return {
        mime: "image/webp", ext: "webp",
        width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return {
        mime: "image/webp", ext: "webp",
        width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1,
      };
    }
    return { mime: "image/webp", ext: "webp", width: null, height: null };
  }

  // ── TIFF ─────────────────────────────────────────────────────────────
  const le = ascii(buf, 0, 2) === "II" && buf[2] === 0x2a;
  const be = ascii(buf, 0, 2) === "MM" && buf[3] === 0x2a;
  if (le || be) {
    const meta: ImageMeta = { mime: "image/tiff", ext: "tiff", width: null, height: null };
    try {
      const ifd = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
      const n = le ? buf.readUInt16LE(ifd) : buf.readUInt16BE(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
        const type = le ? buf.readUInt16LE(e + 2) : buf.readUInt16BE(e + 2);
        if (tag !== 256 && tag !== 257) continue;
        const v = type === 3
          ? (le ? buf.readUInt16LE(e + 8) : buf.readUInt16BE(e + 8))
          : (le ? buf.readUInt32LE(e + 8) : buf.readUInt32BE(e + 8));
        if (tag === 256) meta.width = v; else meta.height = v;
      }
    } catch { /* dimensions stay null; the file is still stored untouched */ }
    return meta;
  }

  // ── HEIC / HEIF ──────────────────────────────────────────────────────
  if (ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4);
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      // ispe parsing needs a full box walk; not worth it — dimensions stay unknown.
      const heif = brand === "mif1" || brand === "msf1";
      return {
        mime: heif ? "image/heif" : "image/heic",
        ext: heif ? "heif" : "heic",
        width: null, height: null,
      };
    }
  }

  // ── JPEG ─────────────────────────────────────────────────────────────
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry the frame dimensions.
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return {
          mime: "image/jpeg", ext: "jpg",
          height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7),
        };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
    return { mime: "image/jpeg", ext: "jpg", width: null, height: null };
  }

  return null;
}

/* ── ModelArk's documented limits for a single input image ─────────────── */
export const IMAGE_LIMITS = {
  maxBytes: 30 * 1024 * 1024,
  minSide: 300,
  maxSide: 6000,
  minRatio: 0.4,
  maxRatio: 2.5,
  /** Whole JSON request body, base64 included. */
  maxRequestBytes: 64 * 1024 * 1024,
};

export function validateImage(meta: ImageMeta, bytes: number): string | null {
  if (bytes > IMAGE_LIMITS.maxBytes) {
    return `Image is ${(bytes / 1048576).toFixed(1)} MB — ModelArk's limit is 30 MB.`;
  }
  const { width: w, height: h } = meta;
  if (w == null || h == null) return null; // unknown dims (heic/tiff) — let Ark decide

  if (w < IMAGE_LIMITS.minSide || h < IMAGE_LIMITS.minSide) {
    return `${w}×${h} is below ModelArk's 300px minimum.`;
  }
  if (w > IMAGE_LIMITS.maxSide || h > IMAGE_LIMITS.maxSide) {
    return `${w}×${h} exceeds ModelArk's 6000px maximum.`;
  }
  const ratio = w / h;
  if (ratio < IMAGE_LIMITS.minRatio || ratio > IMAGE_LIMITS.maxRatio) {
    return `Aspect ratio ${ratio.toFixed(2)} is outside ModelArk's accepted 0.4–2.5.`;
  }
  return null;
}
