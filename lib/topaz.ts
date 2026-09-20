/** Public controls only. Provider prices stay in vendorRates.ts. */
export const TOPAZ_IMAGE_MODEL = "fal-ai/topaz/upscale/image";
export const TOPAZ_IMAGE_PRESETS = [
  "Standard V2",
  "High Fidelity V2",
  "Low Resolution V2",
  "CGI",
  "Text Refine",
] as const;
export type TopazImageSettings = {
  model: (typeof TOPAZ_IMAGE_PRESETS)[number];
  factor: 1 | 2 | 4;
  faceEnhancement: boolean;
  faceStrength: number;
};
export const DEFAULT_TOPAZ_IMAGE: TopazImageSettings = {
  model: "High Fidelity V2",
  factor: 2,
  faceEnhancement: false,
  faceStrength: 0.5,
};
export function topazImageSettings(value: unknown): TopazImageSettings {
  const p = value as Partial<TopazImageSettings> | null;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    !TOPAZ_IMAGE_PRESETS.includes(p.model as TopazImageSettings["model"]) ||
    ![1, 2, 4].includes(p.factor as number) ||
    typeof p.faceEnhancement !== "boolean" ||
    typeof p.faceStrength !== "number" ||
    !Number.isFinite(p.faceStrength) ||
    p.faceStrength < 0 ||
    p.faceStrength > 1
  )
    throw new Error("Choose a supported Topaz model, scale and face strength.");
  return {
    model: p.model!,
    factor: p.factor!,
    faceEnhancement: p.faceEnhancement,
    faceStrength: p.faceStrength,
  };
}
export function topazImageOutput(
  width: number,
  height: number,
  factor: number,
) {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    ![1, 2, 4].includes(factor)
  )
    throw new Error(
      "The original image's dimensions are unavailable. Upload a PNG, JPEG or WebP original.",
    );
  const w = width * factor,
    h = height * factor,
    pixels = w * h;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > 48_000_000 ||
    Math.max(w, h) > 16_384
  )
    throw new Error(
      "Choose a smaller scale. Topaz image output is limited to 48 megapixels and 16,384 pixels per side.",
    );
  return {
    width: w,
    height: h,
    resolution: pixels <= 24_000_000 ? "24MP" : "48MP",
  };
}
export function topazImageInput(
  imageUrl: string,
  settings: TopazImageSettings,
) {
  const p = topazImageSettings(settings);
  return {
    image_url: imageUrl,
    model: p.model,
    upscale_factor: p.factor,
    output_format: "png",
    crop_to_fill: false,
    face_enhancement: p.faceEnhancement,
    face_enhancement_strength: p.faceStrength,
    face_enhancement_creativity: 0,
  };
}
