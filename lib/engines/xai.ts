import type { EngineAdapter } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateCostUsd, estimateImageCostUsd } from "../vendorPricing";
import { vendorStill } from "../vendorImages";
import { pollXaiVideo, submitXaiVideo } from "../xaiVideo";
import { grokSpeech, grokSpeechUsd } from "../xaiVoice";
import { fetchBytes } from "../mockFs";
import { PreflightError } from "../preflight";

/**
 * xAI's Grok: Imagine stills (synchronous, on the xAI key or through the
 * gateway), Imagine video (asynchronous, on the xAI key only —
 * lib/xaiVideo.ts), and Grok Voice speech (on the xAI key — lib/xaiVoice.ts).
 */
export const xai: EngineAdapter = {
  id: "xai",
  kinds: ["image", "video", "audio"],
  configured: () => providerConfigured(getProvider("xai")),
  estimate(req) {
    if (req.kind === "image") return estimateImageCostUsd(req.model.id, req.size, req.references.length)?.net ?? null;
    if (req.kind === "audio") return req.task === "speech" ? grokSpeechUsd(req.text) : null;
    if (req.kind === "video") return estimateCostUsd(req.model.id, req.params.resolution, req.params.ratio, req.params.duration, 0, false, { task: req.task.id })?.net ?? null;
    return null;
  },
  async render(req) {
    if (req.kind === "video") {
      const ref = await submitXaiVideo(req.model, req.prompt, req.params, req.references);
      return { handle: { provider: "xai", ref, model: req.model.id } };
    }
    if (req.kind === "audio") {
      if (req.task !== "speech") throw new PreflightError("Grok Voice speaks lines; other sound is ElevenLabs'.");
      const p = req.params;
      const out = await grokSpeech({ text: req.text, voiceId: String(p.voiceId), language: typeof p.language === "string" ? p.language : undefined, speed: typeof p.speed === "number" ? p.speed : undefined });
      return { produced: { bytes: out.bytes, mime: out.mime, costUsd: out.costUsd, totalTokens: null, credits: null, requestId: null } };
    }
    if (req.kind !== "image") throw new Error("Grok renders stills, video and speech.");
    const img = await vendorStill({ model: req.model, prompt: req.prompt, ratio: req.ratio, size: req.size, references: req.references });
    return { produced: { bytes: img.bytes, mime: img.mime, costUsd: img.costUsd, totalTokens: img.totalTokens, via: img.via } };
  },
  poll: (handle) => pollXaiVideo(handle.ref),
  fetchMaster: (url) => fetchBytes(url),
};
