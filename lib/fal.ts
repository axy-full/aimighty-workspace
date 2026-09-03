import { getProvider, providerBaseUrl } from "./providers";

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
  return Boolean(process.env.FAL_KEY);
}

function auth(): string {
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new Error(
      "fal.ai isn't connected — set FAL_KEY in Vercel › Settings › Environment Variables and redeploy."
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

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(explain(res.status, json));
  return json as T;
}

/** Put a job on the queue. Returns at once with the request id. */
export async function falSubmit(model: string, input: unknown, webhookUrl?: string): Promise<FalQueued> {
  const q = webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : "";
  return call<FalQueued>(`${base()}/${model}${q}`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function falStatus(model: string, requestId: string, withLogs = false): Promise<FalStatus> {
  return call<FalStatus>(
    `${base()}/${model}/requests/${encodeURIComponent(requestId)}/status${withLogs ? "?logs=1" : ""}`,
    { headers: { Authorization: auth() } }
  );
}

export async function falResult<T>(model: string, requestId: string): Promise<T> {
  return call<T>(`${base()}/${model}/requests/${encodeURIComponent(requestId)}`, {
    headers: { Authorization: auth() },
  });
}

/**
 * Submit and wait — for the jobs that finish in seconds. Polls the queue
 * gently rather than holding a connection open; gives up with a clear
 * message rather than leaving a function hanging at its time limit.
 */
export async function falRun<T>(
  model: string, input: unknown, opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 1500;
  const queued = await falSubmit(model, input);
  const started = Date.now();
  for (;;) {
    const st = await falStatus(model, queued.request_id);
    if (st.status === "COMPLETED") return falResult<T>(model, queued.request_id);
    if (Date.now() - started > timeoutMs) {
      throw new Error(`fal.ai is still working after ${Math.round(timeoutMs / 1000)}s — the job (${queued.request_id}) was left on the queue.`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
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
