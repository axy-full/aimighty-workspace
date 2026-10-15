import { engineMock } from "./mock";
import { fixtureBytes } from "./mockFs";
import { recoveryFetch } from "./recovery";
import { vendorKey } from "./vendorKeys";
import { VEO_RATES, type VeoAspect, type VeoModel, type VeoResolution } from "./vendorRates";

export type { VeoAspect, VeoModel, VeoResolution };

/**
 * Google Veo 3.1, DIRECT on the Gemini API (the owner: "Veo 3.1 (Google, direct via the Gemini API)"): a clip with its sound from words, from words and a first
 * frame, or from words and up to three reference images. The same key and host the stills already use (`GEMINI_API_KEY`, `GEMINI_BASE_URL`, lib/gemini.ts); the only
 * new setting is `VEO_ENABLED`, the kill switch (lib/engineGate.ts). Under ENGINE_MOCK=1 nothing is called: a fixture answers in process.
 *
 * What is called: `POST {host}/v1beta/models/{model}:predictLongRunning` with the header `x-goog-api-key`, a long-running operation in reply (`name`); that operation
 * polled at `GET {host}/v1beta/{name}` until `done`; the video at the `uri` the finished operation names, fetched by us with the key and stored by us. Only an https
 * host under googleapis.com is ever called, no redirect is followed on a call (`redirect: "error"`), and the clip's download follows at most two redirects, each
 * checked against an https allow-list, **with the key sent only on the first request** (Google's own sample downloads "using the URI and API key and follow redirects").
 * The rates (lib/vendorRates.ts VEO_RATES) and the setting limits below were read from Google's pricing and Veo pages by the lead on 16 Oct 2026; **the request and reply field names and the model ids
 * are still TO CONFIRM against Google's reference before anything is switched on.** Every reply is read defensively; a status we do not know is "pending", never a verdict.
 *
 * GEMINI_BASE_URL is shared with the stills (lib/gemini.ts). Veo reads it too and holds it to an https googleapis.com host with nothing after it: set to anything
 * else (a proxy, a mock server), every Veo call is refused here before a request is made, while the stills keep using it.
 *
 * Money: Google bills a clip on success only ("You will only be charged if your video is successfully generated"; blocked videos are not charged). A finished operation that carries no video (the safety filter, an error) is not billed;
 * the caller records it as failed at nothing. The quote is the rate times the seconds, never under.
 */
export const VEO_SWITCH = "VEO_ENABLED";
export const VEO_DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The largest clip we keep: an 8 s 1080p Veo clip is a few tens of MB. */
export const VEO_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
export const VEO_REFERENCE_LIMIT_BYTES = 20 * 1024 * 1024;
export const VEO_MAX_REFERENCES = 3;

export const veoConfigured = (): boolean => Boolean(vendorKey("gemini")) || engineMock();
export const isVeoModel = (v: unknown): v is VeoModel => typeof v === "string" && Object.hasOwn(VEO_RATES.models, v);

/** A refusal or failure from Google (or from reaching it). `rejectedBeforeGeneration`: it answered a clear refusal (4xx other than 408) before taking the job. */
export class VeoError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly rejectedBeforeGeneration = false) { super(message); this.name = "VeoError"; }
}

/** An address Google gave us, accepted only as an https host under googleapis.com (no credentials, no port). */
export function veoHostUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com") ? url : null;
}

/** The host: Google's unless GEMINI_BASE_URL (the same setting the stills read) names another https googleapis.com host, with nothing after it. Read when asked. */
export function veoBase(): string {
  const raw = (process.env.GEMINI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return VEO_DEFAULT_BASE;
  const url = veoHostUrl(raw);
  if (!url || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new VeoError("GEMINI_BASE_URL must be an https address on googleapis.com to be used for video.");
  return url.origin;
}
function key(): string {
  const value = vendorKey("gemini");
  if (!value) throw new VeoError("This is not set up: GEMINI_API_KEY is needed.");
  return value;
}

/** The settings the vendor takes, or why not (Google's Veo page, 8 Oct 2026). Nothing here spends anything; a refusal is before any request. */
export function veoSettingsError(input: Pick<VeoRequest, "model" | "durationSeconds" | "resolution" | "aspectRatio"> & { references?: unknown[] }): string | null {
  if (!isVeoModel(input.model)) return "That video model is not offered.";
  if (!(VEO_RATES.durations as readonly number[]).includes(input.durationSeconds)) return `A clip is ${VEO_RATES.durations.join(", ")} seconds.`;
  if (!(VEO_RATES.resolutions as readonly string[]).includes(input.resolution)) return `The size is ${VEO_RATES.resolutions.join(" or ")}.`;
  if (!(VEO_RATES.aspects as readonly string[]).includes(input.aspectRatio)) return `The shape is ${VEO_RATES.aspects.join(" or ")}.`;
  if (input.resolution === "1080p" && input.durationSeconds !== 8) return "1080p clips are 8 seconds.";
  const refs = input.references?.length ?? 0;
  if (refs > VEO_MAX_REFERENCES) return `At most ${VEO_MAX_REFERENCES} reference images.`;
  if (refs > 0 && input.durationSeconds !== 8) return "A clip from reference images is 8 seconds.";
  return null;
}

/** The most Google can charge for this clip, in dollars (rate x seconds, rounded up to the micro-dollar). Throws on settings the vendor does not take. */
export function veoQuoteUsd(input: { model: VeoModel; durationSeconds: number; resolution: VeoResolution }): number {
  if (!isVeoModel(input.model)) throw new VeoError("That video model is not offered.");
  const rate = VEO_RATES.models[input.model].usdPerSecond[input.resolution];
  if (rate == null || !(VEO_RATES.durations as readonly number[]).includes(input.durationSeconds)) throw new VeoError("That clip's settings are not offered.");
  return Math.ceil(rate * input.durationSeconds * 1e6 - 1e-9) / 1e6;
}

type Deps = { fetch?: typeof fetch };
type Image = { bytes: Buffer; mime: string };
export type VeoRequest = {
  model: VeoModel;
  prompt: string;
  durationSeconds: number;
  resolution: VeoResolution;
  aspectRatio: VeoAspect;
  negativePrompt?: string;
  seed?: number;
  /** The first frame (image to video). Consent for any person in it has passed before this is called (lib/consentMatch.ts); this module never decides that. */
  firstFrame?: Image;
  /** Up to three reference images, same rule. */
  references?: Image[];
};

async function call(method: "GET" | "POST", url: URL, body: unknown, deps: Deps): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(url.href, {
      method,
      headers: { "x-goog-api-key": key(), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof VeoError) throw error;
    throw new VeoError("Google did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = json.error && typeof json.error === "object" ? (json.error as { message?: unknown }) : {};
    const detail = typeof err.message === "string" ? err.message : "";
    /* A 429 is Google saying it will not take the job now: a clear refusal, safe to settle at nothing and try again. 408 and 5xx may have taken it. */
    throw new VeoError(detail ? `Google refused the request: ${detail.slice(0, 200)}` : `Google answered ${res.status}.`, res.status, res.status >= 400 && res.status < 500 && res.status !== 408);
  }
  return { status: res.status, json };
}

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
const mockJobs = new Map<string, { polls: number; filtered: boolean }>();
let mockSeq = 0;
const MOCK_VIDEO_URL = `${VEO_DEFAULT_BASE}/v1beta/files/mock_veo:download?alt=media`;

/** The operation Google names for a job: `models/<model>/operations/<id>` and nothing else. */
const OPERATION = /^models\/[a-z0-9]+(?:[.-][a-z0-9]+){0,12}\/operations\/[A-Za-z0-9_-]{1,120}$/;

/** Starts one clip. The caller holds the reservation; this is the one paid request, and it is never repeated for the same job. */
export async function submitVideo(input: VeoRequest, deps: Deps = {}): Promise<{ operation: string }> {
  const bad = veoSettingsError({ ...input, references: input.references });
  if (bad) throw new VeoError(bad, null, true);
  if (engineMock()) {
    if (input.prompt.startsWith("[[mock-refuse]]")) throw new VeoError("Google refused the request: mock refusal.", 400, true);
    const operation = `models/${input.model}/operations/mock_veo_${++mockSeq}`;
    mockJobs.set(operation, { polls: 0, filtered: input.prompt.startsWith("[[mock-filtered]]") });
    return { operation };
  }
  const instance: Record<string, unknown> = { prompt: input.prompt };
  const image = (i: Image) => ({ bytesBase64Encoded: i.bytes.toString("base64"), mimeType: i.mime });
  if (input.firstFrame) instance.image = image(input.firstFrame);
  if (input.references?.length) instance.referenceImages = input.references.map((r) => ({ image: image(r), referenceType: "asset" }));
  const parameters: Record<string, unknown> = {
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
    /* Reference images need adults only (Google: personGeneration "allow_adult"). */
    ...(input.references?.length ? { personGeneration: "allow_adult" } : {}),
    /* Exactly one clip: the quote is for one, and a default above one would bill several against it. Google's field name for the count (sampleCount; the SDK calls it numberOfVideos) is TO CONFIRM. */
    sampleCount: 1,
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    ...(input.seed != null ? { seed: input.seed } : {}),
  };
  const url = veoHostUrl(`${veoBase()}/v1beta/models/${input.model}:predictLongRunning`);
  if (!url) throw new VeoError("Google's address is not one we call.");
  const { json, status } = await call("POST", url, { instances: [instance], parameters }, deps);
  if (typeof json.name !== "string" || !OPERATION.test(json.name)) throw new VeoError("Google's reply named no job to poll.", status);
  return { operation: json.name };
}

export type VeoState = { status: "pending" | "ready" | "failed"; resultUrl?: string; failure?: string };

/** One poll of one operation. */
export async function pollVideo(job: { operation: string }, deps: Deps = {}): Promise<VeoState> {
  if (!OPERATION.test(job.operation)) throw new VeoError("That is not a job name Google gave us.");
  if (engineMock()) {
    const j = mockJobs.get(job.operation);
    if (!j) throw new VeoError("Google has no such job.", 404, true);
    j.polls += 1;
    if (j.polls < 2) return { status: "pending" };
    return j.filtered ? { status: "failed", failure: "Google's safety filter stopped this." } : { status: "ready", resultUrl: MOCK_VIDEO_URL };
  }
  const url = veoHostUrl(`${veoBase()}/v1beta/${job.operation}`);
  if (!url) throw new VeoError("Google's address is not one we call.");
  const { json } = await call("GET", url, undefined, deps);
  if (json.done !== true) return { status: "pending" };
  if (json.error && typeof json.error === "object") return { status: "failed", failure: "Google could not make this clip." };
  const response = json.response && typeof json.response === "object" ? (json.response as Record<string, unknown>) : {};
  const generated = response.generateVideoResponse && typeof response.generateVideoResponse === "object" ? (response.generateVideoResponse as Record<string, unknown>) : response;
  const samples = Array.isArray(generated.generatedSamples) ? generated.generatedSamples : [];
  const video = samples[0] && typeof samples[0] === "object" ? (samples[0] as { video?: { uri?: unknown } }).video : undefined;
  const uri = veoHostUrl(video?.uri);
  if (uri) return { status: "ready", resultUrl: uri.href };
  const filtered = Array.isArray(generated.raiMediaFilteredReasons) && generated.raiMediaFilteredReasons.length > 0;
  return { status: "failed", failure: filtered ? "Google's safety filter stopped this." : "Google's reply named no video we can fetch." };
}

/**
 * The hosts a download may be redirected through: Google's file host itself (generativelanguage.googleapis.com) and its user-content download hosts
 * (`*.googleusercontent.com`, subdomains only): https, no credentials, no port. **Deliberately narrow: not `*.google.com` (sites.google.com and script.google.com
 * serve other people's pages) and not the rest of `*.googleapis.com` (storage.googleapis.com holds anyone's bucket). TO CONFIRM in the first qualification run,
 * with the owner's yes, which host Google really redirects a download to; a host that is not listed fails the fetch, recorded at nothing, and is added then.**
 */
export function veoDownloadUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const h = url.hostname;
  return h === "generativelanguage.googleapis.com" || h.endsWith(".googleusercontent.com") ? url : null;
}
const MAX_DOWNLOAD_HOPS = 2;

/**
 * The finished clip. The first request goes to the googleapis.com address in the finished operation WITH our key; Google's own sample follows redirects, so up to two
 * are followed (`redirect: "manual"`), each only to an https host on the download allow-list above and **never with the key**. Capped. Nothing is stored here.
 */
export async function fetchResult(resultUrl: string, deps: Deps = {}): Promise<Buffer> {
  if (engineMock()) return fixtureBytes("clip.mp4");
  let url = veoHostUrl(resultUrl);
  if (!url) throw new VeoError("Google's result address is not one we fetch.");
  const doFetch = deps.fetch ?? recoveryFetch;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_DOWNLOAD_HOPS; hop += 1) {
    try { res = await doFetch(url.href, { method: "GET", headers: hop === 0 ? { "x-goog-api-key": key() } : {}, redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }); }
    catch (error) { if (error instanceof VeoError) throw error; throw new VeoError("The clip could not be fetched from Google."); }
    if (res.status < 300 || res.status >= 400) break;
    await res.body?.cancel().catch(() => {});
    if (hop === MAX_DOWNLOAD_HOPS) throw new VeoError("The clip's address moved too many times.");
    let target: string | null = null;
    try { const location = res.headers.get("location"); target = location ? new URL(location, url).href : null; } catch { /* not an address */ }
    const next = veoDownloadUrl(target);
    if (!next) throw new VeoError("Google sent the clip to an address we do not follow.");
    url = next;
  }
  if (!res || !res.ok) { await res?.body?.cancel().catch(() => {}); throw new VeoError(`The clip could not be fetched from Google (${res?.status ?? 0}).`, res?.status ?? null); }
  if (Number(res.headers.get("content-length") ?? 0) > VEO_OUTPUT_LIMIT_BYTES) { await res.body?.cancel().catch(() => {}); throw new VeoError("The clip is larger than Particl keeps."); }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > VEO_OUTPUT_LIMIT_BYTES) throw new VeoError("The clip came back empty or too large.");
  return bytes;
}
