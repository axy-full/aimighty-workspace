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

const DQT = [0xff, 0xdb, 0x00, 0x43, 0x00, ...Array.from({ length: 64 }, () => 1)];
const DHT = [0xff, 0xc4, 0x00, 0x1f, 0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 12 }, (_, i) => i)];

/** An APP1 segment of `length` (its own two bytes included) whose payload carries a fake SOF at `fakeAt` (an absolute file offset). */
function app1With(length: number, startsAt: number, fakeAt: number, fake: number[]) {
  const segment = Buffer.alloc(2 + length, 0);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(length, 2);
  Buffer.from(fake).copy(segment, fakeAt - startsAt);
  return [...segment];
}

test("fill bytes are fill: a real 10,000 × 10,000 frame cannot hide behind one, with a fake 100 × 100 frame inside an APP1 payload", () => {
  // FF D8 | FF (fill) | real SOF0 | APP1 (64 KB) whose payload holds, where the
  // old reader landed after taking "FF FF" as a marker with length 0xC000, a
  // fake 100 × 100 SOF | DQT DHT SOS data EOI: a file a decoder really opens at 10,000 × 10,000.
  const head = [0xff, 0xd8, 0xff, ...SOF0(10_000, 10_000)];
  const bytes = Buffer.from([...head, ...app1With(0xffff, head.length, 2 + 2 + 0xc000, SOF0(100, 100)), ...DQT, ...DHT, ...SOS, 1, 2, 3, ...EOI]);
  const meta = identifyImage(bytes);
  expect(meta).toMatchObject({ mime: "image/jpeg", width: 10_000, height: 10_000 });
  expect(validateImage(meta!, bytes.length)).toMatch(/10000×10000 exceeds/);
});

test("FF 00 at the top level is a stuffed byte, not a marker: the same bypass one byte different is closed", () => {
  // FF D8 | FF 00 01 00 | real SOF0 10,000 × 10,000 | APP1 (0x200) with a fake 1,000 × 1,000 SOF where
  // the old reader landed after reading "01 00" as a length | DQT DHT SOS data EOI.
  const head = [0xff, 0xd8, 0xff, 0x00, 0x01, 0x00, ...SOF0(10_000, 10_000)];
  const bytes = Buffer.from([...head, ...app1With(0x0200, head.length, 2 + 2 + 0x0100, SOF0(1_000, 1_000)), ...DQT, ...DHT, ...SOS, 1, 2, 3, ...EOI]);
  const meta = identifyImage(bytes);
  expect(meta).toMatchObject({ mime: "image/jpeg", width: 10_000, height: 10_000 });
  expect(validateImage(meta!, bytes.length)).toMatch(/10000×10000 exceeds/);
});

test("a reserved marker (02-BF), which libjpeg refuses, is not sized", () => {
  for (const marker of [0x02, 0x4f, 0xbf])
    expect(identifyImage(jpeg(APP0, [0xff, marker, 0x00, 0x04, 0, 0], SOF0(640, 480), SOS, EOI)), marker.toString(16)).toBeNull();
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
