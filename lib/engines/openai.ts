import type { EngineAdapter } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateImageCostUsd } from "../vendorPricing";
import { vendorStill } from "../vendorImages";

/** OpenAI's GPT Image: a synchronous still engine, direct on the OpenAI key or through the gateway. */
export const openai: EngineAdapter = {
  id: "openai",
  kinds: ["image"],
  configured: () => providerConfigured(getProvider("openai")),
  estimate(req) {
    if (req.kind !== "image") return null;
    return estimateImageCostUsd(req.model.id, req.size, req.references.length)?.net ?? null;
  },
  async render(req) {
    if (req.kind !== "image") throw new Error("GPT Image renders stills.");
    const img = await vendorStill({ model: req.model, prompt: req.prompt, ratio: req.ratio, size: req.size, references: req.references });
    return { produced: { bytes: img.bytes, mime: img.mime, costUsd: img.costUsd, totalTokens: img.totalTokens, via: img.via } };
  },
};
