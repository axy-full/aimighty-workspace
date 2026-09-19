import type { EngineAdapter, PollResult } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateCostUsd } from "../vendorPricing";
import { submitTask, fetchTask } from "../ark";
import { fetchBytes } from "../mockFs";

/** ByteDance's Seedance, on BytePlus ModelArk: an asynchronous video engine billed by output tokens. */
export const byteplus: EngineAdapter = {
  id: "byteplus",
  kinds: ["video"],
  configured: () => providerConfigured(getProvider("byteplus")),
  estimate(req) {
    if (req.kind !== "video") return null;
    const p = req.params;
    const inputSeconds = Number((p as { inputSeconds?: number }).inputSeconds ?? 0);
    return estimateCostUsd(req.model.id, p.resolution, p.ratio, p.duration, inputSeconds, req.references.some((r) => r.kind === "video"),
      { audio: p.generateAudio, task: req.task.id, fps60: p.fps60 })?.net ?? null;
  },
  async render(req) {
    if (req.kind !== "video") throw new Error("The video engine renders video.");
    const ref = await submitTask(req.model.id, req.prompt, req.params, req.references);
    return { handle: { provider: "byteplus", ref, model: req.model.id } };
  },
  async poll(handle): Promise<PollResult> {
    const t = await fetchTask(handle.ref);
    return {
      status: t.status as PollResult["status"], videoUrl: t.videoUrl ?? null, totalTokens: t.totalTokens ?? null,
      error: t.error ?? null, vendorStartedAt: t.vendorStartedAt ?? null, vendorEndedAt: t.vendorEndedAt ?? null, raw: t.raw,
    };
  },
  fetchMaster: (url) => fetchBytes(url),
};
