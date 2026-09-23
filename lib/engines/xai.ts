import type { EngineAdapter } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateCostUsd, estimateImageCostUsd } from "../vendorPricing";
import { vendorStill } from "../vendorImages";
import { pollXaiVideo, submitXaiVideo } from "../xaiVideo";
import { fetchBytes } from "../mockFs";

/**
 * xAI's Grok Imagine: stills (synchronous, on the xAI key or through the
 * gateway) and video (asynchronous, on the xAI key only — lib/xaiVideo.ts).
 */
export const xai: EngineAdapter = {
  id: "xai",
  kinds: ["image", "video"],
  configured: () => providerConfigured(getProvider("xai")),
  estimate(req) {
    if (req.kind === "image") return estimateImageCostUsd(req.model.id, req.size, req.references.length)?.net ?? null;
    if (req.kind === "video") return estimateCostUsd(req.model.id, req.params.resolution, req.params.ratio, req.params.duration, 0, false, { task: req.task.id })?.net ?? null;
    return null;
  },
  async render(req) {
    if (req.kind === "video") {
      const ref = await submitXaiVideo(req.model, req.prompt, req.params, req.references);
      return { handle: { provider: "xai", ref, model: req.model.id } };
    }
    if (req.kind !== "image") throw new Error("Grok Imagine renders stills and video.");
    const img = await vendorStill({ model: req.model, prompt: req.prompt, ratio: req.ratio, size: req.size, references: req.references });
    return { produced: { bytes: img.bytes, mime: img.mime, costUsd: img.costUsd, totalTokens: img.totalTokens, via: img.via } };
  },
  poll: (handle) => pollXaiVideo(handle.ref),
  fetchMaster: (url) => fetchBytes(url),
};
