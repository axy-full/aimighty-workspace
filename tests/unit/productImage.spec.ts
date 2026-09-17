import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { identifyImage } from "../../lib/imagemeta";
import { validateProductImage } from "../../lib/workbench/product-image";
import { PRODUCT_IMAGE_BYTES } from "../../lib/workbench/product-fetch";

function pixel() {
  return sharp({
    create: { width: 320, height: 320, channels: 3, background: "#123456" },
  });
}

test("supported originals retain exact bytes, MIME and safe filenames through inspection", async () => {
  const originals = [
    { mime: "image/jpeg", ext: "jpg", bytes: await pixel().jpeg().toBuffer() },
    { mime: "image/png", ext: "png", bytes: await pixel().png().toBuffer() },
    { mime: "image/webp", ext: "webp", bytes: await pixel().webp().toBuffer() },
    {
      mime: "image/avif",
      ext: "avif",
      bytes: await pixel().avif({ effort: 0 }).toBuffer(),
    },
  ];
  for (const original of originals) {
    const result = await validateProductImage(original.bytes, original.mime);
    expect(result.bytes).toBe(original.bytes);
    expect(result.bytes.equals(original.bytes)).toBe(true);
    expect(result).toMatchObject({
      mime: original.mime,
      width: 320,
      height: 320,
    });
    expect(result.filename).toMatch(
      new RegExp(`^product-original-[a-f0-9]{12}\\.${original.ext}$`),
    );
    expect(identifyImage(result.bytes)).toMatchObject({
      kind: "image",
      mime: original.mime,
      ext: original.ext,
    });
  }
});

test("image inspection rejects false MIME, HTML/SVG, corrupt headers, oversized bytes and pixel bombs", async () => {
  const png = await pixel().png().toBuffer();
  for (const [bytes, mime] of [
    [png, "image/jpeg"],
    [
      Buffer.from(
        "<svg xmlns='http://www.w3.org/2000/svg'><script>bad</script></svg>",
      ),
      "image/png",
    ],
    [Buffer.from("<!doctype html><html>not an image</html>"), "image/jpeg"],
    [Buffer.from("GIF89a".padEnd(40, "x")), "image/gif"],
    [
      Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(100)]),
      "image/jpeg",
    ],
  ] as const)
    await expect(validateProductImage(bytes, mime)).rejects.toMatchObject({
      code: "invalid_image",
    });
  await expect(
    validateProductImage(Buffer.alloc(PRODUCT_IMAGE_BYTES + 1), "image/png"),
  ).rejects.toMatchObject({ code: "image_too_large" });
  const huge = Buffer.from(png);
  huge.writeUInt32BE(10_000, 16);
  huge.writeUInt32BE(4_001, 20);
  await expect(validateProductImage(huge, "image/png")).rejects.toMatchObject({
    code: "image_dimensions",
  });
});

test("animated WebP and APNG are refused even when a metadata reader could inspect only the first frame", async () => {
  const frames = Buffer.alloc(10 * 20 * 3);
  frames.fill(255, 0, 10 * 10 * 3);
  const animated = await sharp(frames, {
    raw: { width: 10, height: 20, pageHeight: 10, channels: 3 },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
  await expect(
    validateProductImage(animated, "image/webp"),
  ).rejects.toMatchObject({ code: "animated_image" });
  const png = await pixel().png().toBuffer();
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0);
  control.write("acTL", 4);
  control.writeUInt32BE(2, 8);
  // The animation declaration must be rejected before any first-frame-only decode.
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  await expect(validateProductImage(apng, "image/png")).rejects.toMatchObject({
    code: "animated_image",
  });
});

test("AVIF compatibility brands stay images while an ordinary MP4 stays video", () => {
  const container = Buffer.alloc(40);
  container.writeUInt32BE(32, 0);
  container.write("ftyp", 4);
  container.write("mif1", 8);
  container.write("avif", 16);
  expect(identifyImage(container)).toMatchObject({
    kind: "image",
    mime: "image/avif",
    ext: "avif",
  });
  container.write("mp42", 8);
  container.write("mp42", 16);
  expect(identifyImage(container)).toMatchObject({
    kind: "video",
    mime: "video/mp4",
    ext: "mp4",
  });
});
