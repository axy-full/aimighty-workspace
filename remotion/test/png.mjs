// A small PNG reader for the render tests: 8-bit, non-interlaced, RGB or RGBA (what Chrome writes).
import { inflateSync } from "node:zlib";

export function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const data = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("latin1", pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error("only 8-bit non-interlaced PNGs");
      colorType = body[9];
    } else if (type === "IDAT") data.push(body);
    pos += 12 + length;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colour type ${colorType}`);
  const channels = colorType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = value & 255;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

/** Sum of absolute channel differences per pixel over a region, as a mean per pixel (0 = identical). */
export function regionDiff(a, b, region) {
  const { x0, y0, x1, y1 } = region;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = a.pixel(x, y), q = b.pixel(x, y);
      total += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
    }
  }
  return total / Math.max(1, (x1 - x0) * (y1 - y0));
}

/** How many pixels in a region are within `tolerance` of the colour. */
export function countNear(image, region, [r, g, b], tolerance = 24) {
  let count = 0;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      const p = image.pixel(x, y);
      if (Math.abs(p[0] - r) + Math.abs(p[1] - g) + Math.abs(p[2] - b) <= tolerance) count += 1;
    }
  }
  return count;
}
