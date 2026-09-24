import type { ModelDef } from "./models";
import type { Reference, VideoParams } from "./ark";
import type { PollResult } from "./engines/types";
import { refPayload } from "./gemini";
import { vendorKey } from "./vendorKeys";
import { recoveryFetch } from "./recovery";
import { engineMock, fixtureUrl, isMockJob, mockDone, mockJobId, mockStartedAt } from "./mock";

/**
 * xAI's Grok Imagine Video (owner, 23 September: Grok APIs wherever
 * possible), on the xAI key and billed as an xAI charge. Asynchronous like
 * Seedance: a request id from POST /v1/videos/generations, then GET
 * /v1/videos/{id} until it is done. The gateway serves Grok video only as one
 * blocking stream, which a render worker cannot hold, so there is no gateway
 * door for video (models are directOnly).
 */
const BASE = () => (process.env.XAI_BASE_URL ?? "https://api.x.ai/v1").replace(/\/$/, "");
function key(): string {
  const value = vendorKey("xai");
  if (!value) throw new Error("Grok Imagine Video needs the xAI account connected for this workspace.");
  return value;
}
async function dataUrl(ref: Reference): Promise<string> {
  const { mime, b64 } = await refPayload(ref);
  return `data:${mime};base64,${b64}`;
}

/** What xAI is sent: the prompt, length, shape and size; a first frame animates, reference images guide (at most 720p). */
export async function xaiVideoBody(model: ModelDef, prompt: string, params: VideoParams, references: Reference[]) {
  const body: Record<string, unknown> = { model: model.id, prompt, duration: params.duration, aspect_ratio: params.ratio, resolution: params.resolution };
  const first = references.find((ref) => ref.kind === "image" && ref.role === "first_frame");
  const guides = references.filter((ref) => ref.kind === "image" && ref.role === "reference_image");
  if (references.some((ref) => ref.kind === "video")) throw new Error(`${model.label} takes images, not videos, as references.`);
  if (first && guides.length) throw new Error(`${model.label} takes a first frame or reference images, not both.`);
  if (first) body.image = { url: await dataUrl(first) };
  else if (guides.length) {
    if (params.resolution === "1080p") throw new Error(`${model.label} renders from reference images at up to 720p. Choose 720p or 480p.`);
    body.reference_images = await Promise.all(guides.map(async (ref) => ({ url: await dataUrl(ref) })));
  }
  return body;
}

export async function submitXaiVideo(model: ModelDef, prompt: string, params: VideoParams, references: Reference[]): Promise<string> {
  if (engineMock()) return mockJobId("xai", `${params.resolution}-${params.duration}`);
  const body = await xaiVideoBody(model, prompt, params, references);
  const res = await recoveryFetch(`${BASE()}/videos/generations`, {
    method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 400);
    try { const parsed = JSON.parse(text); message = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? message; } catch { /* raw */ }
    throw Object.assign(new Error(`Grok Imagine Video refused the request (${res.status}): ${message}`), { status: res.status });
  }
  const id = (JSON.parse(text) as { request_id?: string }).request_id;
  if (!id) throw new Error("Grok Imagine Video returned no request id.");
  return id;
}

/** One look at a request: running, done (with the clip and xAI's charge), or failed. */
export async function pollXaiVideo(id: string): Promise<PollResult & { costUsd: number | null }> {
  if (isMockJob(id)) {
    const done = mockDone(id);
    return { status: done ? "succeeded" : "running", videoUrl: done ? fixtureUrl("clip.mp4") : null, totalTokens: null, error: null,
      vendorStartedAt: mockStartedAt(id), vendorEndedAt: done ? Date.now() : null, raw: null, costUsd: null };
  }
  const res = await recoveryFetch(`${BASE()}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key()}` }, cache: "no-store", signal: AbortSignal.timeout(30_000), redirect: "error" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Grok Imagine Video status failed (${res.status}): ${text.slice(0, 300)}`);
  const reply = JSON.parse(text) as { status?: string; video?: { url?: string; respect_moderation?: boolean | null }; usage?: { cost_in_usd_ticks?: number | null }; error?: { code?: string; message?: string } };
  const ticks = reply.usage?.cost_in_usd_ticks;
  const base = { totalTokens: null, vendorStartedAt: null, vendorEndedAt: null, raw: reply, imageUrl: null };
  if (reply.status === "failed" || reply.status === "expired")
    return { ...base, status: "failed", videoUrl: null, error: reply.error?.message ?? reply.error?.code ?? (reply.status === "expired" ? "The Grok video request expired." : "Grok Imagine Video could not make this clip."), costUsd: null };
  if (reply.status === "done" || (reply.status == null && reply.video?.url)) {
    if (reply.video?.respect_moderation === false) return { ...base, status: "failed", videoUrl: null, error: "Grok Imagine Video declined this clip under its content policy.", costUsd: null };
    if (!reply.video?.url) return { ...base, status: "failed", videoUrl: null, error: "Grok Imagine Video finished without a clip.", costUsd: null };
    /* xAI bills in ticks: ten billion to the dollar (checked against the quote before it is billed). */
    return { ...base, status: "succeeded", videoUrl: reply.video.url, error: null, vendorEndedAt: Date.now(), costUsd: typeof ticks === "number" ? ticks / 1e10 : null };
  }
  return { ...base, status: "running", videoUrl: null, error: null, costUsd: null };
}
