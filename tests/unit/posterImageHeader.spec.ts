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
  const mpo = Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([255, 226, 0, 6]),
    Buffer.from("MPF\0"),
    jpeg.subarray(2),
  ]);
  expect(() => inspectPosterImageHeader(mpo)).toThrow("multi-image");
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
