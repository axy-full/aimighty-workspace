import type { EngineAdapter, PollResult } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateCostUsd } from "../vendorPricing";
import { submitFalVideo } from "../falVideo";
import { falStatus, falResult } from "../fal";
import { fetchBytes } from "../mockFs";
import { renderFalStill } from "../falImage";

/**
 * fal.ai: one adapter, several media models behind it — Kling 3.0 and its
 * motion control, Topaz Astra, and the identity trainer and renderer that
 * lib/identities.ts drives. Video is asynchronous on fal's own queue.
 */
export const fal: EngineAdapter = {
  id: "fal",
  kinds: ["video", "image"],
  configured: () => providerConfigured(getProvider("fal")),
  estimate(req) {
    if (req.kind !== "video") return null;
    const p = req.params;
    const inputSeconds = Number((p as { inputSeconds?: number }).inputSeconds ?? 0);
    return estimateCostUsd(req.model.id, p.resolution, p.ratio, p.duration, inputSeconds, req.references.some((r) => r.kind === "video"),
      { audio: p.generateAudio, task: req.task.id, fps60: p.fps60 })?.net ?? null;
  },
  async render(req) {
    if (req.kind === "image") {
      const out = await renderFalStill({ model: req.model, ratio: req.ratio, size: req.size, prompt: req.prompt, references: req.references });
      return { produced: { bytes: out.bytes, mime: out.mime, costUsd: out.costUsd, totalTokens: null, via: "fal" } };
    }
    if (req.kind !== "video") throw new Error("Identities on fal are driven from lib/identities.ts.");
    const q = await submitFalVideo({ model: req.model, task: req.task, prompt: req.prompt, params: req.params, references: req.references, source: req.source });
    return { handle: { provider: "fal", ref: q.requestId, model: req.model.id, endpoint: q.endpoint } };
  },
  /** Status, then the result once it is complete. Throws as the vendor client throws; the caller reads the message. */
  async poll(handle): Promise<PollResult> {
    const endpoint = handle.endpoint ?? handle.model;
    const st = await falStatus(endpoint, handle.ref);
    if (st.status !== "COMPLETED") {
      return { status: st.status === "IN_QUEUE" ? "queued" : "running", videoUrl: null, totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: st };
    }
    const out = await falResult<{ video?: { url?: string } }>(endpoint, handle.ref);
    const url = out?.video?.url ?? null;
    if (!url) return { status: "failed", videoUrl: null, totalTokens: null, error: "fal.ai finished but returned no video.", vendorStartedAt: null, vendorEndedAt: null, raw: out };
    return { status: "succeeded", videoUrl: url, totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: out };
  },
  fetchMaster: (url) => fetchBytes(url),
};
