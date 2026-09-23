import type { EngineAdapter } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateImageCostUsd } from "../vendorPricing";
import { vendorStill } from "../vendorImages";

/** xAI's Grok Imagine: a synchronous still engine, direct on the xAI key or through the gateway. */
export const xai: EngineAdapter = {
  id: "xai",
  kinds: ["image"],
  configured: () => providerConfigured(getProvider("xai")),
  estimate(req) {
    if (req.kind !== "image") return null;
    return estimateImageCostUsd(req.model.id, req.size, req.references.length)?.net ?? null;
  },
  async render(req) {
    if (req.kind !== "image") throw new Error("Grok Imagine renders stills.");
    const img = await vendorStill({ model: req.model, prompt: req.prompt, ratio: req.ratio, size: req.size, references: req.references });
    return { produced: { bytes: img.bytes, mime: img.mime, costUsd: img.costUsd, totalTokens: img.totalTokens, via: img.via } };
  },
};
