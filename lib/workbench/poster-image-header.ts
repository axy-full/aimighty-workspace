/** Bounded browser-safe header inspection before allocating any image bitmap.
 * This reads source metadata only. It never resizes or replaces an original. */
export type PosterImageHeader = {
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/avif";
};
export const POSTER_IMAGE_PIXELS = 40_000_000;
const MAX_RECORDS = 4096;
function invalid(): never {
  throw new Error(
    "This original has unsupported or unreadable image dimensions. Use a JPEG, PNG, WebP or AVIF still image.",
  );
}
function animated(): never {
  throw new Error(
    "Animated or multi-image originals are not supported in poster layers. Choose a still image.",
  );
}

export function inspectPosterImageHeader(
  bytes: Uint8Array,
  remainingPixels = POSTER_IMAGE_PIXELS,
): PosterImageHeader {
  if (
    !Number.isSafeInteger(remainingPixels) ||
    remainingPixels < 1 ||
    remainingPixels > POSTER_IMAGE_PIXELS
  )
    throw new Error(
      "This design exceeds the 40-megapixel reference budget. Use fewer image layers or smaller reference copies.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fits = (at: number, length: number, end = bytes.length) =>
    Number.isSafeInteger(at) &&
    Number.isSafeInteger(length) &&
    at >= 0 &&
    length >= 0 &&
    at <= end - length;
  const text = (at: number, length: number) => {
    if (!fits(at, length)) return "";
    let result = "";
    for (let i = at; i < at + length; i++)
      result += String.fromCharCode(bytes[i]);
    return result;
  };
  const dimensions = (
    width: number,
    height: number,
    mime: PosterImageHeader["mime"],
  ): PosterImageHeader => {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1
    )
      return invalid();
    if (width > remainingPixels / height)
      throw new Error(
        "This design exceeds the 40-megapixel reference budget. Use fewer image layers or smaller reference copies; originals remain in the library.",
      );
    return { width, height, mime };
  };

  /** MPF (CIPA DC-007) index: only multi-frame types (panorama, stereo
   * disparity, multi-angle) are a set of pictures. Gain maps and large
   * thumbnails are auxiliary images; createImageBitmap decodes the primary. */
  const declaresMultiFrame = (start: number, end: number) => {
    const order = text(start, 4),
      little = order === "II*\0";
    if (!little && order !== "MM\0*") return false;
    const u16 = (at: number) => view.getUint16(at, little),
      u32 = (at: number) => view.getUint32(at, little);
    if (!fits(start + 4, 4, end)) return false;
    const ifd = start + u32(start + 4);
    if (!fits(ifd, 2, end)) return false;
    const entries = u16(ifd);
    for (let i = 0; i < entries; i++) {
      const entry = ifd + 2 + i * 12;
      if (!fits(entry, 12, end)) return false;
      if (u16(entry) !== 0xb002) continue;
      const length = u32(entry + 4),
        first = length <= 4 ? entry + 8 : start + u32(entry + 8);
      if (length % 16 || length / 16 > MAX_RECORDS || !fits(first, length, end))
        return false;
      for (let at = first; at < first + length; at += 16)
        if (((u32(at) >>> 16) & 0xff) === 0x02) return true;
    }
    return false;
  };

  if (text(0, 8) === "\x89PNG\r\n\x1a\n") {
    let at = 8,
      count = 0,
      result: PosterImageHeader | undefined,
      data = false;
    while (fits(at, 12)) {
      if (++count > MAX_RECORDS) return invalid();
      const size = view.getUint32(at),
        type = text(at + 4, 4);
      if (!fits(at + 12, size)) return invalid();
      if (type === "acTL" || type === "fcTL" || type === "fdAT")
        return animated();
      if (type === "IHDR") {
        if (at !== 8 || size !== 13 || result) return invalid();
        result = dimensions(
          view.getUint32(at + 8),
          view.getUint32(at + 12),
          "image/png",
        );
      } else if (!result) return invalid();
      if (type === "IDAT") data = true;
      at += size + 12;
      // Bytes after IEND are ignored by every decoder (and by createImageBitmap).
      if (type === "IEND")
        return size === 0 && data && result ? result : invalid();
    }
    return invalid();
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2,
      count = 0,
      scanned = false,
      result: PosterImageHeader | undefined;
    while (fits(at, 2)) {
      if (++count > MAX_RECORDS || bytes[at++] !== 0xff) return invalid();
      while (bytes[at] === 0xff) at++;
      if (!fits(at, 1)) return invalid();
      const marker = bytes[at++];
      if (marker === 0x01) continue;
      // The primary image ends at its EOI. Anything after it (an Ultra HDR
      // gain map, a maker trailer) is never decoded by createImageBitmap.
      if (marker === 0xd9) return scanned && result ? result : invalid();
      if (
        marker === 0 ||
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        !fits(at, 2)
      )
        return invalid();
      const size = view.getUint16(at);
      if (size < 2 || !fits(at, size)) return invalid();
      if (
        marker === 0xe2 &&
        text(at + 2, 4) === "MPF\0" &&
        declaresMultiFrame(at + 6, at + size)
      )
        return animated();
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (
          ![0xc0, 0xc1, 0xc2].includes(marker) ||
          result ||
          size < 8 ||
          size !== 8 + bytes[at + 7] * 3
        )
          return invalid();
        result = dimensions(
          view.getUint16(at + 5),
          view.getUint16(at + 3),
          "image/jpeg",
        );
      }
      at += size;
      if (marker === 0xda) {
        if (!result || size < 6) return invalid();
        scanned = true;
        // Skip entropy-coded data: 0xFF is followed by a stuffed 0x00, a
        // restart marker or fill bytes until the next real marker.
        for (;;) {
          at = bytes.indexOf(0xff, at);
          if (at < 0 || !fits(at, 2)) return invalid();
          const next = bytes[at + 1];
          if (next === 0xff) at += 1;
          else if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
          else break;
        }
      }
    }
    return invalid();
  }

  if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length)
      return invalid();
    const u24 = (at: number) =>
      bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
    let at = 12,
      count = 0,
      result: PosterImageHeader | undefined,
      canvas: PosterImageHeader | undefined;
    while (fits(at, 8)) {
      if (++count > MAX_RECORDS) return invalid();
      const type = text(at, 4),
        size = view.getUint32(at + 4, true),
        body = at + 8;
      if (!fits(body, size + (size % 2))) return invalid();
      if (type === "ANIM" || type === "ANMF") return animated();
      if (type === "VP8X") {
        if (at !== 12 || size !== 10 || canvas) return invalid();
        if (bytes[body] & 0x02) return animated();
        canvas = dimensions(u24(body + 4) + 1, u24(body + 7) + 1, "image/webp");
      } else if (type === "VP8 ") {
        if (
          result ||
          size < 10 ||
          bytes[body] & 1 ||
          text(body + 3, 3) !== "\x9d\x01\x2a"
        )
          return invalid();
        result = dimensions(
          view.getUint16(body + 6, true) & 0x3fff,
          view.getUint16(body + 8, true) & 0x3fff,
          "image/webp",
        );
      } else if (type === "VP8L") {
        if (result || size < 5 || bytes[body] !== 0x2f) return invalid();
        const packed = view.getUint32(body + 1, true);
        if (packed >>> 29) return invalid();
        result = dimensions(
          (packed & 0x3fff) + 1,
          ((packed >>> 14) & 0x3fff) + 1,
          "image/webp",
        );
      }
      at = body + size + (size % 2);
    }
    if (
      at !== bytes.length ||
      !result ||
      (canvas &&
        (canvas.width !== result.width || canvas.height !== result.height))
    )
      return invalid();
    return result;
  }

  if (text(4, 4) === "ftyp") {
    type Box = { type: string; body: number; end: number };
    let records = 0;
    const boxes = (start: number, end: number): Box[] => {
      const result: Box[] = [];
      for (let at = start; at < end;) {
        if (++records > MAX_RECORDS || !fits(at, 8, end)) return invalid();
        let size = view.getUint32(at),
          header = 8;
        if (size === 1) {
          if (!fits(at, 16, end) || view.getUint32(at + 8) !== 0)
            return invalid();
          size = view.getUint32(at + 12);
          header = 16;
        } else if (size === 0) size = end - at;
        if (size < header || !fits(at, size, end)) return invalid();
        result.push({
          type: text(at + 4, 4),
          body: at + header,
          end: at + size,
        });
        at += size;
      }
      return result;
    };
    const full = (box: Box) => {
      if (!fits(box.body, 4, box.end)) return invalid();
      return {
        version: bytes[box.body],
        flags: view.getUint32(box.body) & 0xffffff,
      };
    };
    const root = boxes(0, bytes.length),
      ftyp = root[0];
    if (
      ftyp.type !== "ftyp" ||
      !fits(ftyp.body, 8, ftyp.end) ||
      (ftyp.end - ftyp.body) % 4
    )
      return invalid();
    const brands = [text(ftyp.body, 4)];
    for (let at = ftyp.body + 8; at < ftyp.end; at += 4)
      brands.push(text(at, 4));
    if (
      brands.includes("avis") ||
      brands.includes("msf1") ||
      root.some((box) => box.type === "moov")
    )
      return animated();
    if (!brands.includes("avif")) return invalid();
    const metas = root.filter((box) => box.type === "meta");
    if (
      metas.length !== 1 ||
      full(metas[0]).version !== 0 ||
      full(metas[0]).flags !== 0
    )
      return invalid();
    const meta = boxes(metas[0].body + 4, metas[0].end);
    const primaries = meta.filter((box) => box.type === "pitm"),
      groups = meta.filter((box) => box.type === "iprp");
    if (primaries.length !== 1 || groups.length !== 1) return invalid();
    const primaryBox = primaries[0],
      primaryFull = full(primaryBox);
    if (
      primaryFull.flags ||
      primaryFull.version > 1 ||
      primaryBox.end - primaryBox.body !== (primaryFull.version ? 8 : 6)
    )
      return invalid();
    const primary = primaryFull.version
      ? view.getUint32(primaryBox.body + 4)
      : view.getUint16(primaryBox.body + 4);
    const properties = boxes(groups[0].body, groups[0].end),
      containers = properties.filter((box) => box.type === "ipco"),
      associations = properties.filter((box) => box.type === "ipma");
    if (containers.length !== 1 || !associations.length) return invalid();
    const entries = boxes(containers[0].body, containers[0].end);
    const extents = entries.map((box) => {
      if (box.type !== "ispe") return null;
      const version = full(box);
      if (version.version || version.flags || box.end - box.body !== 12)
        return invalid();
      // Check every declared extent, including auxiliary images, before decoding.
      return dimensions(
        view.getUint32(box.body + 4),
        view.getUint32(box.body + 8),
        "image/avif",
      );
    });
    let selected: PosterImageHeader | undefined;
    for (const box of associations) {
      const version = full(box);
      if (
        version.version > 1 ||
        version.flags > 1 ||
        !fits(box.body + 4, 4, box.end)
      )
        return invalid();
      let at = box.body + 8;
      const count = view.getUint32(box.body + 4);
      if (count > MAX_RECORDS) return invalid();
      for (let i = 0; i < count; i++) {
        const idBytes = version.version ? 4 : 2;
        if (!fits(at, idBytes + 1, box.end)) return invalid();
        const id = idBytes === 4 ? view.getUint32(at) : view.getUint16(at);
        at += idBytes;
        const length = bytes[at++],
          entryBytes = version.flags & 1 ? 2 : 1;
        if (!fits(at, length * entryBytes, box.end)) return invalid();
        for (let j = 0; j < length; j++) {
          const property =
            entryBytes === 2 ? view.getUint16(at) & 0x7fff : bytes[at] & 0x7f;
          at += entryBytes;
          if (property > entries.length) return invalid();
          if (id === primary && property && extents[property - 1]) {
            if (selected) return invalid();
            selected = extents[property - 1]!;
          }
        }
      }
      if (at !== box.end) return invalid();
    }
    // Primary-item associations are required: a thumbnail/tile extent alone is
    // not evidence of the complete AVIF image dimensions.
    return selected ?? invalid();
  }
  return invalid();
}
