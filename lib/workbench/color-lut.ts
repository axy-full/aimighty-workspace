/** Iridas .cube 3D tables. Values are RGB triplets with red changing fastest. */
export type CubeLut = {
  title: string;
  size: number;
  min: [number, number, number];
  max: [number, number, number];
  values: Float32Array;
};
export const LUT_TEXT_LIMIT = 16 * 1024 * 1024;
export function parseCube(text: string): CubeLut {
  if (!text || text.length > LUT_TEXT_LIMIT || text.includes("\0"))
    throw new Error("Use a .cube file up to 16 MB.");
  let title = "Imported LUT",
    size = 0,
    values: Float32Array | undefined,
    offset = 0;
  let min: CubeLut["min"] = [0, 0, 0],
    max: CubeLut["max"] = [1, 1, 1];
  const seen = new Set<string>();
  for (const [index, raw] of text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .entries()) {
    let quoted = false,
      end = raw.length;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"') quoted = !quoted;
      if (raw[i] === "#" && !quoted) {
        end = i;
        break;
      }
    }
    const line = raw.slice(0, end).trim();
    if (!line) continue;
    const fail = (message: string): never => {
      throw new Error(`LUT line ${index + 1}: ${message}`);
    };
    const fields = line.split(/\s+/),
      key = fields[0].toUpperCase();
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      if (offset) fail("headers must precede table values.");
      if (seen.has(key)) fail(`duplicate ${key} header.`);
      seen.add(key);
      if (key === "TITLE") {
        const match = /^TITLE\s+"([^"\r\n]*)"\s*$/i.exec(line);
        if (!match || match[1].length > 200)
          fail("use a quoted title up to 200 characters.");
        title = match![1];
        continue;
      }
      if (key === "LUT_1D_SIZE" || key === "LUT_1D_INPUT_RANGE")
        fail(
          "1D shaper tables are not supported. Export a standalone 3D .cube LUT.",
        );
      if (key === "LUT_3D_SIZE") {
        size = Number(fields[1]);
        if (
          fields.length !== 2 ||
          !Number.isInteger(size) ||
          size < 2 ||
          size > 65
        )
          fail("3D size must be between 2 and 65.");
        values = new Float32Array(size ** 3 * 3);
        continue;
      }
      if (
        key === "DOMAIN_MIN" ||
        key === "DOMAIN_MAX" ||
        key === "LUT_3D_INPUT_RANGE"
      ) {
        const numbers = fields.slice(1).map(Number);
        if (
          numbers.length !== (key === "LUT_3D_INPUT_RANGE" ? 2 : 3) ||
          !numbers.every((n) => Number.isFinite(n) && Math.abs(n) <= 16)
        )
          fail("invalid input domain.");
        if (key === "DOMAIN_MIN") min = numbers as CubeLut["min"];
        else if (key === "DOMAIN_MAX") max = numbers as CubeLut["max"];
        else {
          min = [numbers[0], numbers[0], numbers[0]];
          max = [numbers[1], numbers[1], numbers[1]];
        }
        continue;
      }
      fail(`unsupported header ${key}.`);
    }
    if (!values) fail("declare LUT_3D_SIZE before table values.");
    const rgb = fields.map(Number);
    if (
      rgb.length !== 3 ||
      !rgb.every((n) => Number.isFinite(n) && Math.abs(n) <= 16)
    )
      fail("expected three finite RGB values.");
    if (offset + 3 > values!.length) fail("too many table values.");
    values!.set(rgb, offset);
    offset += 3;
  }
  if (!values || offset !== values.length)
    throw new Error(
      `The LUT is incomplete: expected ${size ** 3} RGB rows, found ${offset / 3}.`,
    );
  if (
    seen.has("LUT_3D_INPUT_RANGE") &&
    (seen.has("DOMAIN_MIN") || seen.has("DOMAIN_MAX"))
  )
    throw new Error("Use one input-domain convention in the LUT.");
  if (min.some((v, i) => v >= max[i]))
    throw new Error("Each LUT input maximum must be greater than its minimum.");
  return { title, size, min, max, values };
}

/** CPU reference implementation for validation; preview/export use the same trilinear interpolation on the GPU. */
export function sampleCube(
  lut: CubeLut,
  rgb: readonly number[],
): [number, number, number] {
  if (rgb.length !== 3 || !rgb.every(Number.isFinite))
    throw new Error("Expected a finite RGB sample.");
  const coords = rgb.map(
    (n, i) =>
      Math.max(0, Math.min(1, (n - lut.min[i]) / (lut.max[i] - lut.min[i]))) *
      (lut.size - 1),
  );
  const low = coords.map(Math.floor),
    high = low.map((n) => Math.min(n + 1, lut.size - 1)),
    weight = coords.map((n, i) => n - low[i]);
  const result: [number, number, number] = [0, 0, 0];
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++)
      for (let r = 0; r < 2; r++) {
        const x = r ? high[0] : low[0],
          y = g ? high[1] : low[1],
          z = b ? high[2] : low[2];
        const at = ((z * lut.size + y) * lut.size + x) * 3;
        const w =
          (r ? weight[0] : 1 - weight[0]) *
          (g ? weight[1] : 1 - weight[1]) *
          (b ? weight[2] : 1 - weight[2]);
        for (let c = 0; c < 3; c++) result[c] += lut.values[at + c] * w;
      }
  return result;
}
