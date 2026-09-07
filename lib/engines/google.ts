import type { EngineAdapter } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateImageCostUsd } from "../models";
import { generateImage } from "../gemini";

/** Google's Nano Banana: a synchronous still engine, direct or through the gateway. */
export const google: EngineAdapter = {
  id: "google",
  kinds: ["image"],
  configured: () => providerConfigured(getProvider("google")),
  estimate(req) {
    if (req.kind !== "image") return null;
    return estimateImageCostUsd(req.model.id, req.size, req.references.length)?.net ?? null;
  },
  async render(req) {
    if (req.kind !== "image") throw new Error("Nano Banana renders stills.");
    const img = await generateImage({ model: req.model, prompt: req.prompt, ratio: req.ratio, size: req.size, references: req.references });
    return { produced: { bytes: img.bytes, mime: img.mime, costUsd: img.costUsd ?? null, totalTokens: img.totalTokens ?? null, via: img.via } };
  },
};
