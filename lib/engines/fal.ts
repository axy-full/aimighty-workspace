import type { EngineAdapter, PollResult } from "./types";
import { providerConfigured, getProvider } from "../providers";
import { estimateCostUsd, estimateImageCostUsd } from "../vendorPricing";
import { submitFalVideo } from "../falVideo";
import { falStatus, falResult, falCancel, FalHttpError } from "../fal";
import { mockQueueKind, mockIsCancelled, mockCancel } from "../mockQueue";
import { fetchBytes } from "../mockFs";
import { TOPAZ_IMAGE_MODEL } from "../topaz";
import { renderFalStill, submitTopazImage } from "../falImage";

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
    if (req.kind === "image")
      return (
        estimateImageCostUsd(req.model.id, req.size, req.references.length)
          ?.net ?? null
      );
    if (req.kind !== "video") return null;
    const p = req.params;
    const inputSeconds = Number(
      (p as { inputSeconds?: number }).inputSeconds ?? 0,
    );
    return (
      estimateCostUsd(
        req.model.id,
        p.resolution,
        p.ratio,
        p.duration,
        inputSeconds,
        req.references.some((r) => r.kind === "video"),
        { audio: p.generateAudio, task: req.task.id, fps60: p.fps60 },
      )?.net ?? null
    );
  },
  async render(req) {
    if (req.kind === "image") {
      if (req.model.id === TOPAZ_IMAGE_MODEL) {
        const q = await submitTopazImage(req);
        return {
          handle: {
            provider: "fal",
            model: req.model.id,
            endpoint: req.model.id,
            ref: q.request_id,
          },
        };
      }
      const out = await renderFalStill({
        model: req.model,
        ratio: req.ratio,
        prompt: req.prompt,
        references: req.references,
        size: req.size,
        topaz: req.topaz,
      });
      return {
        produced: {
          bytes: out.bytes,
          mime: out.mime,
          costUsd: out.costUsd,
          totalTokens: null,
          via: "fal",
        },
      };
    }
    if (req.kind !== "video")
      throw new Error("Identities are driven from lib/identities.ts.");
    const q = await submitFalVideo({
      model: req.model,
      task: req.task,
      prompt: req.prompt,
      params: req.params,
      references: req.references,
      source: req.source,
    });
    return {
      handle: {
        provider: "fal",
        ref: q.requestId,
        model: req.model.id,
        endpoint: q.endpoint,
      },
    };
  },
  /** Status, then the result once it is complete. Throws as the vendor client throws; the caller reads the message. */
  async poll(handle): Promise<PollResult> {
    /* A mocked job parked in the vendor's queue (lib/mockQueue.ts): in the queue until cancelled, then gone (fal answers 404). */
    const parked = mockQueueKind(handle.ref);
    if (parked) {
      if (mockIsCancelled(handle.ref)) throw new FalHttpError(404, "The render service returned 404: request not found.");
      return { status: parked === "running" ? "running" : "queued", videoUrl: null, totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: null };
    }
    const endpoint = handle.endpoint ?? handle.model;
    const st = await falStatus(endpoint, handle.ref);
    if (st.status !== "COMPLETED") {
      return {
        status: st.status === "IN_QUEUE" ? "queued" : "running",
        videoUrl: null,
        totalTokens: null,
        error: null,
        vendorStartedAt: null,
        vendorEndedAt: null,
        raw: st,
      };
    }
    const out = await falResult<{ video?: { url?: string } }>(
      endpoint,
      handle.ref,
    );
    const url = out?.video?.url ?? null;
    if (!url)
      return {
        status: "failed",
        videoUrl: null,
        totalTokens: null,
        error: "The render service finished but returned no video.",
        vendorStartedAt: null,
        vendorEndedAt: null,
        raw: out,
      };
    return {
      status: "succeeded",
      videoUrl: url,
      totalTokens: null,
      error: null,
      vendorStartedAt: null,
      vendorEndedAt: null,
      raw: out,
    };
  },
  /** Take a request off fal's queue (lib/fal.ts falCancel). Only lib/queuedCancel.ts calls it, after a status read said IN_QUEUE. */
  async cancel(handle) {
    if (mockQueueKind(handle.ref)) {
      if (mockCancel(handle.ref) === "running") throw new FalHttpError(400, "The render service returned 400: already running.", null);
      return;
    }
    await falCancel(handle.endpoint ?? handle.model, handle.ref);
  },
  fetchMaster: (url) => fetchBytes(url),
};
