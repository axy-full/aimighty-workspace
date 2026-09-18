/** Validate the binary container before either native or WebGL decoding. */
export const ASTRA_GLB_BYTES = 32 * 1024 * 1024;
export const ASTRA_TEXTURE_LIMITS = { dimension: 8192, pixels: 16_777_216, totalPixels: 33_554_432 } as const;

/** Header-only bounds before native/WebGL image decoding. Format references:
 * https://www.w3.org/TR/png-3/#11IHDR
 * https://www.w3.org/Graphics/JPEG/itu-t81.pdf
 * https://developers.google.com/speed/webp/docs/riff_container
 * https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification
 */
export function astraTextureDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
  const invalid = (): never => { throw new Error('A GLB texture has an invalid or unsupported image header.'); };
  const checked = (width: number, height: number) => {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
    if (width > ASTRA_TEXTURE_LIMITS.dimension || height > ASTRA_TEXTURE_LIMITS.dimension || width * height > ASTRA_TEXTURE_LIMITS.pixels)
      throw new Error('A GLB texture exceeds 8192 pixels per dimension or 16 million pixels.');
    return { width, height };
  };
  if (mime === 'image/png') {
    if (bytes.length < 33 || bytes[0] !== 137 || ascii(1, 3) !== 'PNG' || ![13, 10, 26, 10].every((value, index) => bytes[4 + index] === value) || view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') invalid();
    const size = checked(view.getUint32(16), view.getUint32(20));
    let offset = 8, chunks = 0;
    while (offset + 12 <= bytes.length && ++chunks <= 10000) {
      const length = view.getUint32(offset), type = ascii(offset + 4, 4);
      if (offset + 12 + length > bytes.length) invalid();
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw new Error('Use still PNG or WebP textures; animated textures are unsupported.');
      if (offset > 8 && type === 'IHDR') invalid();
      if (type === 'IEND') { if (length !== 0) invalid(); return size; }
      offset += 12 + length;
    }
    invalid();
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
    let offset = 2, markers = 0;
    let size: { width: number; height: number } | undefined;
    while (offset < bytes.length && ++markers <= 4096) {
      if (bytes[offset++] !== 0xff) invalid();
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) invalid();
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return size ?? invalid();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8 || size) invalid();
        size = checked(view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
    invalid();
  }
  if (mime === 'image/webp') {
    if (bytes.length < 20 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) invalid();
    let offset = 12, chunks = 0;
    let canvas: { width: number; height: number } | undefined;
    let image: { width: number; height: number } | undefined;
    while (offset + 8 <= bytes.length && ++chunks <= 4096) {
      const type = ascii(offset, 4), length = view.getUint32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) invalid();
      if (type === 'ANIM' || type === 'ANMF') throw new Error('Use still PNG or WebP textures; animated textures are unsupported.');
      if (type === 'VP8X') {
        if (length !== 10 || canvas || offset !== 12) invalid();
        if (bytes[data] & 2) throw new Error('Use still PNG or WebP textures; animated textures are unsupported.');
        const uint24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
        canvas = checked(1 + uint24(data + 4), 1 + uint24(data + 7));
      } else if (type === 'VP8 ') {
        if (length < 10 || image || bytes[data] & 1 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) invalid();
        image = checked(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff);
      } else if (type === 'VP8L') {
        if (length < 5 || image || bytes[data] !== 0x2f) invalid();
        const packed = view.getUint32(data + 1, true);
        if (packed >>> 29) invalid();
        image = checked((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      }
      offset = data + length + length % 2;
    }
    if (offset !== bytes.length || !image) return invalid();
    if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) invalid();
    return image;
  }
  return invalid();
}

export function validateAstraGlb(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || bytes.length > ASTRA_GLB_BYTES || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw new Error('Use a self-contained GLB 2.0 model smaller than 32 MB.');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > bytes.length - 20 || length > 2 * 1024 * 1024 || length % 4) throw new Error('The GLB scene description is invalid or too large.');
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + length)));
  if (!data || data.asset?.version !== '2.0') throw new Error('Use a GLB 2.0 scene.');
  const stack: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > 200000 || depth > 64) throw new Error('This model is too complex to preview safely.');
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri') throw new Error('Embed all buffers and textures in the GLB binary; external files and data URLs are unsupported.');
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid GLB property.');
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  const unsupported = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];
  if ([...(data.extensionsUsed ?? []), ...(data.extensionsRequired ?? [])].some((value: unknown) => unsupported.includes(String(value)))) throw new Error('Export an uncompressed GLB with PNG or JPEG textures.');
  if ((data.nodes?.length ?? 0) > 256 || (data.meshes?.length ?? 0) > 256 || (data.images?.length ?? 0) > 32 || (data.accessors?.length ?? 0) > 4096) throw new Error('This GLB exceeds the scene resource limit.');
  let values = 0;
  for (const accessor of data.accessors ?? []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > 3000000) throw new Error('Invalid or oversized GLB geometry.');
    values += accessor.count;
  }
  if (values > 16000000) throw new Error('This GLB exceeds the geometry budget.');
  // Require exactly one embedded binary chunk and its declared buffer bounds.
  const binaryOffset = 20 + length;
  if (binaryOffset + 8 > bytes.length || view.getUint32(binaryOffset + 4, true) !== 0x004e4942 || binaryOffset + 8 + view.getUint32(binaryOffset, true) !== bytes.length || (data.buffers?.length ?? 0) !== 1 || !Number.isSafeInteger(data.buffers[0].byteLength) || data.buffers[0].byteLength < 1 || data.buffers[0].byteLength > view.getUint32(binaryOffset, true)) throw new Error('Use one embedded GLB binary buffer.');
  for (const item of data.bufferViews ?? []) if (item.buffer !== 0 || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || !Number.isSafeInteger(item.byteOffset ?? 0) || (item.byteOffset ?? 0) < 0 || (item.byteOffset ?? 0) + item.byteLength > data.buffers[0].byteLength) throw new Error('Invalid GLB buffer bounds.');
  let pixels = 0;
  for (const image of data.images ?? []) {
    if (!Number.isSafeInteger(image.bufferView) || !data.bufferViews?.[image.bufferView] || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) throw new Error('Use embedded PNG, JPEG or WebP textures.');
    const bufferView = data.bufferViews[image.bufferView];
    const start = binaryOffset + 8 + (bufferView.byteOffset ?? 0);
    const dimensions = astraTextureDimensions(bytes.subarray(start, start + bufferView.byteLength), image.mimeType);
    pixels += dimensions.width * dimensions.height;
    if (pixels > ASTRA_TEXTURE_LIMITS.totalPixels) throw new Error('GLB textures exceed the combined 32 million pixel budget.');
  }
  return data as { asset: { version: string }; nodes?: unknown[] };
}
