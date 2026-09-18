import { test, expect } from '@playwright/test';
import { astraTextureDimensions, validateAstraGlb, ASTRA_TEXTURE_LIMITS } from '../../lib/astra-blender/glb';

function png(width: number, height: number, animated = false) {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12);
  header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20); header[24] = 8; header[25] = 6;
  const end = Buffer.alloc(12); end.write('IEND', 4);
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4); animation.writeUInt32BE(1, 8);
  return Buffer.concat([header, ...(animated ? [animation] : []), end]);
}

function jpeg(width: number, height: number) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
}

function chunk(type: string, payload: Buffer) {
  const result = Buffer.alloc(8 + payload.length + payload.length % 2);
  result.write(type, 0); result.writeUInt32LE(payload.length, 4); payload.copy(result, 8); return result;
}

function webp(width: number, height: number, kind: 'VP8 ' | 'VP8L' | 'VP8X' = 'VP8 ', extendedSize?: [number, number], animated = false) {
  const vp8 = Buffer.alloc(10); vp8.set([0, 0, 0, 0x9d, 0x01, 0x2a]); vp8.writeUInt16LE(width, 6); vp8.writeUInt16LE(height, 8);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  const extended = Buffer.alloc(10); extended[0] = animated ? 2 : 0;
  const [cw, ch] = extendedSize ?? [width, height]; extended.writeUIntLE(cw - 1, 4, 3); extended.writeUIntLE(ch - 1, 7, 3);
  const chunks = kind === 'VP8X' ? [chunk('VP8X', extended), chunk('VP8 ', vp8)] : [chunk(kind, kind === 'VP8L' ? vp8l : vp8)];
  const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(4 + chunks.reduce((sum, value) => sum + value.length, 0), 4); header.write('WEBP', 8);
  return Buffer.concat([header, ...chunks]);
}

function texturedGlb(images: { mime: string; bytes: Buffer }[]) {
  const binary = Buffer.concat(images.map(image => image.bytes));
  let offset = 0;
  const document = { asset: { version: '2.0' }, buffers: [{ byteLength: binary.length }], bufferViews: images.map(image => { const view = { buffer: 0, byteOffset: offset, byteLength: image.bytes.length }; offset += image.bytes.length; return view; }), images: images.map((image, index) => ({ bufferView: index, mimeType: image.mime })) };
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(jsonPadded);
  const binaryPadded = Buffer.alloc(Math.ceil(binary.length / 4) * 4); binary.copy(binaryPadded);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonPadded.length + binaryPadded.length, 8); header.writeUInt32LE(jsonPadded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binaryPadded.length); binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonPadded, binaryHeader, binaryPadded]);
}

test('PNG, progressive JPEG and all still WebP headers are bounded without decoding', () => {
  expect(astraTextureDimensions(png(512, 256), 'image/png')).toEqual({ width: 512, height: 256 });
  expect(astraTextureDimensions(jpeg(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
  for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) expect(astraTextureDimensions(webp(320, 240, kind), 'image/webp')).toEqual({ width: 320, height: 240 });
});

test('header checks reject excessive dimensions and decoded pixel counts', () => {
  for (const [width, height] of [[8193, 1], [1, 8193], [8192, 8192], [4097, 4096]]) {
    expect(() => astraTextureDimensions(png(width, height), 'image/png')).toThrow('exceeds');
    expect(() => astraTextureDimensions(jpeg(width, height), 'image/jpeg')).toThrow('exceeds');
    for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) expect(() => astraTextureDimensions(webp(width, height, kind), 'image/webp')).toThrow('exceeds');
  }
  expect(astraTextureDimensions(png(4096, 4096), 'image/png').width * 4096).toBe(ASTRA_TEXTURE_LIMITS.pixels);
  expect(() => astraTextureDimensions(png(0, 1), 'image/png')).toThrow('invalid');
  expect(() => astraTextureDimensions(jpeg(1, 0), 'image/jpeg')).toThrow('invalid');
});

test('mismatched MIME, truncated chunks and animated texture containers fail closed', () => {
  expect(() => astraTextureDimensions(png(1, 1), 'image/jpeg')).toThrow();
  expect(() => astraTextureDimensions(jpeg(1, 1), 'image/png')).toThrow();
  expect(() => astraTextureDimensions(png(1, 1).subarray(0, 25), 'image/png')).toThrow();
  expect(() => astraTextureDimensions(jpeg(1, 1).subarray(0, 11), 'image/jpeg')).toThrow();
  expect(() => astraTextureDimensions(webp(1, 1).subarray(0, 29), 'image/webp')).toThrow();
  expect(() => astraTextureDimensions(png(1, 1, true), 'image/png')).toThrow('animated');
  expect(() => astraTextureDimensions(webp(1, 1, 'VP8X', undefined, true), 'image/webp')).toThrow('animated');
  expect(() => astraTextureDimensions(webp(1024, 512, 'VP8X', [1, 1]), 'image/webp')).toThrow('invalid');
  const forged = png(1, 1); forged.writeUInt32BE(0xffffffff, 8);
  expect(() => astraTextureDimensions(forged, 'image/png')).toThrow();
});

test('the GLB gate bounds each embedded texture before the importer is called', () => {
  for (const [mime, bytes] of [['image/png', png(256, 256)], ['image/jpeg', jpeg(128, 64)], ['image/webp', webp(128, 128, 'VP8L')]] as const) {
    expect(validateAstraGlb(texturedGlb([{ mime, bytes }])).asset.version).toBe('2.0');
  }
  expect(() => validateAstraGlb(texturedGlb([{ mime: 'image/png', bytes: png(8192, 8192) }]))).toThrow('exceeds');
  expect(() => validateAstraGlb(texturedGlb([{ mime: 'image/png', bytes: jpeg(100, 100) }]))).toThrow('invalid');
  expect(() => validateAstraGlb(texturedGlb([{ mime: 'image/webp', bytes: webp(4096, 4097, 'VP8X') }]))).toThrow('exceeds');
});

test('separate bounded textures share one aggregate GLB pixel budget', () => {
  const texture = { mime: 'image/png', bytes: png(4096, 4096) };
  expect(() => validateAstraGlb(texturedGlb([texture, texture]))).not.toThrow();
  expect(() => validateAstraGlb(texturedGlb([texture, texture, { mime: 'image/png', bytes: png(1, 1) }]))).toThrow('combined');
});
