import { recoveryFetch as fetch } from "./recovery";
import { getProvider, providerBaseUrl } from "./providers";
import { vendorKey } from "./vendorKeys";
import { engineMock, mockJobId, isMockJob, mockDone, fixtureUrl } from "./mock";

/**
 * fal.ai — where identities are trained and rendered.
 *
 * Everything goes through their queue: submit, then ask after it. Training
 * takes minutes, so the request id is written to the row and the cron (or
 * the next person to open the identity) asks how it went. Rendering takes
 * seconds, so `falRun` waits for it inside one request.
 *
 * The key is server-side only (FAL_KEY). Nothing here is reachable from
 * the browser.
 */

export function falConfigured(): boolean {
  if (engineMock()) return true;
  return Boolean(vendorKey("fal"));
}

function auth(): string {
  const key = vendorKey("fal");
  if (!key) {
    throw new Error(
      "That engine isn't connected for this workspace. Ask the platform to connect it."
    );
  }
  return `Key ${key}`;
}

const base = () => providerBaseUrl(getProvider("fal"));

export type FalQueued = {
  request_id: string;
  status_url?: string;
  response_url?: string;
  cancel_url?: string;
};

export type FalLog = { message: string; timestamp?: string; level?: string };

export type FalStatus = {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  queue_position?: number;
  logs?: FalLog[] | null;
  metrics?: { inference_time?: number };
};

/** What their errors look like, put into a sentence a person can act on. */
function explain(status: number, json: unknown): string {
  const j = (json ?? {}) as { detail?: unknown; message?: string; error?: string };
  let detail = "";
  if (Array.isArray(j.detail)) {
    detail = j.detail
      .map((d) => {
        const x = d as { loc?: unknown[]; msg?: string };
        return `${Array.isArray(x.loc) ? x.loc.filter((l) => l !== "body").join(".") + ": " : ""}${x.msg ?? ""}`;
      })
      .join("; ");
  } else if (typeof j.detail === "string") detail = j.detail;
  else if (j.message) detail = j.message;
  else if (j.error) detail = j.error;
  if (status === 401 || status === 403) return `The render service rejected the key (${status})${detail ? ` — ${detail}` : ""}.`;
  if (status === 402) return "The render service account is out of credit — top it up in the render account billing settings.";
  if (status === 422) return `The render service refused the request: ${detail || "invalid input"}.`;
  if (status === 429) return "The render service rate limit — too many requests at once. Try a new request later.";
  return `The render service returned ${status}${detail ? `: ${detail}` : ""}.`;
}

export class FalHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "FalHttpError"; }
}

export function falSubmissionRejected(error: unknown): boolean {
  return error instanceof FalHttpError && [400, 401, 402, 403, 404, 422, 429].includes(error.status);
}

async function call<T>(url: string, init: RequestInit, timeoutMs = 60_000): Promise<T> {
  /* Without a deadline a hung socket holds the whole serverless function to
     its maxDuration — five minutes of paid compute spent waiting on a
     connection that will never answer. */
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      // Deliberately NOT worded as a timeout: classifyFailure treats that word
      // as retryable, and a submit that may already have been accepted (and
      // billed) must never be sent a second time on its own.
      throw new Error(
        `The render service did not answer within ${Math.round(timeoutMs / 1000)}s. The job may still be on their queue.`
      );
    }
    throw new Error(`Could not reach the render service: ${err.message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new FalHttpError(res.status, explain(res.status, json));
  return json as T;
}

/** Put a job on the queue. Returns at once with the request id. */
export async function falSubmit(model: string, input: unknown, webhookUrl?: string): Promise<FalQueued> {
  if (engineMock()) return { request_id: mockJobId("fal") };
  const q = webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : "";
  const queued = await call<FalQueued>(`${base()}/${model}${q}`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!queued || typeof queued.request_id !== "string" || !queued.request_id) throw new Error("The render service returned no usable request handle. Submission may have been accepted.");
  return queued;
}

export async function falStatus(model: string, requestId: string, withLogs = false): Promise<FalStatus> {
  if (isMockJob(requestId)) return { status: mockDone(requestId) ? "COMPLETED" : "IN_PROGRESS", logs: [] } as FalStatus;
  return call<FalStatus>(
    `${base()}/${queueApp(model)}/requests/${encodeURIComponent(requestId)}/status${withLogs ? "?logs=1" : ""}`,
    { headers: { Authorization: auth() } }
  );
}

export async function falResult<T>(model: string, requestId: string): Promise<T> {
  if (isMockJob(requestId)) {
    return {
      video: { url: fixtureUrl(model === "topaz/upscale/video/creative" ? "astra-clip.mp4" : "clip.mp4"), content_type: "video/mp4", file_size: 991017 },
      image: { url: fixtureUrl("still.png"), content_type: "image/png" },
      images: [{ url: fixtureUrl("still.png"), width: 256, height: 256, content_type: "image/png" }],
      seed: 1, has_nsfw_concepts: [false],
      diffusers_lora_file: { url: fixtureUrl("still.png") }, config_file: { url: fixtureUrl("still.png") },
    } as unknown as T;
  }
  return call<T>(`${base()}/${queueApp(model)}/requests/${encodeURIComponent(requestId)}`, {
    headers: { Authorization: auth() },
  });
}

/** Queue receipts belong to the application, not the submission subpath.
 * Match fal's client queue.ts: owner/alias, with an optional workflow/comfy
 * namespace. Keeping /upscale/image or /video/creative here produces a 405
 * even when the paid submission succeeded. Existing persisted handles work
 * without changing their model or purchasing a replacement request. */
function queueApp(endpoint: string): string {
  const parts = endpoint.split("/");
  const length = parts[0] === "workflows" || parts[0] === "comfy" ? 3 : 2;
  if (
    parts.length < length ||
    parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")
  ) throw new Error("Invalid fal queue application identifier.");
  return parts.slice(0, length).join("/");
}

/**
 * Wait for a job that is ALREADY on the queue.
 *
 * Split out from falRun so the caller can write the request id down before
 * it starts waiting. That one line is what makes a fal render durable: if
 * this function instance dies mid-wait, fal still has the job, and the cron
 * can finish it later from the id rather than paying for it twice.
 */
export async function falAwait<T>(
  model: string, requestId: string, opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 1500;
  const started = Date.now();
  for (;;) {
    const st = await falStatus(model, requestId);
    if (st.status === "COMPLETED") return falResult<T>(model, requestId);
    if (Date.now() - started > timeoutMs) {
      throw new Error(`The render service is still working after ${Math.round(timeoutMs / 1000)}s — the job (${requestId}) is still on their queue and will be picked up again.`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Submit and wait, for jobs short enough to sit inside one request. */
export async function falRun<T>(
  model: string, input: unknown, opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const queued = await falSubmit(model, input);
  return falAwait<T>(model, queued.request_id, opts);
}

/** Training progress out of the trainer's own log lines ("… 340/1500 …"). */
export function progressFromLogs(logs: FalLog[] | null | undefined): number | null {
  if (!logs?.length) return null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].message.match(/(\d+)\s*\/\s*(\d+)/);
    if (m && Number(m[2]) > 0) return Math.min(100, Math.round((Number(m[1]) / Number(m[2])) * 100));
  }
  return null;
}
