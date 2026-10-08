import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { astraSelfhostConfig, type AstraSelfhostConfig } from "./backend";
import type { AstraRuntimeUsage, AstraSandboxCreateOptions, AstraSandboxHandle, AstraSandboxSdk } from "./sandbox";

/**
 * The self-hosted render workers behind the same narrow seam as the Vercel
 * Sandbox (`AstraSandboxSdk`). Each worker holds one session at a time:
 *
 *   POST   /v1/sessions {name}                 201 {name,status:"running"} | 409 {busy:true}
 *   PUT    /v1/sessions/:name/files?path=…     raw body, under /vercel/sandbox/astra/
 *   POST   /v1/sessions/:name/run              {cmd,args,cwd,timeoutMs} -> {exitCode,stdout,stderr,timedOut}
 *   GET    /v1/sessions/:name/files?path=…     raw bytes, under …/astra/output/, or 404
 *   GET    /v1/sessions/:name                  {name,status,activeCpuMs,durationMs,egressBytes}
 *   DELETE /v1/sessions/:name                  idempotent stop and wipe; 200 with the final usage, 404 already gone
 *
 * (ops/render-worker/README.md.) A stopped session stays readable, with its
 * final usage, until that worker's next create.
 *
 * Every call carries that worker's own bearer (ASTRA_WORKER_SECRETS, or the shared
 * ASTRA_WORKER_SECRET), goes only to
 * a configured origin, never follows a redirect and has a deadline. No message
 * this module produces names a host, a header or the secret: job errors reach
 * the customer.
 */

const SESSION_NAME = /^astra-blender-[a-f0-9-]{36}$/;
const ROOT = "/vercel/sandbox/astra/";
const OUTPUT = "/vercel/sandbox/astra/output/";
const LAUNCHER = `${ROOT}run.py`;
export const ASTRA_WORKER_RUN_TIMEOUT_MS = 190_000;
export const ASTRA_WORKER_CALL_TIMEOUT_MS = 30_000;
const REPLY_LIMIT = 64 * 1024;
/* The run reply carries Blender's stdout/stderr; only exitCode is read. */
const RUN_REPLY_LIMIT = 16 * 1024 * 1024;

/** No worker could take the render now, and none started it: the job goes back to the queue. */
export class AstraWorkerBusyError extends Error {
  readonly notStarted = true;
  constructor(message = "Every render worker is busy. Nothing was started.") { super(message); this.name = "AstraWorkerBusyError"; }
}
/** Every worker refused the request outright (for example a wrong secret), and none started it. */
export class AstraWorkerRefusedError extends Error {
  readonly notStarted = true;
  constructor(message = "The render workers refused this render. Nothing was started.") { super(message); this.name = "AstraWorkerRefusedError"; }
}
/** No worker holds this session and none was out of reach: it ended and was wiped, or it never began. */
export class AstraWorkerSessionMissingError extends Error {
  constructor(message = "No render worker holds this render.") { super(message); this.name = "AstraWorkerSessionMissingError"; }
}
/** A transport or protocol failure, with a fixed customer-safe message. */
export class AstraWorkerError extends Error {
  constructor(message: string) { super(message); this.name = "AstraWorkerError"; }
}

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
export type SelfhostSdkOptions = { config?: AstraSelfhostConfig | null; fetch?: Fetch };
type Context = { config: AstraSelfhostConfig; fetch: Fetch };
type SessionState = { status: "running" | "stopped"; usage?: Partial<AstraRuntimeUsage> };

/* Final usage of sessions this process stopped. A worker keeps a stopped session
   readable only until its next create, so the read that follows a stop (the
   render's own and a cancel's) is answered from here. Bounded; another process
   reads the worker, and after the worker's next create the name is missing. */
const finals = new Map<string, Partial<AstraRuntimeUsage> | undefined>();
function remember(name: string, usage: Partial<AstraRuntimeUsage> | undefined) {
  if (!usage && finals.has(name)) return;
  finals.delete(name);
  finals.set(name, usage);
  while (finals.size > 256) finals.delete(finals.keys().next().value!);
}

/** The guard: a request URL on a configured worker origin, under the session API, or a refusal. */
export function astraWorkerUrl(config: AstraSelfhostConfig, origin: string, path: string): URL {
  if (!config.urls.includes(origin)) throw new AstraWorkerError("Refused a request to a host that is not a configured render worker.");
  if (!/^\/v1\/sessions(?:[/?]|$)/.test(path)) throw new AstraWorkerError("Refused a request outside the render worker API.");
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new AstraWorkerError("Refused a request to a host that is not a configured render worker.");
  return url;
}

const sessionPath = (name: string) => `/v1/sessions/${encodeURIComponent(name)}`;
const filePath = (name: string, path: string) => `${sessionPath(name)}/files?path=${encodeURIComponent(path)}`;

function safePath(path: string, under: string): boolean {
  return typeof path === "string" && path.startsWith(under) && path.length > under.length && path.length <= 512
    && !path.split("/").some((part) => part === ".." || part === ".") && !/[\0\\]/.test(path);
}

async function call(ctx: Context, origin: string, method: string, path: string, options: { json?: unknown; body?: Uint8Array; timeoutMs: number; signal?: AbortSignal }): Promise<Response> {
  const url = astraWorkerUrl(ctx.config, origin, path);
  // Each worker gets its own secret, never another's.
  const secret = ctx.config.secrets[ctx.config.urls.indexOf(origin)];
  if (!secret) throw new AstraWorkerError("A render worker has no secret configured.");
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  let body: BodyInit | undefined;
  if (options.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.json); }
  else if (options.body) { headers["content-type"] = "application/octet-stream"; body = new Uint8Array(options.body); }
  let response: Response;
  try {
    response = await ctx.fetch(url, { method, headers, body, redirect: "error", signal, cache: "no-store" });
  } catch {
    // The underlying error is dropped on purpose: it can echo the request.
    throw new AstraWorkerError("A render worker could not be reached.");
  }
  if (response.status >= 300 && response.status < 400) {
    await discard(response);
    throw new AstraWorkerError("A render worker answered with a redirect, which is refused.");
  }
  return response;
}

async function discard(response: Response) { await response.body?.cancel().catch(() => {}); }

async function readJson(response: Response, limit = REPLY_LIMIT): Promise<Record<string, unknown>> {
  if (!response.body) throw new AstraWorkerError("A render worker sent an empty reply.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel().catch(() => {}); throw new AstraWorkerError("A render worker sent an oversized reply."); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AstraWorkerError) throw error;
    throw new AstraWorkerError("A render worker reply was cut off.");
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new AstraWorkerError("A render worker sent an invalid reply."); }
}

const metric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
function usageOf(body: Record<string, unknown>): Partial<AstraRuntimeUsage> | undefined {
  const usage = { activeCpuMs: metric(body.activeCpuMs), durationMs: metric(body.durationMs), egressBytes: metric(body.egressBytes) };
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}
function sessionOf(body: Record<string, unknown>, name: string): SessionState {
  if (body.name !== name || (body.status !== "running" && body.status !== "stopped")) throw new AstraWorkerError("A render worker sent an invalid session reply.");
  return { status: body.status, usage: usageOf(body) };
}

function handleFor(ctx: Context, origin: string | null, name: string, state: SessionState): AstraSandboxHandle {
  const bound = () => {
    if (!origin) throw new AstraWorkerError("This render has already stopped.");
    return origin;
  };
  const handle: AstraSandboxHandle = {
    name,
    status: state.status,
    totalActiveCpuDurationMs: state.usage?.activeCpuMs,
    totalDurationMs: state.usage?.durationMs,
    totalEgressBytes: state.usage?.egressBytes,
    async writeFiles(files, options) {
      const at = bound();
      for (const file of files) {
        if (!safePath(file.path, ROOT)) throw new AstraWorkerError("A render file is outside the render directory.");
        const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
        const response = await call(ctx, at, "PUT", filePath(name, file.path), { body: content, timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS, signal: options?.signal });
        await discard(response);
        if (!response.ok) throw new AstraWorkerError("A render worker did not accept a render file.");
      }
    },
    async runCommand(command) {
      const at = bound();
      // Only the fixed launcher runs, sent exactly as the worker protocol names it (no other keys).
      if (command.cmd !== "/usr/bin/python3" || command.args.length !== 1 || (command.args[0] !== LAUNCHER && command.args[0] !== "run.py")
        || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 180_000)
        throw new AstraWorkerError("Only the fixed render launcher runs on a render worker.");
      const response = await call(ctx, at, "POST", `${sessionPath(name)}/run`, {
        json: { cmd: "/usr/bin/python3", args: ["run.py"], cwd: ROOT.slice(0, -1), timeoutMs: command.timeoutMs },
        timeoutMs: ASTRA_WORKER_RUN_TIMEOUT_MS, signal: command.signal,
      });
      if (!response.ok) { await discard(response); throw new AstraWorkerError("A render worker did not run the render."); }
      const reply = await readJson(response, RUN_REPLY_LIMIT);
      if (typeof reply.exitCode !== "number" || !Number.isInteger(reply.exitCode)) throw new AstraWorkerError("A render worker sent an invalid run reply.");
      return { exitCode: reply.exitCode };
    },
    async readFile(file, options) {
      const at = bound();
      if (!safePath(file.path, OUTPUT)) throw new AstraWorkerError("A render output is outside the output directory.");
      const response = await call(ctx, at, "GET", filePath(name, file.path), { timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS, signal: options?.signal });
      if (response.status === 404) { await discard(response); return null; }
      if (!response.ok || !response.body) { await discard(response); throw new AstraWorkerError("A render worker did not return a render output."); }
      return Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
    },
    async stop(options) {
      if (!origin) { handle.status = "stopped"; return; }
      const signal = options?.signal;
      // The stop answers with the final usage, frozen at stop; 404 means the session is already gone.
      const response = await call(ctx, origin, "DELETE", sessionPath(name), { timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS, signal });
      if (!response.ok && response.status !== 404) { await discard(response); throw new AstraWorkerError("A render worker did not confirm the stop."); }
      let usage: Partial<AstraRuntimeUsage> | undefined;
      if (response.ok) {
        try { usage = usageOf(await readJson(response)); } catch { /* read below */ }
      } else await discard(response);
      // A stop reply without usage: the stopped session stays readable until the worker's next create.
      if (!usage) {
        try {
          const read = await call(ctx, origin, "GET", sessionPath(name), { timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS, signal });
          if (read.ok) usage = sessionOf(await readJson(read), name).usage; else await discard(read);
        } catch { /* usage stays unknown: the job holds its reservation as uncertain */ }
      }
      remember(name, usage);
      handle.status = "stopped";
      if (usage) {
        handle.totalActiveCpuDurationMs = usage.activeCpuMs;
        handle.totalDurationMs = usage.durationMs;
        handle.totalEgressBytes = usage.egressBytes;
      }
    },
  };
  return handle;
}

function contextOf(options: SelfhostSdkOptions): Context {
  const config = options.config === undefined ? astraSelfhostConfig() : options.config;
  if (!config) throw new AstraWorkerRefusedError("Self-hosted render workers are not configured. Nothing was started.");
  return { config, fetch: options.fetch ?? ((input, init) => fetch(input, init)) };
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || !SESSION_NAME.test(name)) throw new AstraWorkerError("Invalid render identity.");
  return name;
}

/** Clear a session a worker may have begun when its reply was lost: settled only when the worker confirms. */
async function clearAmbiguous(ctx: Context, origin: string, name: string): Promise<"unavailable" | "unknown"> {
  try {
    const response = await call(ctx, origin, "DELETE", sessionPath(name), { timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS });
    await discard(response);
    return response.ok || response.status === 404 ? "unavailable" : "unknown";
  } catch { return "unknown"; }
}

/* 4xx answers other than 408/409/429 are definite refusals: the worker checks the request before it starts anything. */
const REFUSED = new Set([400, 401, 403, 404, 405, 411, 413, 415, 422]);

export function createSelfhostSdk(options: SelfhostSdkOptions = {}): AstraSandboxSdk {
  return {
    /**
     * Try each worker in configured order and take the first 201. A 409 is a
     * worker busy with another render. A lost or unclear reply is cleared with a
     * DELETE of this name on that worker; if even that is unconfirmed the
     * attempt stops there, because the render may have begun on it. Only when
     * every worker answered that it did not start this name is a not-started
     * error thrown: busy (retry later) or refused (configuration).
     */
    async create(createOptions: AstraSandboxCreateOptions) {
      const ctx = contextOf(options);
      const name = checkName(createOptions.name);
      const outcomes: ("busy" | "refused" | "unavailable" | "unknown")[] = [];
      for (const origin of ctx.config.urls) {
        let response: Response;
        try {
          response = await call(ctx, origin, "POST", "/v1/sessions", { json: { name }, timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS, signal: createOptions.signal ?? undefined });
        } catch {
          const outcome = await clearAmbiguous(ctx, origin, name);
          outcomes.push(outcome);
          if (outcome === "unknown") break;
          continue;
        }
        if (response.status === 201) {
          await discard(response);
          return handleFor(ctx, origin, name, { status: "running" });
        }
        await discard(response);
        if (response.status === 409 || response.status === 429) { outcomes.push("busy"); continue; }
        if (REFUSED.has(response.status)) { outcomes.push("refused"); continue; }
        const outcome = await clearAmbiguous(ctx, origin, name);
        outcomes.push(outcome);
        if (outcome === "unknown") break;
      }
      if (outcomes.includes("unknown")) throw new AstraWorkerError("A render worker did not confirm whether this render started.");
      if (outcomes.some((outcome) => outcome === "busy" || outcome === "unavailable")) throw new AstraWorkerBusyError();
      throw new AstraWorkerRefusedError();
    },
    /** Read-only: ask each worker for this name. Never creates or resumes anything. */
    async get(getOptions) {
      const ctx = contextOf(options);
      const name = checkName(getOptions.name);
      if (finals.has(name)) return handleFor(ctx, null, name, { status: "stopped", usage: finals.get(name) });
      let unreachable = false;
      for (const origin of ctx.config.urls) {
        let response: Response;
        try {
          response = await call(ctx, origin, "GET", sessionPath(name), { timeoutMs: ASTRA_WORKER_CALL_TIMEOUT_MS, signal: getOptions.signal });
        } catch { unreachable = true; continue; }
        if (response.status === 404) { await discard(response); continue; }
        if (!response.ok) { await discard(response); unreachable = true; continue; }
        return handleFor(ctx, origin, name, sessionOf(await readJson(response), name));
      }
      if (unreachable) throw new AstraWorkerError("A render worker could not be reached to read this render.");
      throw new AstraWorkerSessionMissingError();
    },
  };
}

/** For tests: forget remembered final usage. */
export function forgetAstraWorkerSessions() { finals.clear(); }
