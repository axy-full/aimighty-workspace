import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";
import { RUNWAY_RATES, type RunwayModel } from "./vendorRates";

/**
 * Runway, DIRECT (the owner's stack: "Runway (Act-Two, Aleph 2, Gen-4.5)", on standby: the house workspace only until training-free terms): Act-Two (a performance
 * drives a character), Aleph 2 (a clip edited from words) and Gen-4.5 / Gen-4 Turbo (a still made into a clip).
 *
 * Settings (names only): RUNWAY_API_KEY, RUNWAY_BASE_URL (optional; default https://api.dev.runwayml.com/v1; if set it must be an https `*.runwayml.com` host with the `/v1`
 * path) and RUNWAY_ENABLED (the kill switch, lib/engineGate.ts). Under ENGINE_MOCK=1 nothing is called: a fixture answers in process.
 *
 * What is called (docs/plans/provider-adapters.md § 7): `POST /v1/character_performance` (act_two), `POST /v1/video_to_video` (aleph2), `POST /v1/image_to_video` (gen4.5,
 * gen4_turbo), `GET /v1/tasks/{id}` and `DELETE /v1/tasks/{id}`, with `Authorization: Bearer` and `X-Runway-Version: 2024-11-06`. Inputs go in the request as data URIs from
 * bytes read on the server (an image up to 5 MB, a video up to 16 MB), so none of our storage links reaches the vendor. A finished task's output addresses "expire within
 * 24-48 hours": they are copied at once, and only from an https host on the allow-list below (never with our key). **The request and reply field names, the model ids and the output
 * host list are TO CONFIRM in the first qualification run** (the plan names the endpoints and models, not every field, and no output host); every reply is read defensively.
 */
export const RUNWAY_SWITCH = "RUNWAY_ENABLED";
export const RUNWAY_DEFAULT_BASE = "https://api.dev.runwayml.com/v1";
export const RUNWAY_VERSION = "2024-11-06";
const TIMEOUT_MS = 30_000;
export const RUNWAY_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
export const RUNWAY_VIDEO_LIMIT_BYTES = 16 * 1024 * 1024;
export const RUNWAY_OUTPUT_LIMIT_BYTES = 512 * 1024 * 1024;
/** A task's output address lives 24 to 48 hours (Runway's outputs page); one pass later than this is past any chance of it. */
export const RUNWAY_RESULT_LIFETIME_MS = 24 * 3600_000;
/** The hosts a task's output may be fetched from (TO CONFIRM): a host on runwayml.com, or the one CloudFront distribution Runway's outputs have been served from. Nothing else is ever fetched. */
export const RUNWAY_RESULT_HOSTS = { suffixes: ["runwayml.com"], exact: ["dnznrvs05pmza.cloudfront.net"] } as const;

export const runwayConfigured = (): boolean => Boolean(process.env.RUNWAY_API_KEY) || engineMock();
export const isRunwayModel = (v: unknown): v is RunwayModel => typeof v === "string" && Object.hasOwn(RUNWAY_RATES.models, v);

/** A refusal or failure from Runway (or from reaching it). `rejectedBeforeGeneration`: a clear 4xx (not a 408 or 429) before the task was taken. */
export class RunwayError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly rejectedBeforeGeneration = false) { super(message); this.name = "RunwayError"; }
}

function plainHttps(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
}
/** A task's output address, accepted only as an https host on the allow-list. */
export function runwayResultUrl(raw: unknown): URL | null {
  const url = plainHttps(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  return (RUNWAY_RESULT_HOSTS.exact as readonly string[]).includes(host) || RUNWAY_RESULT_HOSTS.suffixes.some((s) => host === s || host.endsWith(`.${s}`)) ? url : null;
}

/** The base address: the default, or an https `*.runwayml.com` host with the /v1 path and nothing more. */
export function runwayBase(): string {
  const raw = (process.env.RUNWAY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return RUNWAY_DEFAULT_BASE;
  const url = plainHttps(raw);
  if (!url || !(url.hostname === "runwayml.com" || url.hostname.endsWith(".runwayml.com")) || url.pathname !== "/v1" || url.search || url.hash) throw new RunwayError("RUNWAY_BASE_URL must be an https address on runwayml.com ending /v1.");
  return `${url.origin}/v1`;
}
function key(): string {
  const value = process.env.RUNWAY_API_KEY;
  if (!value) throw new RunwayError("This is not set up: RUNWAY_API_KEY is needed.");
  return value;
}

type Deps = { fetch?: typeof fetch };
async function call(method: "GET" | "POST" | "DELETE", path: string, body: unknown, deps: Deps): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(`${runwayBase()}${path}`, {
      method,
      headers: { authorization: `Bearer ${key()}`, "x-runway-version": RUNWAY_VERSION, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      /* The key is a header and undici forwards custom headers across an origin: a redirect is a failure, never followed. */
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof RunwayError) throw error;
    throw new RunwayError("Runway did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const said = typeof json.error === "string" ? json.error : typeof json.message === "string" ? json.message : "";
    /* A clear 4xx is a refusal before the task was taken; 408, 429 and 5xx may have taken it (a 429 is Runway's own limit, but its tasks run in parallel with the limit counted, so it is held, not assumed). */
    throw new RunwayError(said ? `Runway refused the request: ${said.slice(0, 200)}` : `Runway answered ${res.status}.`, res.status, res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  }
  return { status: res.status, json };
}

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
const mockTasks = new Map<string, { polls: number; credits: number }>();
let mockSeq = 0;
const MOCK_MP4 = Buffer.from("mock-runway-output");
export const MOCK_RESULT_HOST = "dnznrvs05pmza.cloudfront.net";

export type RunwayDataInput = { bytes: Buffer; mime: string };
export type RunwayRequest =
  | { tool: "performance"; character: RunwayDataInput & { kind: "image" | "video" }; reference: RunwayDataInput; bodyControl: boolean; expressionIntensity: number; ratio?: string; seed?: number }
  | { tool: "edit"; video: RunwayDataInput; prompt: string; ratio?: string; seed?: number }
  | { tool: "video"; model: "gen4.5" | "gen4_turbo"; image: RunwayDataInput; prompt: string; duration: number; ratio?: string; seed?: number };
export type RunwaySubmitted = { id: string };

const dataUri = (input: RunwayDataInput) => `data:${input.mime};base64,${input.bytes.toString("base64")}`;

/** The endpoint and body for a request. Pure, so a test can read exactly what is sent. */
export function runwayRequestOf(input: RunwayRequest): { path: string; body: Record<string, unknown> } {
  if (input.tool === "performance")
    return { path: "/character_performance", body: { model: "act_two", character: { type: input.character.kind, uri: dataUri(input.character) }, reference: { type: "video", uri: dataUri(input.reference) }, bodyControl: input.bodyControl, expressionIntensity: input.expressionIntensity, ...(input.ratio ? { ratio: input.ratio } : {}), ...(input.seed != null ? { seed: input.seed } : {}) } };
  if (input.tool === "edit")
    return { path: "/video_to_video", body: { model: "aleph2", videoUri: dataUri(input.video), promptText: input.prompt, ...(input.ratio ? { ratio: input.ratio } : {}), ...(input.seed != null ? { seed: input.seed } : {}) } };
  return { path: "/image_to_video", body: { model: input.model, promptImage: dataUri(input.image), promptText: input.prompt, duration: input.duration, ...(input.ratio ? { ratio: input.ratio } : {}), ...(input.seed != null ? { seed: input.seed } : {}) } };
}

/** Starts one task. The caller holds the reservation; this is the one paid request, and it is never repeated for the same job. */
export async function submitTask(input: RunwayRequest, deps: Deps = {}): Promise<RunwaySubmitted> {
  if (engineMock()) {
    if (input.tool !== "performance" && input.prompt.startsWith("[[mock-refuse]]")) throw new RunwayError("Runway refused the request: mock refusal.", 422, true);
    const id = `mock_runway_${++mockSeq}`;
    mockTasks.set(id, { polls: 0, credits: 0 });
    return { id };
  }
  const { path, body } = runwayRequestOf(input);
  const { json, status } = await call("POST", path, body, deps);
  if (typeof json.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(json.id)) throw new RunwayError("Runway's reply named no task.", status);
  return { id: json.id };
}

export type RunwayState =
  | { status: "pending" | "running" }
  | { status: "succeeded"; outputUrl: string; costCredits: number | null }
  | { status: "failed"; failure: string; costCredits: number | null };

/** One poll. THROTTLED is queued at Runway, never a failure; a status we do not know is "pending", never a verdict. */
export async function pollTask(id: string, deps: Deps = {}): Promise<RunwayState> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new RunwayError("That is not a Runway task id.");
  if (engineMock()) {
    const t = mockTasks.get(id);
    if (!t) throw new RunwayError("Runway has no such task.", 404, true);
    t.polls += 1;
    return t.polls < 2 ? { status: "running" } : { status: "succeeded", outputUrl: `https://${MOCK_RESULT_HOST}/mock/${id}.mp4`, costCredits: t.credits || null };
  }
  const { json } = await call("GET", `/tasks/${encodeURIComponent(id)}`, undefined, deps);
  const word = String(json.status ?? "").toUpperCase();
  const cost = json.cost && typeof json.cost === "object" ? Number((json.cost as { credits?: unknown }).credits) : NaN;
  const costCredits = Number.isFinite(cost) && cost >= 0 ? cost : null;
  if (word === "SUCCEEDED") {
    const out = Array.isArray(json.output) ? json.output[0] : null;
    const url = runwayResultUrl(out);
    return url ? { status: "succeeded", outputUrl: url.href, costCredits } : { status: "failed", failure: "Runway's result named no output we can fetch.", costCredits };
  }
  if (word === "FAILED" || word === "CANCELLED") {
    const said = typeof json.failure === "string" ? json.failure : "";
    return { status: "failed", failure: (said || (word === "CANCELLED" ? "Runway cancelled this task." : "Runway could not make this.")).slice(0, 200), costCredits };
  }
  return { status: word === "RUNNING" ? "running" : "pending" };
}

/** The finished clip, from an allow-listed https address, without our key, capped. Nothing is stored here. */
export async function fetchOutput(outputUrl: string, deps: Deps = {}): Promise<Buffer> {
  if (engineMock()) return Buffer.from(MOCK_MP4);
  const url = runwayResultUrl(outputUrl);
  if (!url) throw new RunwayError("Runway's output address is not one we fetch.");
  let res: Response;
  try { res = await (deps.fetch ?? recoveryFetch)(url.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(300_000) }); }
  catch { throw new RunwayError("The clip could not be fetched from Runway."); }
  if (!res.ok) throw new RunwayError(`The clip could not be fetched from Runway (${res.status}).`, res.status);
  if (Number(res.headers.get("content-length") ?? 0) > RUNWAY_OUTPUT_LIMIT_BYTES) throw new RunwayError("The clip is larger than Particl keeps.");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > RUNWAY_OUTPUT_LIMIT_BYTES) throw new RunwayError("The clip came back empty or too large.");
  return bytes;
}

/** Deletes the vendor's copy of a finished task (the plan: "after the output is copied, DELETE /v1/tasks/{id}"). True when it is gone (or never was). */
export async function deleteTask(id: string, deps: Deps = {}): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new RunwayError("That is not a Runway task id.");
  if (engineMock()) { mockTasks.delete(id); return true; }
  try { await call("DELETE", `/tasks/${encodeURIComponent(id)}`, undefined, deps); return true; }
  catch (error) { if (error instanceof RunwayError && error.status === 404) return true; throw error; }
}
