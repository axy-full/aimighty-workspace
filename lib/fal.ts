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
      "fal.ai isn't connected for this workspace — add its key under Settings › Vendors & keys."
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
  if (status === 401 || status === 403) return `fal.ai rejected the key (${status})${detail ? ` — ${detail}` : ""}.`;
  if (status === 402) return "fal.ai account is out of credit — top it up at fal.ai/dashboard/billing.";
  if (status === 422) return `fal.ai refused the request: ${detail || "invalid input"}.`;
  if (status === 429) return "fal.ai rate limit — too many requests at once; it will be retried.";
  return `fal.ai returned ${status}${detail ? `: ${detail}` : ""}.`;
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
        `fal.ai did not answer within ${Math.round(timeoutMs / 1000)}s. The job may still be on their queue.`
      );
    }
    throw new Error(`Could not reach fal.ai: ${err.message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(explain(res.status, json));
  return json as T;
}

/** Put a job on the queue. Returns at once with the request id. */
export async function falSubmit(model: string, input: unknown, webhookUrl?: string): Promise<FalQueued> {
  if (engineMock()) return { request_id: mockJobId("fal") };
  const q = webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : "";
  return call<FalQueued>(`${base()}/${model}${q}`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function falStatus(model: string, requestId: string, withLogs = false): Promise<FalStatus> {
  if (isMockJob(requestId)) return { status: mockDone(requestId) ? "COMPLETED" : "IN_PROGRESS", logs: [] } as FalStatus;
  return call<FalStatus>(
    `${base()}/${model}/requests/${encodeURIComponent(requestId)}/status${withLogs ? "?logs=1" : ""}`,
    { headers: { Authorization: auth() } }
  );
}

export async function falResult<T>(model: string, requestId: string): Promise<T> {
  if (isMockJob(requestId)) {
    return {
      video: { url: fixtureUrl("clip.mp4"), content_type: "video/mp4", file_size: 991017 },
      images: [{ url: fixtureUrl("still.png"), width: 256, height: 256, content_type: "image/png" }],
      seed: 1, has_nsfw_concepts: [false],
      diffusers_lora_file: { url: fixtureUrl("still.png") }, config_file: { url: fixtureUrl("still.png") },
    } as unknown as T;
  }
  return call<T>(`${base()}/${model}/requests/${encodeURIComponent(requestId)}`, {
    headers: { Authorization: auth() },
  });
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
      throw new Error(`fal.ai is still working after ${Math.round(timeoutMs / 1000)}s — the job (${requestId}) is still on their queue and will be picked up again.`);
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
