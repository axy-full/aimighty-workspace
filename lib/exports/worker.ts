import { exportWorkerConfig, type ExportWorkerConfig } from "./limits";

/**
 * The export workers behind a narrow client: the session protocol of ops/remotion-worker/README.md.
 *
 *   POST   /v1/sessions {name}                 201 | 409 {busy:true}
 *   PUT    /v1/sessions/:name/files?path=…     raw body, under /vercel/sandbox/remotion/
 *   POST   /v1/sessions/:name/run              the fixed export command only
 *   GET    /v1/sessions/:name/files?path=…     raw bytes under …/output/, or 404
 *   DELETE /v1/sessions/:name                  idempotent stop and wipe
 *
 * Every call carries that worker's own bearer, goes only to a configured origin, never follows a redirect and has a
 * deadline. No message this module produces names a host, a header or a secret: a job's error reaches the customer.
 */

export const REMOTION_ROOT = "/vercel/sandbox/remotion";
export const EXPORT_COMMAND = { cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"] } as const;
export const SESSION_NAME = /^remotion-export-[0-9a-f-]{36}$/;
export const FILE_CALL_TIMEOUT_MS = 180_000;
/** Reading a large output end to end (a ProRes file of up to about 1.4 GB). */
export const STREAM_CALL_TIMEOUT_MS = 600_000;
const CONTROL_CALL_TIMEOUT_MS = 30_000;
const REPLY_LIMIT = 16 * 1024 * 1024;
/** The largest output a worker may send: a 60 s ProRes 422 HQ file is about 1.4 GB (the worker's own cap is 2000 MiB). */
export const OUTPUT_LIMIT = 2000 * 1024 * 1024;
/** A small text output (result.json, subtitles) is read whole; anything bigger is streamed. */
const SMALL_OUTPUT_LIMIT = 4 * 1024 * 1024;

/** No worker could take the export now, and none started it: the job stays queued. */
export class ExportWorkerBusyError extends Error {
  readonly notStarted = true;
  constructor() { super("Every export worker is busy. This export starts when one is free."); this.name = "ExportWorkerBusyError"; }
}
/** Every worker refused the request outright (for example a wrong secret), and none started it. */
export class ExportWorkerRefusedError extends Error {
  readonly notStarted = true;
  constructor() { super("The export workers refused this export."); this.name = "ExportWorkerRefusedError"; }
}
/** A transport or protocol failure, with a fixed customer-safe message. */
export class ExportWorkerError extends Error {
  constructor(message: string) { super(message); this.name = "ExportWorkerError"; }
}

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
export type ExportWorkerDeps = { config?: ExportWorkerConfig | null; fetch?: Fetch };

export type RunReply = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

export type ExportSession = {
  name: string;
  /** Which worker holds it (an index into the configuration, never a host). */
  worker: number;
  putFile(relativePath: string, bytes: Uint8Array | string): Promise<void>;
  run(timeoutMs: number, signal?: AbortSignal): Promise<RunReply>;
  /** A small output (result.json, a subtitle file) read whole; null when the worker has no such output. */
  readOutput(relativePath: string): Promise<Buffer | null>;
  /** A large output (a video) as a stream and its length, so memory stays flat; the caller reads it to the end or cancels it. null when there is none. */
  streamOutput(relativePath: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null } | null>;
  stop(): Promise<void>;
};

const sessionPath = (name: string) => `/v1/sessions/${encodeURIComponent(name)}`;
const filePath = (name: string, path: string) => `${sessionPath(name)}/files?path=${encodeURIComponent(path)}`;

/** A path under `input/` or `output/`: plain segments only. */
function relative(path: string): string {
  if (!path || path.length > 200 || path.startsWith("/") || /[\0\\]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ExportWorkerError("An export file name was refused.");
  }
  return path;
}

async function call(config: ExportWorkerConfig, doFetch: Fetch, index: number, method: string, path: string, options: { json?: unknown; body?: Uint8Array; timeoutMs: number; signal?: AbortSignal }): Promise<Response> {
  const origin = config.urls[index];
  const secret = config.secrets[index];
  if (!origin || !secret) throw new ExportWorkerError("An export worker has no secret configured.");
  if (!/^\/v1\/sessions(?:[/?]|$)/.test(path)) throw new ExportWorkerError("Refused a request outside the export worker API.");
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new ExportWorkerError("Refused a request to a host that is not a configured export worker.");
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  let body: BodyInit | undefined;
  if (options.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.json); }
  else if (options.body) { headers["content-type"] = "application/octet-stream"; body = new Uint8Array(options.body); }
  let response: Response;
  try {
    response = await doFetch(url, { method, headers, body, redirect: "error", signal, cache: "no-store" });
  } catch {
    // The underlying error is dropped on purpose: it can echo the request.
    throw new ExportWorkerError("An export worker could not be reached.");
  }
  if (response.status >= 300 && response.status < 400) {
    await discard(response);
    throw new ExportWorkerError("An export worker answered with a redirect, which is refused.");
  }
  return response;
}

const discard = async (response: Response) => { await response.body?.cancel().catch(() => {}); };

async function readBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new ExportWorkerError("An export worker sent an oversized reply."); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ExportWorkerError) throw error;
    throw new ExportWorkerError("An export worker reply was cut off.");
  }
  return Buffer.concat(chunks, size);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBytes(response, REPLY_LIMIT);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ExportWorkerError("An export worker sent an invalid reply."); }
}

/** 4xx answers other than 408/409/429 are definite refusals: the worker checks the request before it starts anything. */
const REFUSED = new Set([400, 401, 403, 404, 405, 411, 413, 415, 422]);

function sessionOn(config: ExportWorkerConfig, doFetch: Fetch, index: number, name: string): ExportSession {
  return {
    name,
    worker: index,
    async putFile(path, bytes) {
      const content = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
      const response = await call(config, doFetch, index, "PUT", filePath(name, `${REMOTION_ROOT}/${relative(path)}`), { body: content, timeoutMs: FILE_CALL_TIMEOUT_MS });
      await discard(response);
      if (!response.ok) throw new ExportWorkerError("An export worker did not accept a file.");
    },
    async run(timeoutMs, signal) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new ExportWorkerError("An export run time was refused.");
      // Exactly what the worker's protocol names: the fixed command, nothing else.
      const response = await call(config, doFetch, index, "POST", `${sessionPath(name)}/run`, {
        json: { cmd: EXPORT_COMMAND.cmd, args: [...EXPORT_COMMAND.args], cwd: REMOTION_ROOT, timeoutMs },
        timeoutMs: timeoutMs + 5_000,
        signal,
      });
      if (!response.ok) { await discard(response); throw new ExportWorkerError("An export worker did not run the export."); }
      const reply = await readJson(response);
      if (typeof reply.exitCode !== "number" || !Number.isInteger(reply.exitCode)) throw new ExportWorkerError("An export worker sent an invalid run reply.");
      return { exitCode: reply.exitCode, stdout: String(reply.stdout ?? ""), stderr: String(reply.stderr ?? ""), timedOut: reply.timedOut === true };
    },
    async readOutput(path) {
      const response = await call(config, doFetch, index, "GET", filePath(name, `${REMOTION_ROOT}/output/${relative(path)}`), { timeoutMs: FILE_CALL_TIMEOUT_MS });
      if (response.status === 404) { await discard(response); return null; }
      if (!response.ok) { await discard(response); throw new ExportWorkerError("An export worker did not return an output."); }
      return readBytes(response, SMALL_OUTPUT_LIMIT);
    },
    async streamOutput(path) {
      const response = await call(config, doFetch, index, "GET", filePath(name, `${REMOTION_ROOT}/output/${relative(path)}`), { timeoutMs: STREAM_CALL_TIMEOUT_MS });
      if (response.status === 404) { await discard(response); return null; }
      if (!response.ok || !response.body) { await discard(response); throw new ExportWorkerError("An export worker did not return an output."); }
      /* The worker states the length; a reply without one is still capped at OUTPUT_LIMIT while it is read. */
      const declared = response.headers.get("content-length");
      const size = declared === null ? null : Number(declared);
      if (size !== null && (!Number.isSafeInteger(size) || size < 0 || size > OUTPUT_LIMIT)) { await discard(response); throw new ExportWorkerError("An export worker sent an oversized reply."); }
      return { stream: response.body, size };
    },
    async stop() {
      // 404 means already gone; the stop is idempotent.
      const response = await call(config, doFetch, index, "DELETE", sessionPath(name), { timeoutMs: CONTROL_CALL_TIMEOUT_MS });
      await discard(response);
      if (!response.ok && response.status !== 404) throw new ExportWorkerError("An export worker did not confirm the stop.");
    },
  };
}

/** Clear a session a worker may have begun when its reply was lost: settled only when the worker confirms. */
async function clearAmbiguous(config: ExportWorkerConfig, doFetch: Fetch, index: number, name: string): Promise<"unavailable" | "unknown"> {
  try {
    const response = await call(config, doFetch, index, "DELETE", sessionPath(name), { timeoutMs: CONTROL_CALL_TIMEOUT_MS });
    await discard(response);
    return response.ok || response.status === 404 ? "unavailable" : "unknown";
  } catch { return "unknown"; }
}

/**
 * Take the first free worker, in configured order. A 409 is a worker busy with another export. A lost or unclear
 * reply is cleared with a DELETE of this name on that worker; if even that is unconfirmed the attempt stops there,
 * because the export may have begun on it. Only when every worker answered that it did not start this name is a
 * not-started error thrown: busy (try later) or refused (configuration).
 */
export async function openExportSession(name: string, deps: ExportWorkerDeps = {}): Promise<ExportSession> {
  const config = deps.config === undefined ? exportWorkerConfig() : deps.config;
  if (!config) throw new ExportWorkerRefusedError();
  if (!SESSION_NAME.test(name)) throw new ExportWorkerError("Invalid export identity.");
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const outcomes: ("busy" | "refused" | "unavailable" | "unknown")[] = [];
  for (let index = 0; index < config.urls.length; index += 1) {
    let response: Response;
    try {
      response = await call(config, doFetch, index, "POST", "/v1/sessions", { json: { name }, timeoutMs: CONTROL_CALL_TIMEOUT_MS });
    } catch {
      const outcome = await clearAmbiguous(config, doFetch, index, name);
      outcomes.push(outcome);
      if (outcome === "unknown") break;
      continue;
    }
    await discard(response);
    if (response.status === 201) return sessionOn(config, doFetch, index, name);
    if (response.status === 409 || response.status === 429) { outcomes.push("busy"); continue; }
    if (REFUSED.has(response.status)) { outcomes.push("refused"); continue; }
    const outcome = await clearAmbiguous(config, doFetch, index, name);
    outcomes.push(outcome);
    if (outcome === "unknown") break;
  }
  if (outcomes.includes("unknown")) throw new ExportWorkerError("An export worker did not confirm whether this export started.");
  if (outcomes.some((outcome) => outcome === "busy" || outcome === "unavailable")) throw new ExportWorkerBusyError();
  throw new ExportWorkerRefusedError();
}

/** Stop a session by name on every worker (cancel and recovery, when the handle is gone). Never throws. */
export async function stopExportSession(name: string, deps: ExportWorkerDeps = {}): Promise<void> {
  const config = deps.config === undefined ? exportWorkerConfig() : deps.config;
  if (!config || !SESSION_NAME.test(name)) return;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  for (let index = 0; index < config.urls.length; index += 1) {
    try {
      const response = await call(config, doFetch, index, "DELETE", sessionPath(name), { timeoutMs: CONTROL_CALL_TIMEOUT_MS });
      await discard(response);
    } catch { /* the worker's own reaper ends it */ }
  }
}
