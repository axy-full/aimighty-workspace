import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";

/**
 * sync.so lip-sync, DIRECT (the owner, 14 Oct 2026: "lip-sync goes DIRECT through sync.so ... including lipsync-2-pro and sync-3"; 15 Oct: "sync.so
 * (lipsync-2-pro; sync-3 for hero/4K)"). Not through fal.
 *
 * Settings (names only): SYNC_API_KEY, SYNC_BASE_URL (optional; default https://api.sync.so), SYNC_ENABLED (the kill switch, lib/engineGate.ts).
 * Under ENGINE_MOCK=1 nothing is called: a fixture answers, in process.
 *
 * What is called (docs/plans/provider-adapters.md § 1): an asset upload for each of our two inputs (bytes read on the server; our storage links never
 * leave Particl), `POST /v2/generate`, `GET /v2/generate/{id}` (a poll; may wait up to 10 s), the output, and `DELETE /v2/generations/{id}`.
 * **The request and reply field names below follow sync.so's public API as the plan records it and are TO CONFIRM in the first qualification run** (a
 * paid run needs the owner's yes; none is made here). Every reply is read defensively: a field that is not what is expected is a provider failure,
 * never a guess, and nothing is billed on a failure.
 */
export const SYNC_SWITCH = "SYNC_ENABLED";

/**
 * The models and length-mismatch modes Particl offers. Names only: what each model costs is not in the repo. It is read from the server's private
 * vendor price file (lib/vendorPriceFile.ts, unit "second"), where each of these ids is listed in FILE_PRICED_ENGINES.
 */
export const SYNC_MODELS = ["lipsync-2", "lipsync-2-pro", "sync-3"] as const;
export type SyncModel = (typeof SYNC_MODELS)[number];
export const SYNC_DEFAULT_MODEL: SyncModel = "lipsync-2-pro";
export const SYNC_MODES = ["bounce", "loop", "cut_off", "silence", "remap"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];
export const SYNC_DEFAULT_MODE: SyncMode = "bounce";
const DEFAULT_BASE = "https://api.sync.so";
const TIMEOUT_MS = 30_000;
/** The longest a single poll may wait; sync.so answers a status read within 10 s. */
const POLL_TIMEOUT_MS = 20_000;
export const SYNC_OUTPUT_LIMIT_BYTES = 1024 * 1024 * 1024;

/**
 * An address sync.so gave us (an upload address, an output address), accepted only as an https host on sync.so or under it (TO CONFIRM against the hosts it really uses), with no
 * port and no credentials. Nothing else is ever fetched. Every request here also refuses redirects (`redirect: "error"`): a redirect would carry our key, or our bytes, to a host
 * this list never saw.
 */
export function syncHostUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url.hostname === "sync.so" || url.hostname.endsWith(".sync.so") ? url : null;
}

export const syncConfigured = (): boolean => Boolean(process.env.SYNC_API_KEY) || engineMock();

export const isSyncModel = (value: unknown): value is SyncModel => typeof value === "string" && (SYNC_MODELS as readonly string[]).includes(value);
export const isSyncMode = (value: unknown): value is SyncMode => typeof value === "string" && (SYNC_MODES as readonly string[]).includes(value);

/** A refusal or failure from sync.so (or from reaching it). `rejectedBeforeGeneration`: it answered 4xx before any work, so nothing was taken. */
export class SyncError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly body: unknown = null, readonly rejectedBeforeGeneration = false) { super(message); this.name = "SyncError"; }
}

/** The finished job's output is not one we will fetch (a host off the allow-list, none named, or over the size we keep). It will never become fetchable: the caller settles the job and stops asking. */
export class SyncOutputRefused extends SyncError {
  constructor(message: string) { super(message); this.name = "SyncOutputRefused"; }
}

export type SyncStatus = "pending" | "processing" | "completed" | "failed";
/** `reportedCostUsd`: what sync.so says the job cost, when its reply says (the field is TO CONFIRM); absent when it does not. */
export type SyncGeneration = { id: string; status: SyncStatus; outputUrl?: string; outputDuration?: number; error?: string; reportedCostUsd?: number };

/** The base address: https, or a local stand-in for a test (http on localhost or 127.0.0.1 only). */
function base(): string {
  const raw = (process.env.SYNC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_BASE;
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(raw)) return raw;
  throw new SyncError("SYNC_BASE_URL is not an https address.");
}
function key(): string {
  const value = process.env.SYNC_API_KEY;
  if (!value) throw new SyncError("Lip-sync is not set up: SYNC_API_KEY is needed.");
  return value;
}

type Deps = { fetch?: typeof fetch };
async function call(method: string, path: string, init: { json?: unknown; deps?: Deps; timeout?: number } = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  let res: Response;
  try {
    res = await (init.deps?.fetch ?? recoveryFetch)(`${base()}${path}`, {
      method,
      headers: { "x-api-key": key(), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeout ?? TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("sync.so did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const said = typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : "";
    throw new SyncError(said ? `sync.so refused the request: ${said.slice(0, 200)}` : `sync.so answered ${res.status}.`, res.status, json, res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  }
  return { status: res.status, json, text };
}

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
const mockJobs = new Map<string, { polls: number; seconds: number }>();
let mockSeq = 0;
const MOCK_OUTPUT = Buffer.from("mock-sync-output");

/** Puts one input up as an asset and returns its id. Bytes are sent from the server; the upload address is the vendor's, used once. */
export async function uploadAsset(input: { bytes: Buffer; filename: string; mime: string }, deps: Deps = {}): Promise<string> {
  if (engineMock()) return `mock_asset_${++mockSeq}`;
  const made = await call("POST", "/v2/assets/upload", { json: { fileName: input.filename.slice(0, 200), contentType: input.mime }, deps });
  const uploadUrl = made.json.uploadUrl ?? made.json.url, assetId = made.json.assetId ?? made.json.id;
  const target = syncHostUrl(uploadUrl);
  if (!target || typeof assetId !== "string") throw new SyncError("sync.so's upload reply was not what was expected.", made.status, null, false);
  let put: Response;
  try {
    put = await (deps.fetch ?? recoveryFetch)(target.href, { method: "PUT", headers: { "content-type": input.mime }, body: new Uint8Array(input.bytes), redirect: "error", signal: AbortSignal.timeout(120_000) });
  } catch { throw new SyncError("sync.so did not take the upload."); }
  if (!put.ok) throw new SyncError(`sync.so did not take the upload (${put.status}).`, put.status, null, put.status >= 400 && put.status < 500);
  return assetId;
}

/** Starts one lip-sync job. The caller holds the reservation; this is the one paid request, and it is never repeated for the same job. */
export async function submitLipSync(input: { model: SyncModel; videoAssetId: string; audioAssetId: string; syncMode: SyncMode }, deps: Deps = {}): Promise<{ id: string }> {
  if (engineMock()) { const id = `mock_sync_${++mockSeq}`; mockJobs.set(id, { polls: 0, seconds: 5 }); return { id }; }
  const { json, status } = await call("POST", "/v2/generate", {
    json: { model: input.model, input: [{ type: "video", assetId: input.videoAssetId }, { type: "audio", assetId: input.audioAssetId }], options: { sync_mode: input.syncMode } }, deps,
  });
  if (typeof json.id !== "string" || !json.id) throw new SyncError("sync.so's reply named no job.", status);
  return { id: json.id };
}

const STATUS: Record<string, SyncStatus> = { PENDING: "pending", PROCESSING: "processing", COMPLETED: "completed", FAILED: "failed", REJECTED: "failed" };

/** One poll. A status the vendor does not name here is "processing": never a verdict from a word we do not know. */
export async function generationStatus(id: string, deps: Deps = {}): Promise<SyncGeneration> {
  if (engineMock()) {
    const job = mockJobs.get(id);
    if (!job) throw new SyncError("sync.so has no such job.", 404, null, true);
    job.polls += 1;
    return job.polls < 2 ? { id, status: "processing" } : { id, status: "completed", outputUrl: `mock://${id}`, outputDuration: job.seconds };
  }
  const { json } = await call("GET", `/v2/generate/${encodeURIComponent(id)}`, { deps, timeout: POLL_TIMEOUT_MS });
  const status = STATUS[String(json.status ?? "").toUpperCase()] ?? "processing";
  const duration = Number(json.outputDuration);
  const cost = json.cost == null ? NaN : Number(json.cost);
  return {
    ...(Number.isFinite(cost) && cost >= 0 ? { reportedCostUsd: cost } : {}),
    id, status,
    ...(typeof json.outputUrl === "string" ? { outputUrl: json.outputUrl } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { outputDuration: duration } : {}),
    ...(typeof json.error === "string" ? { error: json.error.slice(0, 300) } : {}),
  };
}

/** The finished clip. From the output address the vendor named (https only), capped; nothing is stored here. */
export async function downloadOutput(output: { id: string; url?: string }, deps: Deps = {}): Promise<Buffer> {
  if (engineMock()) return Buffer.from(MOCK_OUTPUT);
  const url = syncHostUrl(output.url);
  if (!url) throw new SyncOutputRefused("sync.so named no output we can download.");
  let res: Response;
  try { res = await (deps.fetch ?? recoveryFetch)(url.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(300_000) }); }
  catch { throw new SyncError("The lip-synced clip could not be downloaded."); }
  if (!res.ok) throw new SyncError(`The lip-synced clip could not be downloaded (${res.status}).`, res.status);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > SYNC_OUTPUT_LIMIT_BYTES) throw new SyncOutputRefused("The lip-synced clip is larger than Particl keeps.");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > SYNC_OUTPUT_LIMIT_BYTES) throw new SyncError("The lip-synced clip came back empty or too large.");
  return bytes;
}

/** Deletes the vendor's copy of a finished generation (owner, 14 Oct: "Delete the vendor's copy once we've stored the output"). True when it is gone (or never was). */
export async function deleteGeneration(id: string, deps: Deps = {}): Promise<boolean> {
  if (engineMock()) { mockJobs.delete(id); return true; }
  try { await call("DELETE", `/v2/generations/${encodeURIComponent(id)}`, { deps }); return true; }
  catch (error) { if (error instanceof SyncError && error.status === 404) return true; throw error; }
}

/** Deletes an uploaded input asset, best effort (the asset delete endpoint is TO CONFIRM). True when gone or not found. */
export async function deleteAsset(id: string, deps: Deps = {}): Promise<boolean> {
  if (engineMock()) return true;
  try { await call("DELETE", `/v2/assets/${encodeURIComponent(id)}`, { deps }); return true; }
  catch (error) { if (error instanceof SyncError && error.status === 404) return true; throw error; }
}
