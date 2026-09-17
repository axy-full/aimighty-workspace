import { isIP } from "node:net";
import type { EngineAdapter, PollResult, StillRenderRequest } from "./types";
import { SOUL_CHARACTER_MODEL_ID } from "../models";
import { estimateImageCostUsd } from "../vendorPricing";
import { soulCharacterGenerationEnabled } from "../vendorRates";
import { recoveryFetch } from "../recovery";
import { engineMock, fixtureUrl, isMockJob, mockDone, mockJobId } from "../mock";
import { fixtureBytes } from "../mockFs";
import {
  HiggsfieldHttpError, higgsfieldConfigured, higgsfieldCredentials,
  higgsfieldCredentialFingerprint,
} from "../higgsfield";

const API_ORIGIN = "https://api.higgsfield.ai";
const ENDPOINT = `${API_ORIGIN}/higgsfield-ai/soul/character`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATIOS = new Set(["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"]);

/** This is the Soul Character contract in Higgsfield's supplementary OpenAPI,
 * not the Soul 2 Standard endpoint. Availability and pricing need verification
 * by the operator before the private gate is enabled. One take buys one image. */
export function soulCharacterInput(req: StillRenderRequest) {
  const strength = req.soulStrength ?? 1;
  if (req.model.id !== SOUL_CHARACTER_MODEL_ID || !UUID.test(req.soulReferenceId ?? ""))
    throw new HiggsfieldHttpError(422, "Choose a completed Soul identity for this still.");
  if (!req.prompt.trim() || !RATIOS.has(req.ratio) || !["720p", "1080p"].includes(req.size) || req.references.length ||
      !Number.isFinite(strength) || strength < 0 || strength > 1)
    throw new HiggsfieldHttpError(422, "Soul Character needs a prompt, a supported size and ratio, and no additional image references.");
  return {
    prompt: req.prompt,
    custom_reference_id: req.soulReferenceId!,
    custom_reference_strength: strength,
    batch_size: 1,
    resolution: req.size,
    aspect_ratio: req.ratio,
    enhance_prompt: false,
  };
}

/** A provider response must never redirect our credentials to another origin. */
export function soulStatusUrl(value: unknown, requestId: string): string {
  if (!UUID.test(requestId) || typeof value !== "string")
    throw new Error("Higgsfield returned an unusable request handle. The submission may have been accepted.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Higgsfield returned an invalid status URL."); }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/requests/${requestId}/status`)
    throw new Error("Higgsfield returned an unexpected status URL. The submission will not be repeated.");
  return url.toString();
}

function sameCredentials(expected?: string): void {
  let current: string | undefined;
  try { current = higgsfieldCredentialFingerprint(); } catch { /* Missing credentials cannot submit or collect. */ }
  if (!expected || expected !== current)
    throw new HiggsfieldHttpError(401, "The Higgsfield connection changed. Restore the original connection before collecting this Soul request.");
}

async function call(url: string, method: "POST" | "GET", body?: unknown): Promise<Record<string, unknown>> {
  const credentials = higgsfieldCredentials();
  const response = await recoveryFetch(url, {
    method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Key ${credentials.keyId}:${credentials.keySecret}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HiggsfieldHttpError(response.status, `Higgsfield ${method === "POST" ? "submission" : "status check"} returned ${response.status}.`);
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Higgsfield returned an unreadable response. The submission will not be repeated.");
  return data as Record<string, unknown>;
}

function imageUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Higgsfield returned no image master. The request remains available for collection.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Higgsfield returned an invalid image URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.includes(".") || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")))
    throw new Error("Higgsfield returned an unsupported image URL.");
  return url.toString();
}

export const higgsfield: EngineAdapter = {
  id: "higgsfield",
  kinds: ["image"],
  configured: () => higgsfieldConfigured() && soulCharacterGenerationEnabled(),
  estimate(req) {
    if (req.kind !== "image" || req.model.id !== SOUL_CHARACTER_MODEL_ID || !soulCharacterGenerationEnabled()) return null;
    return estimateImageCostUsd(req.model.id, req.size, 0)?.net ?? null;
  },
  async render(req) {
    if (req.kind !== "image") throw new HiggsfieldHttpError(422, "Soul Character produces still images.");
    const input = soulCharacterInput(req);
    if (!soulCharacterGenerationEnabled())
      throw new HiggsfieldHttpError(400, "Soul Character is awaiting verified availability and pricing.");
    sameCredentials(req.soulCredentialFingerprint);
    if (engineMock()) return { handle: {
      provider: "higgsfield", model: SOUL_CHARACTER_MODEL_ID, ref: mockJobId("higgsfield"),
      credentialFingerprint: req.soulCredentialFingerprint,
    } };
    // Exactly one POST. Ambiguous failures retain the durable paid claim.
    const result = await call(ENDPOINT, "POST", input);
    const ref = typeof result.request_id === "string" ? result.request_id : "";
    if (!UUID.test(ref)) throw new Error("Higgsfield returned no usable request identifier. The submission will not be repeated.");
    // Persist an accepted UUID even if its status URL is malformed. Poll validates
    // the exact origin/path before sending credentials, leaving the id recoverable.
    const endpoint = typeof result.status_url === "string" ? result.status_url : undefined;
    return { handle: { provider: "higgsfield", model: SOUL_CHARACTER_MODEL_ID, ref, endpoint,
      credentialFingerprint: req.soulCredentialFingerprint } };
  },
  async poll(handle): Promise<PollResult> {
    if (handle.provider !== "higgsfield" || handle.model !== SOUL_CHARACTER_MODEL_ID)
      throw new Error("Unsupported Higgsfield request handle.");
    // Collection remains possible after an operator disables new submissions.
    sameCredentials(handle.credentialFingerprint);
    let raw: Record<string, unknown>;
    if (engineMock() && isMockJob(handle.ref)) {
      raw = { request_id: handle.ref, status: mockDone(handle.ref) ? "completed" : "queued", images: [{ url: fixtureUrl("still.png") }] };
    } else {
      raw = await call(soulStatusUrl(handle.endpoint, handle.ref), "GET");
      if (raw.request_id !== handle.ref) throw new Error("Higgsfield returned a different request identifier.");
    }
    const statuses: Record<string, PollResult["status"]> = {
      queued: "queued", in_progress: "running", completed: "succeeded", failed: "failed", nsfw: "failed", canceled: "cancelled",
    };
    const status = statuses[String(raw.status)];
    if (!status) throw new Error("Higgsfield returned an unknown request status.");
    let master: string | null = null;
    if (status === "succeeded") {
      const images = raw.images;
      if (!Array.isArray(images) || images.length !== 1)
        throw new Error("Higgsfield returned an unexpected image count. The request remains available for collection.");
      master = engineMock() && isMockJob(handle.ref) ? fixtureUrl("still.png") : imageUrl(images[0]?.url);
    }
    return { status, imageUrl: master, videoUrl: null, totalTokens: null,
      error: raw.status === "nsfw" ? "Higgsfield rejected this generation during moderation." :
        status === "failed" ? "Higgsfield could not complete this generation." : null,
      vendorStartedAt: null, vendorEndedAt: null, raw };
  },
  async fetchMaster(value) {
    if (engineMock() && value === fixtureUrl("still.png")) return fixtureBytes("still.png");
    const response = await recoveryFetch(imageUrl(value), {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
    });
    const maxBytes = 100 * 1024 * 1024;
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("The Higgsfield image master could not be downloaded.");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error("The Higgsfield image exceeds the download limit."); }
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
    if (!total) throw new Error("Higgsfield returned an empty image master.");
    return Buffer.concat(chunks, total);
  },
};
