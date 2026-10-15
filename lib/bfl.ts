import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";
import { BFL_RATES, type BflModel } from "./vendorRates";

/**
 * Black Forest Labs FLUX.2, DIRECT (the owner: "Black Forest Labs (FLUX 3 and FLUX.2 identity, replacing fal flux-lora)"): stills from words, and edits from up
 * to eight references. On BFL's own API, not fal, **on the EU endpoint by default** (GDPR terms; docs/plans/provider-adapters.md § 6, owner question B).
 *
 * Settings (names only): BFL_API_KEY (set), BFL_BASE_URL (optional: unset means https://api.eu.bfl.ai; if set it must be an https `*.bfl.ai` host) and
 * BFL_ENABLED (the kill switch, lib/engineGate.ts). Under ENGINE_MOCK=1 nothing is called: a fixture answers in process.
 *
 * What is called: `POST /v1/flux-2-pro` (or -flex, -max) with the header `x-key`; the reply names the job (`id`) and the address to poll (`polling_url`:
 * "You must use the polling_url returned"); the poll says `Ready` with the image's signed address in `result.sample`, which **is valid for ten minutes
 * only**, so the collector copies the image the moment it is Ready (lib/bflImage.ts). A polling or result address is followed only when it is an https host
 * under bfl.ai (no other host is ever fetched, with or without our key). **The request and reply field names and the endpoint paths follow BFL's public API as the
 * plan records them and are TO CONFIRM in the first qualification run.** Every reply is read defensively; nothing is billed on a failure we can see.
 */
export const BFL_SWITCH = "BFL_ENABLED";
/** The EU endpoint: the default, never the global api.bfl.ai (a test pins it). */
export const BFL_DEFAULT_BASE = "https://api.eu.bfl.ai";
const TIMEOUT_MS = 30_000;
/** How long a Ready result's address lives (BFL: "Signed URLs are only valid for 10 minutes"). */
export const BFL_RESULT_LIFETIME_MS = 10 * 60_000;
export const BFL_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const BFL_REFERENCE_LIMIT_BYTES = 20 * 1024 * 1024;

export const bflConfigured = (): boolean => Boolean(process.env.BFL_API_KEY) || engineMock();
export const isBflModel = (v: unknown): v is BflModel => typeof v === "string" && Object.hasOwn(BFL_RATES.models, v);

/** A refusal or failure from BFL (or from reaching it). `rejectedBeforeGeneration`: it answered a clear refusal (4xx other than 408) before taking the job. */
export class BflError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly rejectedBeforeGeneration = false) { super(message); this.name = "BflError"; }
}

/** An address BFL gave us, accepted only as an https host under bfl.ai. */
export function bflHostUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url.hostname === "bfl.ai" || url.hostname.endsWith(".bfl.ai") ? url : null;
}

/** The base address: the EU endpoint unless BFL_BASE_URL (an https `*.bfl.ai` host, nothing more) says otherwise. */
export function bflBase(): string {
  const raw = (process.env.BFL_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return BFL_DEFAULT_BASE;
  const url = bflHostUrl(raw);
  if (!url || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) throw new BflError("BFL_BASE_URL must be an https address on bfl.ai.");
  return url.origin;
}
function key(): string {
  const value = process.env.BFL_API_KEY;
  if (!value) throw new BflError("This is not set up: BFL_API_KEY is needed.");
  return value;
}

type Deps = { fetch?: typeof fetch };
async function call(method: "GET" | "POST", url: string, body: unknown, deps: Deps): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(url, {
      method,
      headers: { "x-key": key(), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof BflError) throw error;
    throw new BflError("BFL did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = typeof json.detail === "string" ? json.detail : typeof json.message === "string" ? json.message : "";
    /* A 429 is BFL saying it will not take the job now: a clear refusal, safe to settle at nothing and try again. 408 and 5xx may have taken it. */
    throw new BflError(detail ? `BFL refused the request: ${detail.slice(0, 200)}` : `BFL answered ${res.status}.`, res.status, res.status >= 400 && res.status < 500 && res.status !== 408);
  }
  return { status: res.status, json };
}

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
const mockJobs = new Map<string, { polls: number }>();
let mockSeq = 0;
/** A 1x1 PNG. */
const MOCK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export type BflRequest = { model: BflModel; prompt: string; width: number; height: number; seed?: number; references: Buffer[] };
/** `statedUsd`: what BFL says the job cost, in dollars (its credits at $0.01), when its reply says (the field is TO CONFIRM); null when it does not. */
export type BflSubmitted = { id: string; pollingUrl: string; statedUsd: number | null };

/** Starts one job. The caller holds the reservation; this is the one paid request, and it is never repeated for the same job. */
export async function submitImage(input: BflRequest, deps: Deps = {}): Promise<BflSubmitted> {
  if (engineMock()) {
    if (input.prompt.startsWith("[[mock-refuse]]")) throw new BflError("BFL refused the request: mock refusal.", 422, true);
    const id = `mock_bfl_${++mockSeq}`;
    mockJobs.set(id, { polls: 0 });
    return { id, pollingUrl: `${BFL_DEFAULT_BASE}/v1/get_result?id=${id}`, statedUsd: null };
  }
  const body: Record<string, unknown> = { prompt: input.prompt, width: input.width, height: input.height, output_format: "png", ...(input.seed != null ? { seed: input.seed } : {}) };
  input.references.forEach((bytes, i) => { body[i === 0 ? "input_image" : `input_image_${i + 1}`] = bytes.toString("base64"); });
  const { json, status } = await call("POST", `${bflBase()}/v1/${input.model}`, body, deps);
  const pollingUrl = bflHostUrl(json.polling_url);
  if (typeof json.id !== "string" || !json.id || !pollingUrl) throw new BflError("BFL's reply named no job to poll.", status);
  const cost = Number(json.cost);
  return { id: json.id, pollingUrl: pollingUrl.href, statedUsd: json.cost != null && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * BFL_RATES.creditUsd * 1e6) / 1e6 : null };
}

export type BflState = { status: "pending" | "ready" | "failed"; resultUrl?: string; failure?: string };
const FAILED = new Set(["error", "failed", "request moderated", "content moderated", "task not found"]);

/** One poll, at the address BFL named for this job. A status we do not know is "pending": never a verdict from a word we do not know. */
export async function pollImage(job: { id: string; pollingUrl: string }, deps: Deps = {}): Promise<BflState> {
  if (engineMock()) {
    const j = mockJobs.get(job.id);
    if (!j) throw new BflError("BFL has no such job.", 404, true);
    j.polls += 1;
    return j.polls < 2 ? { status: "pending" } : { status: "ready", resultUrl: `${BFL_DEFAULT_BASE}/result/${job.id}.png` };
  }
  const url = bflHostUrl(job.pollingUrl);
  if (!url) throw new BflError("BFL's polling address is not one we follow.");
  const { json } = await call("GET", url.href, undefined, deps);
  const word = String(json.status ?? "").toLowerCase();
  if (word === "ready") {
    const sample = json.result && typeof json.result === "object" ? (json.result as { sample?: unknown }).sample : undefined;
    const result = bflHostUrl(sample);
    return result ? { status: "ready", resultUrl: result.href } : { status: "failed", failure: "BFL's result named no image we can fetch." };
  }
  if (FAILED.has(word)) return { status: "failed", failure: word === "request moderated" || word === "content moderated" ? "BFL's moderation stopped this." : "BFL could not make this image." };
  return { status: "pending" };
}

/** The finished image, from the bfl.ai address in the poll (never with our key), capped. Nothing is stored here. */
export async function fetchResult(resultUrl: string, deps: Deps = {}): Promise<Buffer> {
  if (engineMock()) return Buffer.from(MOCK_PNG);
  const url = bflHostUrl(resultUrl);
  if (!url) throw new BflError("BFL's result address is not one we fetch.");
  let res: Response;
  try { res = await (deps.fetch ?? recoveryFetch)(url.href, { method: "GET", signal: AbortSignal.timeout(120_000) }); }
  catch { throw new BflError("The image could not be fetched from BFL."); }
  if (!res.ok) throw new BflError(`The image could not be fetched from BFL (${res.status}).`, res.status);
  if (Number(res.headers.get("content-length") ?? 0) > BFL_OUTPUT_LIMIT_BYTES) throw new BflError("The image is larger than Particl keeps.");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > BFL_OUTPUT_LIMIT_BYTES) throw new BflError("The image came back empty or too large.");
  return bytes;
}
