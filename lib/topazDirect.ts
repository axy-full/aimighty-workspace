import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";
import { astraSettings, type AstraSettings } from "./astra";
import { TOPAZ_RATES } from "./vendorRates";
import { topazImageOutput, topazImageSettings, type TopazImageSettings } from "./topaz";

/**
 * Topaz Labs' own API, DIRECT (owner, 15 Oct 2026, 14:05: "Topaz goes DIRECT"): image and video upscale with the same presets and controls as today (lib/topaz.ts for stills,
 * lib/astra.ts for clips), in place of the fal route, behind its own kill switch. THIS FILE IS THE ADAPTER ONLY: it is not wired into a route, a job, a price or a list, and nothing
 * outside it imports it yet. The workflow (the take's row, the reservation, settlement, reconcile, the tool) is wired in a later commit on the head the lead names.
 *
 * Settings (names only; there are no others): TOPAZ_API_KEY, and TOPAZ_DIRECT_ENABLED (the kill switch, through lib/engineGate.ts when it is wired; `TOPAZ_SWITCH` below names it).
 * The address is fixed (api.topazlabs.com); a test stands in by passing `deps.fetch`. Under ENGINE_MOCK=1 nothing is called: a fixture answers, in process.
 *
 * What is called (docs/plans/provider-adapters.md § 8, docs/plans/topaz-direct-prices.md, docs/redesign/cancel-billing.md): for a still, `POST /image/v1/enhance/async` (the original's
 * bytes, read on the server: our storage links never leave Particl), `GET /image/v1/status/{process_id}`, `GET /image/v1/download/{process_id}`, and `DELETE /image/v1/cancel/{process_id}`;
 * for a clip, `POST /video/` (the request, with Topaz's own estimate), `PATCH /video/{requestId}/accept` (the upload addresses), a `PUT` of each part, `PATCH /video/{requestId}/complete-upload`,
 * `GET /video/{requestId}/status`, the output, `DELETE /video/{requestId}/media` (the vendor's copy), and `DELETE /video/{requestId}` (cancel).
 * **The request and reply field names follow Topaz's public API as the plan records it and are TO CONFIRM in the first qualification run** (a paid run needs the owner's yes; none is made
 * here). Every reply is read defensively: a field that is not what is expected is a provider failure, never a guess, and nothing is billed on a failure.
 *
 * No call here is ever repeated: a failed or unanswered request throws once, and the caller (which holds the reservation and the take's row) decides. In particular the one request that starts
 * paid work is never resent for the same job; a lost acknowledgement is the caller's "uncertain", not a second submit.
 */
export const TOPAZ_SWITCH = "TOPAZ_DIRECT_ENABLED";
const BASE = "https://api.topazlabs.com";
const TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 20_000;
export const TOPAZ_OUTPUT_LIMIT_BYTES = 1024 * 1024 * 1024;
export const TOPAZ_IMAGE_OUTPUT_LIMIT_BYTES = 200 * 1024 * 1024;

export { TOPAZ_RATES };
export type TopazVideoTier = keyof typeof TOPAZ_RATES.videoCreditsPerSecondAt30;

/** The credits a still costs by its output size (megapixels). Over 48 MP is not offered. */
export function topazImageCredits(outputMegapixels: number): number {
  if (!Number.isFinite(outputMegapixels) || outputMegapixels <= 0) throw new TopazError("The still's output size is not known.");
  const tier = TOPAZ_RATES.imageTiers.find((t) => outputMegapixels <= t.maxMegapixels);
  if (!tier) throw new TopazError("Topaz image output is limited to 48 megapixels.");
  return tier.credits;
}

/** The credits a clip costs: its output frames at the tier's rate, rounded up to a whole credit. */
export function topazVideoCredits(input: { seconds: number; fps: number; tier: TopazVideoTier }): number {
  const { seconds, fps, tier } = input;
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(fps) || fps <= 0 || !(tier in TOPAZ_RATES.videoCreditsPerSecondAt30)) throw new TopazError("The clip's length, frame rate or size is not known.");
  return Math.ceil(seconds * fps * (TOPAZ_RATES.videoCreditsPerSecondAt30[tier] / 30) - 1e-9);
}

/** What a number of Topaz credits costs us, in dollars (the engine cost; customer prices come only through the server's price path). Rounded to the cent-and-a-bit the credit allows. */
export const topazCreditsUsd = (credits: number): number => Math.round(credits * TOPAZ_RATES.usdPerCredit * 1e6) / 1e6;

/** A quote's engine cost for a still of this output size, and for a clip. */
export const topazImageQuoteUsd = (outputMegapixels: number): number => topazCreditsUsd(topazImageCredits(outputMegapixels));
export const topazVideoQuoteUsd = (input: { seconds: number; fps: number; tier: TopazVideoTier }): number => topazCreditsUsd(topazVideoCredits(input));
/** The output tier a clip's delivered height is priced at: 720p and 1080p are the 1080p tier, anything taller is 4K. */
export const topazVideoTierOf = (outputHeight: number): TopazVideoTier => (outputHeight > 1080 ? "4k" : "1080p");

/**
 * What the job settles at: the credits Topaz says it used, as dollars, never more than the quote (the reservation). `null` when Topaz did not say (the caller then settles at the quote
 * or reconciles, as its workflow decides); a figure above the quote is capped and reported as `capped`, which the caller keeps in reconciliation against the invoice.
 */
export function topazSettleUsd(reportedCredits: number | null | undefined, quotedUsd: number): { usd: number; capped: boolean } | null {
  if (reportedCredits == null || !Number.isFinite(reportedCredits) || reportedCredits < 0) return null;
  const used = topazCreditsUsd(reportedCredits);
  return used > quotedUsd ? { usd: quotedUsd, capped: true } : { usd: used, capped: false };
}

/**
 * An address Topaz gave us (an upload address, an output address), accepted only as an https host on topazlabs.com or under it, or on a bucket of Topaz's own on Amazon S3, with no port and no
 * credentials. Nothing else is ever fetched. Every request here also refuses redirects (`redirect: "error"`): a redirect would carry our key, or our bytes, to a host this list never saw.
 *
 * **TO CONFIRM against the first qualification run:** Topaz's video API hands out presigned storage addresses and its pages we could read name no bucket. The narrowest pattern that can be
 * justified is used: a virtual-hosted S3 address (`<bucket>.s3[.region].amazonaws.com`, never path-style `s3.amazonaws.com/<bucket>`) whose bucket name has `topaz` in it. If Topaz's
 * buckets are named otherwise, an upload or a download is refused (the job ends "Nothing billed" and its request is cancelled): it fails safe, and the list is widened to the bucket the run
 * shows, in this one place.
 */
export const TOPAZ_STORAGE_HOST = /^(?=[a-z0-9.-]*topaz)[a-z0-9][a-z0-9.-]*\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
export function topazHostUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return host === "topazlabs.com" || host.endsWith(".topazlabs.com") || TOPAZ_STORAGE_HOST.test(host) ? url : null;
}

export const topazConfigured = (): boolean => Boolean(process.env.TOPAZ_API_KEY) || engineMock();

/** A refusal or failure from Topaz (or from reaching it). `rejectedBeforeWork`: it answered 4xx before any work, so nothing was taken. */
export class TopazError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly body: unknown = null, readonly rejectedBeforeWork = false) { super(message); this.name = "TopazError"; }
}

function key(): string {
  const value = process.env.TOPAZ_API_KEY;
  if (!value) throw new TopazError("Upscaling is not set up: TOPAZ_API_KEY is needed.");
  return value;
}

type Deps = { fetch?: typeof fetch };
type Reply = { status: number; json: Record<string, unknown>; headers: Headers };

async function call(method: string, path: string, init: { json?: unknown; form?: FormData; deps?: Deps; timeout?: number } = {}): Promise<Reply> {
  let res: Response;
  try {
    res = await (init.deps?.fetch ?? recoveryFetch)(`${BASE}${path}`, {
      method,
      headers: { "x-api-key": key(), accept: "application/json", ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.form ? { body: init.form } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeout ?? TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof TopazError) throw error;
    throw new TopazError("Topaz did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const said = typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : "";
    throw new TopazError(said ? `Topaz refused the request: ${said.slice(0, 200)}` : `Topaz answered ${res.status}.`, res.status, json, res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  }
  return { status: res.status, json, headers: res.headers };
}

const finiteOrUndefined = (value: unknown): number | undefined => { const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN; return Number.isFinite(n) && n >= 0 ? n : undefined; };

/* ── Fixture (ENGINE_MOCK=1) ───────────────────────────────────────────────── */
const mockImages = new Map<string, { polls: number; credits: number }>();
const mockVideos = new Map<string, { polls: number; credits: number; accepted: boolean }>();
let mockSeq = 0;
/** A one-pixel PNG, so what the fixture returns is a real picture for the storage and the cards. */
export const MOCK_TOPAZ_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/** The first bytes of an MP4 (an `ftyp` box), enough for a media check; the fixture's clip has no frames. */
export const MOCK_TOPAZ_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);

/* ── Still ─────────────────────────────────────────────────────────────────── */

export type TopazImageStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";
export type TopazImageProcess = { id: string; status: TopazImageStatus; credits?: number; error?: string };

/**
 * Starts one still upscale from the original's bytes. The settings are the ones today's panel offers (lib/topaz.ts); the output size comes from the original's own dimensions (read on the
 * server), never from a client figure. The caller holds the reservation; this is the one paid request, and it is never repeated for the same job.
 */
export async function submitImageUpscale(input: { bytes: Buffer; filename: string; mime: string; width: number; height: number; settings: TopazImageSettings }, deps: Deps = {}): Promise<{ id: string; outputMegapixels: number; credits: number }> {
  const settings = topazImageSettings(input.settings);
  const out = topazImageOutput(input.width, input.height, settings.factor);
  const credits = topazImageCredits((out.width * out.height) / 1_000_000);
  const outputMegapixels = (out.width * out.height) / 1_000_000;
  if (engineMock()) { const id = `mock_topaz_img_${++mockSeq}`; mockImages.set(id, { polls: 0, credits }); return { id, outputMegapixels, credits }; }
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(input.bytes)], { type: input.mime }), input.filename.slice(0, 200) || "original");
  form.set("model", settings.model);
  form.set("output_format", "png");
  form.set("output_width", String(out.width));
  form.set("output_height", String(out.height));
  form.set("crop_to_fill", "false");
  form.set("face_enhancement", settings.faceEnhancement ? "true" : "false");
  form.set("face_enhancement_strength", String(settings.faceStrength));
  form.set("face_enhancement_creativity", "0");
  const { json, status } = await call("POST", "/image/v1/enhance/async", { form, deps });
  const id = json.process_id ?? json.processId ?? json.id;
  if (typeof id !== "string" || !id) throw new TopazError("Topaz's reply named no job.", status);
  return { id, outputMegapixels, credits };
}

const IMAGE_STATUS: Record<string, TopazImageStatus> = { pending: "pending", queued: "pending", processing: "processing", completed: "completed", complete: "completed", failed: "failed", error: "failed", cancelled: "cancelled", canceled: "cancelled" };

/** One poll. A status Topaz does not name here is "processing": never a verdict from a word we do not know. */
export async function imageStatus(id: string, deps: Deps = {}): Promise<TopazImageProcess> {
  if (engineMock()) {
    const job = mockImages.get(id);
    if (!job) throw new TopazError("Topaz has no such job.", 404, null, true);
    job.polls += 1;
    return job.polls < 2 ? { id, status: "processing" } : { id, status: "completed", credits: job.credits };
  }
  const { json } = await call("GET", `/image/v1/status/${encodeURIComponent(id)}`, { deps, timeout: POLL_TIMEOUT_MS });
  const status = IMAGE_STATUS[String(json.status ?? "").toLowerCase()] ?? "processing";
  const credits = finiteOrUndefined(json.credits ?? json.credits_used ?? json.creditsUsed);
  return { id, status, ...(credits !== undefined ? { credits } : {}), ...(typeof json.error === "string" ? { error: json.error.slice(0, 300) } : typeof json.message === "string" && status === "failed" ? { error: json.message.slice(0, 300) } : {}) };
}

async function readCapped(res: Response, limit: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) throw new TopazError(`${what} is larger than Particl keeps.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > limit) throw new TopazError(`${what} came back empty or too large.`);
  return bytes;
}

/** Fetches an output from an address Topaz named (https, its own hosts only, no redirect), capped. */
async function fetchOutput(raw: unknown, limit: number, what: string, deps: Deps): Promise<Buffer> {
  const url = topazHostUrl(raw);
  if (!url) throw new TopazError(`Topaz named no ${what} we can download.`);
  let res: Response;
  try { res = await (deps.fetch ?? recoveryFetch)(url.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(300_000) }); }
  catch { throw new TopazError(`The ${what} could not be downloaded.`); }
  if (!res.ok) throw new TopazError(`The ${what} could not be downloaded (${res.status}).`, res.status);
  return readCapped(res, limit, `The ${what}`);
}

/** The finished still, as PNG bytes: Topaz answers the download with the picture or with an address of one of its own hosts. Nothing is stored here. */
export async function downloadImage(id: string, deps: Deps = {}): Promise<Buffer> {
  if (engineMock()) { if (!mockImages.has(id)) throw new TopazError("Topaz has no such job.", 404, null, true); return Buffer.from(MOCK_TOPAZ_PNG); }
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(`${BASE}/image/v1/download/${encodeURIComponent(id)}`, { method: "GET", headers: { "x-api-key": key() }, redirect: "error", signal: AbortSignal.timeout(300_000) });
  } catch (error) { if (error instanceof TopazError) throw error; throw new TopazError("The upscaled image could not be downloaded."); }
  if (!res.ok) throw new TopazError(`The upscaled image could not be downloaded (${res.status}).`, res.status);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return readCapped(res, TOPAZ_IMAGE_OUTPUT_LIMIT_BYTES, "The upscaled image");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(await res.text()); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  return fetchOutput(json.download_url ?? json.downloadUrl ?? json.url, TOPAZ_IMAGE_OUTPUT_LIMIT_BYTES, "upscaled image", deps);
}

/** Cancels a still that has not finished. True when it is stopped (or was never there). */
export async function cancelImage(id: string, deps: Deps = {}): Promise<boolean> {
  if (engineMock()) { mockImages.delete(id); return true; }
  try { await call("DELETE", `/image/v1/cancel/${encodeURIComponent(id)}`, { deps }); return true; }
  catch (error) { if (error instanceof TopazError && error.status === 404) return true; throw error; }
}

/**
 * The vendor's copy of a still: Topaz's image API names no delete endpoint (docs/plans/topaz-direct-prices.md § 4: image delete endpoints were not read), so there is nothing to call and this says so:
 * `false` means "no endpoint, the copy is Topaz's to expire". The workflow records that, and the data table (docs/legal) says how long Topaz keeps images once that is known. Never a guess at a URL.
 */
export async function deleteImageCopy(id: string): Promise<boolean> {
  void id;
  return false;
}

/* ── Clip ──────────────────────────────────────────────────────────────────── */

export type TopazVideoStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";
export type TopazVideoProcess = { id: string; status: TopazVideoStatus; progress?: number; downloadUrl?: string; credits?: number; error?: string };
export type TopazVideoSource = { container: "mp4" | "mov"; sizeBytes: number; durationSeconds: number; frameRate: number; width: number; height: number };

/** The output a request asks for: Astra 2 to the tier's size at the chosen frame rate, H.264 in MP4, the clip's own sound carried over unchanged. */
export function topazVideoOutput(source: Pick<TopazVideoSource, "width" | "height">, settings: AstraSettings) {
  const s = astraSettings(settings);
  if (![source.width, source.height].every((n) => Number.isSafeInteger(n) && n > 0)) throw new TopazError("The original source dimensions are required for Topaz Astra.");
  /* Astra 2 is asked for 4K on the clip's own aspect, as the fal route's quote has always assumed (lib/astra.ts: a factor to 2160 p, at most 4; here exact, so a 1080 p clip is exactly 2160 p). */
  const factor = Math.min(4, Math.max(1, 2160 / source.height));
  const even = (n: number) => Math.round(n / 2) * 2;
  return { width: even(source.width * factor), height: even(source.height * factor), frameRate: s.fps };
}

/** The model id Topaz's video API names Astra 2 by. TO CONFIRM against its model list in the first qualification run. */
export const TOPAZ_ASTRA_MODEL = "ast-2";

/**
 * Asks Topaz for an upscale of a clip and returns its request id and its own estimate of the credits (a low and a high figure, when it says). Nothing is uploaded and no work has started. Free
 * of charge as far as Topaz's API describes it (TO CONFIRM): the paid work begins when the upload is complete.
 */
export async function createVideoRequest(input: { source: TopazVideoSource; settings: AstraSettings }, deps: Deps = {}): Promise<{ id: string; estimatedCredits: { low: number; high: number } | null; output: ReturnType<typeof topazVideoOutput> }> {
  const settings = astraSettings(input.settings);
  const { source } = input;
  if (![source.sizeBytes, source.durationSeconds, source.frameRate].every((n) => Number.isFinite(n) && n > 0)) throw new TopazError("The original clip's size, length or frame rate is not known.");
  const output = topazVideoOutput(source, settings);
  if (engineMock()) {
    const id = `mock_topaz_vid_${++mockSeq}`;
    const credits = topazVideoCredits({ seconds: source.durationSeconds, fps: settings.fps, tier: topazVideoTierOf(output.height) });
    mockVideos.set(id, { polls: 0, credits, accepted: false });
    return { id, estimatedCredits: { low: Math.max(1, credits - 1), high: credits }, output };
  }
  const { json, status } = await call("POST", "/video/", {
    json: {
      source: { container: source.container, size: Math.round(source.sizeBytes), duration: source.durationSeconds, frameRate: source.frameRate, resolution: { width: source.width, height: source.height } },
      filters: [{ model: TOPAZ_ASTRA_MODEL, creativity: settings.creativity, realism: settings.realism, sharpness: settings.sharpness }],
      output: { resolution: { width: output.width, height: output.height }, frameRate: output.frameRate, audioTransfer: "Copy", audioCodec: "AAC", videoEncoder: "H264", videoProfile: "High", container: "mp4" },
    }, deps,
  });
  const id = json.requestId ?? json.request_id ?? json.id;
  if (typeof id !== "string" || !id) throw new TopazError("Topaz's reply named no request.", status);
  const cost = (json.estimates as { cost?: unknown } | undefined)?.cost;
  const figures = Array.isArray(cost) ? cost.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
  return { id, estimatedCredits: figures.length ? { low: Math.min(...figures), high: Math.max(...figures) } : null, output };
}

/** Accepts the request and returns the addresses to put the clip to, one for each part (https on Topaz's own hosts or its storage; anything else is refused). */
export async function acceptVideo(id: string, deps: Deps = {}): Promise<{ uploadUrls: string[] }> {
  if (engineMock()) { const job = mockVideos.get(id); if (!job) throw new TopazError("Topaz has no such request.", 404, null, true); job.accepted = true; return { uploadUrls: [`https://topaz-mock.s3.amazonaws.com/${id}/part-1`] }; }
  const { json, status } = await call("PATCH", `/video/${encodeURIComponent(id)}/accept`, { deps });
  const raw = json.urls ?? json.uploadUrls ?? json.upload_urls;
  const urls = Array.isArray(raw) ? raw : [];
  const checked = urls.map(topazHostUrl);
  if (!checked.length || checked.length > 1000 || checked.some((u) => !u)) throw new TopazError("Topaz's upload addresses were not what was expected.", status);
  return { uploadUrls: checked.map((u) => u!.href) };
}

/** Puts the clip's bytes to the addresses, one equal part each, in order, and returns each part's tag for `completeVideoUpload`. A part that is not taken fails the upload; none is retried here. */
export async function uploadVideoParts(uploadUrls: readonly string[], bytes: Buffer, deps: Deps = {}): Promise<{ partNum: number; eTag: string }[]> {
  if (!uploadUrls.length || !bytes.length) throw new TopazError("There is nothing to upload.");
  if (engineMock()) return uploadUrls.map((_, i) => ({ partNum: i + 1, eTag: `mock-etag-${i + 1}` }));
  const size = Math.ceil(bytes.length / uploadUrls.length);
  const parts: { partNum: number; eTag: string }[] = [];
  for (let i = 0; i < uploadUrls.length; i += 1) {
    const target = topazHostUrl(uploadUrls[i]);
    if (!target) throw new TopazError("An upload address was not one Topaz's storage uses.");
    let put: Response;
    try {
      put = await (deps.fetch ?? recoveryFetch)(target.href, { method: "PUT", body: new Uint8Array(bytes.subarray(i * size, (i + 1) * size)), redirect: "error", signal: AbortSignal.timeout(300_000) });
    } catch { throw new TopazError("Topaz did not take the upload."); }
    if (!put.ok) throw new TopazError(`Topaz did not take the upload (${put.status}).`, put.status, null, put.status >= 400 && put.status < 500);
    const tag = (put.headers.get("etag") ?? "").replace(/^"|"$/g, "");
    if (!tag) throw new TopazError("Topaz's storage did not name an uploaded part.");
    parts.push({ partNum: i + 1, eTag: tag });
  }
  return parts;
}

/** Tells Topaz the upload is whole: work begins here. The one paid step for a clip; never repeated for the same job. */
export async function completeVideoUpload(id: string, parts: readonly { partNum: number; eTag: string }[], deps: Deps = {}): Promise<void> {
  if (!parts.length) throw new TopazError("There are no uploaded parts to complete.");
  if (engineMock()) { const job = mockVideos.get(id); if (!job?.accepted) throw new TopazError("Topaz has not accepted that request.", 409, null, true); return; }
  await call("PATCH", `/video/${encodeURIComponent(id)}/complete-upload`, { json: { uploadResults: parts.map((p) => ({ partNum: p.partNum, eTag: p.eTag })) }, deps });
}

const VIDEO_STATUS: Record<string, TopazVideoStatus> = {
  requested: "pending", accepted: "pending", initializing: "pending", preprocessing: "pending", processing: "processing", postprocessing: "processing",
  canceling: "processing", complete: "completed", completed: "completed", failed: "failed", canceled: "cancelled", cancelled: "cancelled",
};

/** One poll. A status Topaz does not name here is "processing": never a verdict from a word we do not know. A finished clip carries its output address only when it is one of Topaz's hosts. */
export async function videoStatus(id: string, deps: Deps = {}): Promise<TopazVideoProcess> {
  if (engineMock()) {
    const job = mockVideos.get(id);
    if (!job) throw new TopazError("Topaz has no such request.", 404, null, true);
    job.polls += 1;
    return job.polls < 2 ? { id, status: "processing", progress: 0.5 } : { id, status: "completed", progress: 1, downloadUrl: `https://topaz-mock.s3.amazonaws.com/${id}/output.mp4`, credits: job.credits };
  }
  const { json } = await call("GET", `/video/${encodeURIComponent(id)}/status`, { deps, timeout: POLL_TIMEOUT_MS });
  const status = VIDEO_STATUS[String(json.status ?? "").toLowerCase()] ?? "processing";
  const progress = finiteOrUndefined(json.progress);
  const download = (json.download as { url?: unknown } | undefined)?.url ?? json.downloadUrl;
  const url = topazHostUrl(download);
  const credits = finiteOrUndefined(json.credits ?? json.creditsUsed ?? json.credits_used);
  return {
    id, status,
    ...(progress !== undefined ? { progress: progress > 1 ? Math.min(1, progress / 100) : progress } : {}),
    ...(url ? { downloadUrl: url.href } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(typeof json.error === "string" ? { error: json.error.slice(0, 300) } : typeof json.message === "string" && status === "failed" ? { error: json.message.slice(0, 300) } : {}),
  };
}

/** The finished clip. From the output address Topaz named (https, its own hosts only, no redirect), capped; nothing is stored here. */
export async function downloadVideo(output: { id: string; url?: string }, deps: Deps = {}): Promise<Buffer> {
  if (engineMock()) { if (!mockVideos.has(output.id)) throw new TopazError("Topaz has no such request.", 404, null, true); return Buffer.from(MOCK_TOPAZ_MP4); }
  return fetchOutput(output.url, TOPAZ_OUTPUT_LIMIT_BYTES, "upscaled clip", deps);
}

/** Deletes the vendor's copy of a finished clip (owner, 14 Oct: "Delete the vendor's copy once we've stored the output"): `DELETE /video/{requestId}/media`. True when it is gone (or never was). */
export async function deleteVideoMedia(id: string, deps: Deps = {}): Promise<boolean> {
  if (engineMock()) { mockVideos.delete(id); return true; }
  try { await call("DELETE", `/video/${encodeURIComponent(id)}/media`, { deps }); return true; }
  catch (error) { if (error instanceof TopazError && error.status === 404) return true; throw error; }
}

/** Cancels a clip that has not finished (`DELETE /video/{requestId}`; before processing it is a full refund, mid-run prorated: docs/redesign/cancel-billing.md). True when it is stopped (or was never there). */
export async function cancelVideo(id: string, deps: Deps = {}): Promise<boolean> {
  if (engineMock()) { mockVideos.delete(id); return true; }
  try { await call("DELETE", `/video/${encodeURIComponent(id)}`, { deps }); return true; }
  catch (error) { if (error instanceof TopazError && error.status === 404) return true; throw error; }
}
