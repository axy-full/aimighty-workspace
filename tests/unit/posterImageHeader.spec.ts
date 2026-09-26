import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { inspectPosterImageHeader } from "../../lib/workbench/poster-image-header";

function box(type: string, ...bodies: Buffer[]) {
  const body = Buffer.concat(bodies),
    result = Buffer.alloc(8 + body.length);
  result.writeUInt32BE(result.length);
  result.write(type, 4);
  body.copy(result, 8);
  return result;
}
function u32(value: number) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}
/** APP2 "MPF" segment (big-endian TIFF) with one MP entry per attribute. */
function mpf(attributes: number[]) {
  const entries = attributes.length * 16,
    ifd = Buffer.alloc(2 + 3 * 12 + 4);
  ifd.writeUInt16BE(3);
  const tag = (i: number, id: number, type: number, count: number, value: Buffer) => {
    const at = 2 + i * 12;
    ifd.writeUInt16BE(id, at);
    ifd.writeUInt16BE(type, at + 2);
    ifd.writeUInt32BE(count, at + 4);
    value.copy(ifd, at + 8);
  };
  tag(0, 0xb000, 7, 4, Buffer.from("0100"));
  tag(1, 0xb001, 4, 1, u32(attributes.length));
  tag(2, 0xb002, 7, entries, u32(8 + ifd.length));
  const list = Buffer.concat(
    attributes.map((attribute) => Buffer.concat([u32(attribute), Buffer.alloc(12)])),
  );
  const tiff = Buffer.concat([Buffer.from("MM\0*"), u32(8), ifd, list]);
  const head = Buffer.from([0xff, 0xe2, 0, 0]);
  head.writeUInt16BE(2 + 4 + tiff.length, 2);
  return Buffer.concat([head, Buffer.from("MPF\0"), tiff]);
}
async function still(width: number, height: number, options: { progressive?: boolean } = {}) {
  return sharp({ create: { width, height, channels: 3, background: "#3d7389" } })
    .jpeg(options)
    .toBuffer();
}

function avif(width: number, height: number, primaryProperty = 2) {
  return Buffer.concat([
    box("ftyp", Buffer.from("avif"), u32(0), Buffer.from("avifmif1")),
    box(
      "meta",
      u32(0),
      box("pitm", u32(0), Buffer.from([0, 1])),
      box(
        "iprp",
        box(
          "ipco",
          box("ispe", u32(0), u32(256), u32(256)),
          box("ispe", u32(0), u32(width), u32(height)),
        ),
        box(
          "ipma",
          u32(0),
          u32(1),
          Buffer.from([0, 1, 1, 0x80 | primaryProperty]),
        ),
      ),
    ),
    box("mdat", Buffer.from("ispe is not a box here")),
  ]);
}

test("known still headers agree with decoded JPEG PNG WebP and AVIF originals without modifying bytes", async () => {
  for (const format of ["jpeg", "png", "webp", "avif"] as const) {
    const source = sharp({
      create: { width: 320, height: 240, channels: 3, background: "#3d7389" },
    });
    const bytes = await source[format]().toBuffer();
    const before = Buffer.from(bytes);
    expect(inspectPosterImageHeader(bytes)).toEqual({
      width: 320,
      height: 240,
      mime: `image/${format}`,
    });
    expect(bytes).toEqual(before);
    const framed = Buffer.concat([
      Buffer.from([1, 2, 3]),
      bytes,
      Buffer.from([4, 5]),
    ]);
    expect(
      inspectPosterImageHeader(
        new Uint8Array(framed.buffer, framed.byteOffset + 3, bytes.length),
      ).width,
    ).toBe(320);
    expect(() => inspectPosterImageHeader(bytes, 320 * 240 - 1)).toThrow(
      "40-megapixel",
    );
    expect(inspectPosterImageHeader(bytes, 320 * 240).height).toBe(240);
  }
});

test("AVIF uses the complete primary-item extent, not a smaller thumbnail or tile property", () => {
  expect(inspectPosterImageHeader(avif(4000, 3000))).toEqual({
    mime: "image/avif",
    width: 4000,
    height: 3000,
  });
  expect(() => inspectPosterImageHeader(avif(10_000, 10_000))).toThrow(
    "40-megapixel",
  );
  expect(() => inspectPosterImageHeader(avif(4000, 3000, 0))).toThrow(
    "unreadable",
  );
  expect(() => inspectPosterImageHeader(avif(4000, 3000, 3))).toThrow(
    "unreadable",
  );
  const notAvif = avif(4000, 3000);
  notAvif.write("heic", 8);
  notAvif.write("heic", 16);
  expect(() => inspectPosterImageHeader(notAvif)).toThrow("unreadable");
  const sequence = avif(4000, 3000);
  sequence.write("avis", 8);
  expect(() => inspectPosterImageHeader(sequence)).toThrow("Animated");
  expect(() =>
    inspectPosterImageHeader(Buffer.concat([avif(4000, 3000), box("moov")])),
  ).toThrow("Animated");
});

test("oversize PNG and WebP metadata is rejected before any bitmap allocation is needed", async () => {
  const png = await sharp({
    create: { width: 300, height: 300, channels: 3, background: "#112233" },
  })
    .png()
    .toBuffer();
  png.writeUInt32BE(100_000, 16);
  png.writeUInt32BE(100_000, 20);
  expect(() => inspectPosterImageHeader(png)).toThrow("40-megapixel");
  const vp8x = Buffer.alloc(10);
  vp8x.fill(255, 4);
  const body = Buffer.concat([
    Buffer.from("WEBPVP8X"),
    Buffer.from([10, 0, 0, 0]),
    vp8x,
  ]);
  const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
  riff.writeUInt32LE(body.length, 4);
  expect(() => inspectPosterImageHeader(riff)).toThrow("40-megapixel");
});

test("animated and multi-image headers cannot silently use a first frame", async () => {
  const frames = Buffer.alloc(10 * 20 * 3);
  frames.fill(255, 0, 10 * 10 * 3);
  const webp = await sharp(frames, {
    raw: { width: 10, height: 20, pageHeight: 10, channels: 3 },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  expect(() => inspectPosterImageHeader(webp)).toThrow("Animated");
  const png = await sharp({
    create: { width: 300, height: 300, channels: 3, background: "#112233" },
  })
    .png()
    .toBuffer();
  const apng = Buffer.concat([
    png.subarray(0, 33),
    u32(8),
    Buffer.from("acTL"),
    u32(2),
    u32(0),
    u32(0),
    png.subarray(33),
  ]);
  expect(() => inspectPosterImageHeader(apng)).toThrow("Animated");
  const jpeg = await sharp({
    create: { width: 300, height: 300, channels: 3, background: "#112233" },
  })
    .jpeg()
    .toBuffer();
  // A stereo MPO declares two disparity images; a panorama is the same class.
  for (const type of [0x020002, 0x020001, 0x020003]) {
    const mpo = Buffer.concat([
      jpeg.subarray(0, 2),
      mpf([0x20000000 | type, type]),
      jpeg.subarray(2),
      jpeg,
    ]);
    expect(() => inspectPosterImageHeader(mpo)).toThrow("multi-image");
  }
});

test("phone HDR JPEGs with an MPF gain map, maker trailers and PNG trailing bytes use the primary image", async () => {
  const primary = await still(4032, 3024),
    gainMap = await still(1008, 756);
  // Ultra HDR: primary (Baseline MP Primary) + gain map (undefined type) after the primary EOI.
  const ultraHdr = Buffer.concat([
    primary.subarray(0, 2),
    mpf([0x20030000, 0x000000]),
    primary.subarray(2),
    gainMap,
  ]);
  expect(inspectPosterImageHeader(ultraHdr)).toEqual({ width: 4032, height: 3024, mime: "image/jpeg" });
  // Large thumbnails are auxiliary too.
  const thumbnailed = Buffer.concat([primary.subarray(0, 2), mpf([0x20030000, 0x010001]), primary.subarray(2), gainMap]);
  expect(inspectPosterImageHeader(thumbnailed).width).toBe(4032);
  // A bare or unreadable MPF index does not declare a multi-frame set.
  const bare = Buffer.concat([primary.subarray(0, 2), Buffer.from([255, 226, 0, 6]), Buffer.from("MPF\0"), primary.subarray(2)]);
  expect(inspectPosterImageHeader(bare).height).toBe(3024);
  // A maker trailer after EOI (the file no longer ends in FFD9).
  const trailer = Buffer.concat([primary, Buffer.from("SEFH\0\0\0\x01trailer data"), Buffer.alloc(64, 7)]);
  expect(inspectPosterImageHeader(trailer).width).toBe(4032);
  // Progressive scans are walked to the primary EOI, then trailing data is ignored.
  const progressive = await still(640, 480, { progressive: true });
  expect(inspectPosterImageHeader(Buffer.concat([progressive, Buffer.from([1, 2, 3])])).height).toBe(480);
  // A primary cut off before its EOI still fails, whatever follows the cut.
  expect(() => inspectPosterImageHeader(primary.subarray(0, primary.length - 2))).toThrow("unreadable");
  expect(() => inspectPosterImageHeader(ultraHdr.subarray(0, 40 + Math.floor(primary.length / 2)))).toThrow("unreadable");
  // PNG: bytes after IEND are ignored, a missing IEND is not.
  const png = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#3d7389" } }).png().toBuffer();
  expect(inspectPosterImageHeader(Buffer.concat([png, Buffer.from("trailing bytes")])).width).toBe(320);
  expect(() => inspectPosterImageHeader(png.subarray(0, png.length - 12))).toThrow("unreadable");
  // Oversize primaries still fail on the pixel budget.
  expect(() => inspectPosterImageHeader(ultraHdr, 4032 * 3024 - 1)).toThrow("40-megapixel");
});

test("unknown dimensions, corrupt lengths, unbounded box counts and truncated headers fail closed", async () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("GIF89a"),
    Buffer.from("<svg/>"),
    Buffer.from("not an image"),
    avif(0, 20),
  ])
    expect(() => inspectPosterImageHeader(bytes)).toThrow("unreadable");
  for (const format of ["jpeg", "png", "webp", "avif"] as const) {
    const bytes = await sharp({
      create: { width: 300, height: 300, channels: 3, background: "#112233" },
    })
      [format]()
      .toBuffer();
    for (const length of [
      1,
      7,
      16,
      Math.floor(bytes.length / 2),
      bytes.length - 1,
    ]) {
      try {
        inspectPosterImageHeader(bytes.subarray(0, length));
        throw new Error("Accepted truncated header");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(RangeError);
        expect((error as Error).message).not.toBe("Accepted truncated header");
      }
    }
  }
  const overflow = avif(400, 300);
  overflow.writeUInt32BE(0xffffffff, 0);
  expect(() => inspectPosterImageHeader(overflow)).toThrow("unreadable");
  const excessBoxes = Buffer.concat([
    avif(400, 300),
    ...Array.from({ length: 4097 }, () => box("free")),
  ]);
  expect(() => inspectPosterImageHeader(excessBoxes)).toThrow("unreadable");
});

test("poster rendering enforces its cumulative header budget before bitmap allocation and closes prior bitmaps", async () => {
  const { createPoster, renderPoster } =
    await import("../../lib/workbench/moleculr-poster");
  const { newProject } = await import("../../lib/workbench/studio");
  const project = newProject("Safe preview");
  project.assets = ["one", "two"].map((id) => ({
    id,
    uploadId: id,
    name: id,
    url: `/api/uploads/${id}`,
    kind: "image",
    category: "Product",
    mime: "image/png",
    description: "",
    prompt: "",
    status: "Draft",
    locked: false,
    version: 1,
    refs: [],
  }));
  let serial = 0;
  const poster = createPoster("Preview", () => `layer-${++serial}`);
  poster.layers = project.assets.map((asset) => ({
    id: asset.id,
    kind: "image",
    name: asset.name,
    assetId: asset.id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    visible: true,
    locked: false,
    fit: "contain",
  }));
  const original = await sharp({
    create: { width: 300, height: 300, channels: 3, background: "#112233" },
  })
    .png()
    .toBuffer();
  const bytes = Buffer.from(original);
  bytes.writeUInt32BE(6000, 16);
  bytes.writeUInt32BE(5000, 20);
  const previous = ["window", "fetch", "createImageBitmap"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  let bitmaps = 0,
    closed = 0,
    fetched = 0;
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        document: {
          createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({}),
          }),
        },
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (_url: string, options: RequestInit) => {
        expect(new Headers(options.headers).get("X-Workbench-Scope")).toBe(
          "captured-scope",
        );
        fetched++;
        return new Response(new Uint8Array(bytes), {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async () => {
        bitmaps++;
        return {
          width: 6000,
          height: 5000,
          close: () => {
            closed++;
          },
        };
      },
    });
    await expect(
      renderPoster(poster, project.assets, 900, "captured-scope"),
    ).rejects.toThrow("40-megapixel");
    expect(fetched).toBe(2);
    expect(bitmaps).toBe(1);
    expect(closed).toBe(1);
    bytes.writeUInt32BE(100_000, 16);
    bytes.writeUInt32BE(100_000, 20);
    bitmaps = 0;
    closed = 0;
    await expect(
      renderPoster(poster, project.assets, 900, "captured-scope"),
    ).rejects.toThrow("40-megapixel");
    expect(bitmaps).toBe(0);
    expect(closed).toBe(0);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
