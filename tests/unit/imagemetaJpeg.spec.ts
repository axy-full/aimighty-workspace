import { test, expect } from "@playwright/test";
import { identifyImage, validateImage } from "../../lib/imagemeta";

/**
 * JPEG sizing in lib/imagemeta.ts (shared by the upload route and the
 * document importer). Fill bytes (0xFF after 0xFF) are skipped as fill, the
 * frame header must come before the first scan, and nothing past SOS is
 * read. Every JPEG here is hand-built header bytes; nothing is decoded.
 */

const SOF0 = (width: number, height: number) =>
  [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const APP0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
const SOS = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
const EOI = [0xff, 0xd9];
const jpeg = (...parts: number[][]) => Buffer.from([0xff, 0xd8, ...parts.flat()]);

test("a plain JPEG is sized from its frame header", () => {
  expect(identifyImage(jpeg(APP0, SOF0(640, 480), SOS, [1, 2, 3], EOI))).toMatchObject({ mime: "image/jpeg", width: 640, height: 480 });
});

test("fill bytes before a marker are fill: a real 10,000 × 10,000 frame cannot hide behind them and a fake small one", () => {
  // FF D8 | FF (fill) FF C0 <real SOF> ... and, where the old reader landed
  // after taking "FF FF" as a marker with length 0xC000, a fake 100 × 100 SOF.
  const head = jpeg([0xff], SOF0(10_000, 10_000));
  const fakeAt = 2 + 2 + 0xc000;
  const bytes = Buffer.concat([head, Buffer.alloc(fakeAt - head.length, 0), Buffer.from(SOF0(100, 100)), Buffer.from(SOS), Buffer.from(EOI)]);
  const meta = identifyImage(bytes);
  expect(meta).toMatchObject({ mime: "image/jpeg", width: 10_000, height: 10_000 });
  // So its real size meets the limits: 100 megapixels, past the upload route's 6000 px side.
  expect(validateImage(meta!, bytes.length)).toMatch(/10000×10000 exceeds/);
});

test("several fill bytes in a row are all skipped", () => {
  expect(identifyImage(jpeg(APP0, [0xff, 0xff, 0xff], SOF0(1200, 800), SOS, EOI))).toMatchObject({ width: 1200, height: 800 });
});

test("a JPEG that reaches its first scan, or its end, before any frame header is refused", () => {
  expect(identifyImage(jpeg(APP0, SOS, [0xff, 0x00, 0x12, 0x34], EOI, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  expect(identifyImage(jpeg(APP0, EOI, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
});

test("nothing after SOS is read: a SOF-shaped run inside scan data is not a frame header", () => {
  const bytes = jpeg(APP0, SOS, SOF0(100, 100), EOI, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(identifyImage(bytes)).toBeNull();
});
