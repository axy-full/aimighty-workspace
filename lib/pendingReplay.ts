/**
 * A saved paid request, sent and — while the server answers that it is still
 * being accepted — sent again, exactly as saved, until it has a final answer.
 *
 * A long paid run (an Atomik turn with high effort, a long read) is answered
 * "still being accepted" (409, `pending`, Retry-After, not
 * `Idempotency-Status: complete`) after ANSWER_AFTER_MS and finishes on the
 * server after the reply (lib/generationRequests.ts). Sending the same saved
 * request again, under the same Idempotency-Key, never starts it twice: the
 * server answers from the request's claim, "still being accepted" until the
 * run has saved its reply, then that reply. So asking again is free and safe.
 *
 * It asks again after the server's Retry-After, backing off, for at most
 * PENDING_WAIT_MS. Then, or when the caller no longer wants the answer (a
 * switch of account or workspace), the last answer stands and the caller keeps
 * the saved request for Recover, as before.
 */

/** How long a saved request is asked about before it is handed back to Recover. */
export const PENDING_WAIT_MS = 6 * 60_000;
/** The waits between asks, the last repeated; never shorter than the server's Retry-After. */
export const PENDING_STEPS_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000];

export type PendingReplayOptions = {
  /** False once the answer is no longer wanted here: the loop stops and the request stays saved. */
  stillWanted?: () => boolean;
  /** Tests only. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PendingReplayResult = {
  response: Response;
  /** The body of the last answer, or null when it was not JSON. */
  data: Record<string, unknown> | null;
  /** True when the last answer is still "being accepted" (the wait ran out, or the answer is no longer wanted). */
  pending: boolean;
};

/** A reply that says the request is still being accepted, and is not final. */
export function stillAccepting(response: Response, data: unknown): boolean {
  return response.status === 409
    && response.headers.get("Idempotency-Status") !== "complete"
    && !!data && typeof data === "object" && (data as { pending?: unknown }).pending === true;
}

/** Retry-After in milliseconds (seconds or an HTTP date), or 0. */
function retryAfterMs(response: Response, at: number): number {
  const raw = response.headers.get("Retry-After");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - at) : 0;
}

/** `send` sends the one saved request (same key, same body) each time it is called. */
export async function sendUntilAnswered(send: () => Promise<Response>, options: PendingReplayOptions = {}): Promise<PendingReplayResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const wanted = options.stillWanted ?? (() => true);
  const limit = options.waitMs ?? PENDING_WAIT_MS;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!stillAccepting(response, data)) return { response, data, pending: false };
    const wait = Math.max(retryAfterMs(response, now()), PENDING_STEPS_MS[Math.min(attempt, PENDING_STEPS_MS.length - 1)]);
    if (!wanted() || now() + wait - started > limit) return { response, data, pending: true };
    await sleep(wait);
    if (!wanted()) return { response, data, pending: true };
  }
}
