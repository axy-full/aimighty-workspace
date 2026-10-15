import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";
import { RECRAFT_RATES, type RecraftModel } from "./vendorRates";

/**
 * Recraft, DIRECT (the owner, 15 Oct 2026: "Recraft (raster, vector, vectorize, remove background)"): a still from words, a still turned into an SVG, and a still with its background removed.
 * On Recraft's own API. The reply carries the image (there is no job to poll), so there is no vendor link to keep and none is ever asked for: `response_format` is `b64_json`.
 *
 * Settings (names only): RECRAFT_API_KEY (set), RECRAFT_BASE_URL (optional: unset means https://external.api.recraft.ai/v1; if set it must be an https `*.recraft.ai` address) and
 * RECRAFT_ENABLED (the kill switch, lib/engineGate.ts). Under ENGINE_MOCK=1 nothing is called: a fixture answers in process.
 *
 * What is called (docs/plans/provider-adapters.md § 5), with `Authorization: Bearer`: `POST /images/generations`, `POST /images/vectorize`, `POST /images/removeBackground`. **The request and reply field
 * names and the size list follow Recraft's public API as the plan records them and are TO CONFIRM in the first qualification run (the model ids and prices were verified on Recraft's pages, 16 Oct 2026)** (a paid run needs the owner's yes; none is made
 * here). Every reply is read defensively; nothing is billed on a failure we can see. Every request refuses redirects (`redirect: "error"`): the key is a header and a redirect would carry it to a host
 * this module never named. No call is ever repeated: a failed or unanswered request throws once, and the caller (which holds the reservation and the take's row) decides.
 */
export const RECRAFT_SWITCH = "RECRAFT_ENABLED";
export const RECRAFT_DEFAULT_BASE = "https://external.api.recraft.ai/v1";
const TIMEOUT_MS = 120_000;
export const RECRAFT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
/** What Recraft takes as a source still: under 20 MB, up to 16 MP and 4,096 px on the longest side, at least 256 px on the shortest. */
export const RECRAFT_SOURCE_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, megapixels: 16, longest: 4096, shortest: 256 });
/** Sizes a still may be asked at (TO CONFIRM against the API's list for the V4.1 models). */
export const RECRAFT_SIZES = ["1024x1024", "1365x1024", "1024x1365", "1536x1024", "1024x1536", "1820x1024", "1024x1820", "1280x1024", "1024x1280"] as const;
export const RECRAFT_DEFAULT_SIZE = "1024x1024";
export const RECRAFT_STYLE = /^[a-z0-9_]{1,60}$/;

export const recraftConfigured = (): boolean => Boolean(process.env.RECRAFT_API_KEY) || engineMock();
export const isRecraftModel = (v: unknown): v is RecraftModel => typeof v === "string" && Object.hasOwn(RECRAFT_RATES.models, v);
export const isVectorModel = (model: RecraftModel): boolean => RECRAFT_RATES.models[model].vector;

/** A refusal or failure from Recraft (or from reaching it). `rejectedBeforeGeneration`: it answered a clear refusal (4xx other than 408) before doing the work. */
export class RecraftError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly rejectedBeforeGeneration = false) { super(message); this.name = "RecraftError"; }
}

/** An address on Recraft's own domain, https, no port, no credentials. */
export function recraftHostUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url.hostname === "recraft.ai" || url.hostname.endsWith(".recraft.ai") ? url : null;
}

/** The base address: Recraft's own unless RECRAFT_BASE_URL (an https `*.recraft.ai` address, with no query, fragment or credentials) says otherwise. */
export function recraftBase(): string {
  const raw = (process.env.RECRAFT_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return RECRAFT_DEFAULT_BASE;
  const url = recraftHostUrl(raw);
  if (!url || url.search || url.hash) throw new RecraftError("RECRAFT_BASE_URL must be an https address on recraft.ai.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
function key(): string {
  const value = process.env.RECRAFT_API_KEY;
  if (!value) throw new RecraftError("This is not set up: RECRAFT_API_KEY is needed.");
  return value;
}

type Deps = { fetch?: typeof fetch };
async function call(path: string, init: { json?: unknown; form?: FormData }, deps: Deps): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(`${recraftBase()}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key()}`, accept: "application/json", ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof RecraftError) throw error;
    throw new RecraftError("Recraft did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const said = typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : typeof json.detail === "string" ? json.detail : "";
    /* A 429 is Recraft saying it will not take the call now: a clear refusal, safe to settle at nothing. 408 and 5xx may have done the work. */
    throw new RecraftError(said ? `Recraft refused the request: ${said.slice(0, 200)}` : `Recraft answered ${res.status}.`, res.status, res.status >= 400 && res.status < 500 && res.status !== 408);
  }
  return json;
}

/** What a reply holds: the image's bytes (from its `b64_json`) and the API units the call used, when it says. */
export type RecraftReply = { bytes: Buffer; units: number | null; statedUsd: number | null };
function image(json: Record<string, unknown>): RecraftReply {
  const data = Array.isArray(json.data) ? (json.data[0] as { b64_json?: unknown } | undefined) : undefined;
  const nested = json.image && typeof json.image === "object" ? (json.image as { b64_json?: unknown }) : undefined;
  const b64 = data?.b64_json ?? nested?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new RecraftError("Recraft's reply held no image.");
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length || bytes.length > RECRAFT_OUTPUT_LIMIT_BYTES) throw new RecraftError("The image came back empty or too large.");
  const units = json.credits == null ? NaN : Number(json.credits);
  const ok = Number.isFinite(units) && units >= 0;
  return { bytes, units: ok ? units : null, statedUsd: ok ? Math.round(units * RECRAFT_RATES.unitUsd * 1e6) / 1e6 : null };
}

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
/** A 1x1 PNG. */
export const MOCK_RECRAFT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
/** A tiny SVG, for the vector paths (which are refused today: lib/recraftImage.ts). */
export const MOCK_RECRAFT_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');

/** A still from words. The caller holds the reservation; this is the one paid request, and it is never repeated for the same job. */
export async function generateImage(input: { model: RecraftModel; prompt: string; size: string; style?: string }, deps: Deps = {}): Promise<RecraftReply> {
  if (engineMock()) {
    if (input.prompt.startsWith("[[mock-refuse]]")) throw new RecraftError("Recraft refused the request: mock refusal.", 422, true);
    return { bytes: Buffer.from(isVectorModel(input.model) ? MOCK_RECRAFT_SVG : MOCK_RECRAFT_PNG), units: null, statedUsd: null };
  }
  return image(await call("/images/generations", { json: { model: input.model, prompt: input.prompt, size: input.size, n: 1, response_format: "b64_json", ...(isVectorModel(input.model) ? {} : { image_format: "png" }), ...(input.style ? { style: input.style } : {}) } }, deps));
}

function sourceForm(input: { bytes: Buffer; filename: string; mime: string }): FormData {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(input.bytes)], { type: input.mime }), input.filename.slice(0, 200) || "source");
  form.set("response_format", "b64_json");
  return form;
}

/** A still turned into an SVG. */
export async function vectorize(input: { bytes: Buffer; filename: string; mime: string }, deps: Deps = {}): Promise<RecraftReply> {
  if (engineMock()) return { bytes: Buffer.from(MOCK_RECRAFT_SVG), units: null, statedUsd: null };
  return image(await call("/images/vectorize", { form: sourceForm(input) }, deps));
}

/** A still with its background removed (a transparent PNG). */
export async function removeBackground(input: { bytes: Buffer; filename: string; mime: string }, deps: Deps = {}): Promise<RecraftReply> {
  if (engineMock()) return { bytes: Buffer.from(MOCK_RECRAFT_PNG), units: null, statedUsd: null };
  return image(await call("/images/removeBackground", { form: sourceForm(input) }, deps));
}
