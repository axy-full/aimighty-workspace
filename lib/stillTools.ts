import type { ModelDef } from "./models";
import { MODELS } from "./models";

/**
 * The still post tools (brief 1.2), the part both the browser and the
 * server read: what they are, which Bria row serves each, and the vendor's
 * input for one. No Node imports — the theatre prices a tool from here.
 * The call itself lives in lib/falImage.ts.
 */
export type StillTool = "outpaint" | "cutout";

export const STILL_TOOLS: { id: StillTool; label: string; blurb: string; modelId: string }[] = [
  { id: "outpaint", label: "Outpaint", blurb: "Extend a still to another aspect, painting in what the wider or taller frame reveals.", modelId: "fal-ai/bria/expand" },
  { id: "cutout", label: "Cut out", blurb: "Lift the subject off its background, transparent behind it.", modelId: "fal-ai/bria/background/remove" },
];

export const stillToolFor = (modelId: string): StillTool | null => STILL_TOOLS.find((t) => t.modelId === modelId)?.id ?? null;
export const stillToolModel = (tool: StillTool): ModelDef => MODELS.find((m) => m.id === STILL_TOOLS.find((t) => t.id === tool)!.modelId)!;

/** Bria's canvas for a target aspect: the long edge at 2048, the short edge to match, both even. */
export function canvasFor(ratio: string): [number, number] {
  const [w, h] = ratio.split(":").map(Number);
  if (!(w > 0) || !(h > 0)) return [2048, 2048];
  const even = (n: number) => Math.round(n / 2) * 2;
  return w >= h ? [2048, even((2048 * h) / w)] : [even((2048 * w) / h), 2048];
}

/** The vendor's input for a tool. Pure: the still is already a URL. */
export function falImageInput(tool: StillTool, imageUrl: string, ratio: string, prompt = ""): { endpoint: string; input: Record<string, unknown> } {
  if (tool === "cutout") return { endpoint: "fal-ai/bria/background/remove", input: { image_url: imageUrl } };
  const model = stillToolModel("outpaint");
  const aspect = model.ratios.includes(ratio) ? ratio : "9:16";
  return {
    endpoint: "fal-ai/bria/expand",
    input: { image_url: imageUrl, canvas_size: canvasFor(aspect), aspect_ratio: aspect, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) },
  };
}
