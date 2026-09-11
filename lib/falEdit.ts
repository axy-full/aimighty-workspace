import type { ModelDef } from "./models";

/**
 * CR1 §3: the vendor's input for an edit engine on fal — Nano Banana 2 Edit
 * (a still or several, and the words that say what changes; a size and an
 * aspect) and Flux Kontext (exactly one still, the edit in words, the output
 * at the still's own size). Pure: the stills are URLs already; the call
 * lives in lib/falImage.ts. No safety field is loosened: Kontext's checker
 * is on by default and its verdict is read back.
 */
export function falEditInput(model: ModelDef, prompt: string, imageUrls: string[], ratio: string, size: string): { endpoint: string; input: Record<string, unknown> } {
  const endpoint = model.falEndpoint ?? model.id;
  if (model.family === "flux") {
    if (!imageUrls.length) throw new Error(`${model.label} needs a still to work from.`);
    return { endpoint, input: { prompt: prompt.trim(), image_url: imageUrls[0], output_format: "png" } };
  }
  if (!imageUrls.length) throw new Error(`${model.label} needs a still to work from.`);
  return { endpoint, input: {
    prompt: prompt.trim(),
    num_images: 1,
    resolution: model.resolutions.includes(size) ? size : model.resolutions[0],
    aspect_ratio: ratio === "adaptive" || !model.ratios.includes(ratio) ? "auto" : ratio,
    image_urls: imageUrls,
  } };
}
