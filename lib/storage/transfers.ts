/**
 * A per-process limit on provider → storage transfers.
 *
 * The heartbeat reconciles many workspaces at once, and every finished render
 * it sees is copied into storage. Each copy holds a socket to the provider,
 * one to the store and a multipart part buffer (8 MiB on R2), so thirty at
 * once is thirty of each. With the limit (STORAGE_TRANSFER_CONCURRENCY,
 * default 4) the rest wait their turn here instead.
 *
 * Waiting is never silent and never longer than the caller can afford: every
 * wait is bounded by `maxWaitMs`, by an absolute `deadlineAt` (the last moment
 * the caller can start a transfer; past it even a free slot is refused) and
 * by an abort `signal`, whichever comes first, and ends in a
 * TransferQueueTimeoutError (or the signal's own reason). A caller that gets
 * one has not started a transfer and can retry on its next pass, exactly as
 * after a failed save.
 */

export const DEFAULT_TRANSFER_CONCURRENCY = 4;
const MAX_TRANSFER_CONCURRENCY = 64;

/** The configured limit; a missing or unusable value falls back to the default. */
export function transferConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STORAGE_TRANSFER_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_TRANSFER_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_TRANSFER_CONCURRENCY;
  return Math.min(value, MAX_TRANSFER_CONCURRENCY);
}

export class TransferQueueTimeoutError extends Error {
  readonly code = "TRANSFER_QUEUE_TIMEOUT";
  constructor(waitedMs: number, pastDeadline = false) {
    super(pastDeadline
      ? "Storage is busy: too little time is left to finish this transfer; it will be retried on the next pass."
      : `Storage is busy with other transfers; this one waited ${Math.round(waitedMs / 1000)}s and will be retried on the next pass.`);
    this.name = "TransferQueueTimeoutError";
  }
}

export type TransferWaitOptions = {
  /** Longest wait for a slot, in ms. */
  maxWaitMs?: number;
  /** Absolute epoch ms after which the caller cannot afford to START a
   *  transfer: no slot is granted after it, even a free one. */
  deadlineAt?: number;
  signal?: AbortSignal;
};

export type TransferLimiter = {
  /** Resolves with a release function once a slot is free; release exactly once. */
  acquire(options?: TransferWaitOptions): Promise<() => void>;
  readonly active: number;
  readonly waiting: number;
  readonly limit: number;
};

type Waiter = { grant: () => void };

export function createTransferLimiter(limit: number): TransferLimiter {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid transfer limit.");
  let active = 0;
  const queue: Waiter[] = [];

  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next.grant(); // the slot passes straight to the next waiter
      else active--;
    };
  };

  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    limit,
    acquire(options = {}) {
      const { signal } = options;
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (options.deadlineAt != null && options.deadlineAt <= Date.now()) return Promise.reject(new TransferQueueTimeoutError(0, true));
      if (active < limit && !queue.length) {
        active++;
        return Promise.resolve(releaser());
      }
      const started = Date.now();
      const bounds = [options.maxWaitMs, options.deadlineAt != null ? options.deadlineAt - started : undefined]
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      const waitMs = bounds.length ? Math.max(0, Math.min(...bounds)) : null;
      if (waitMs === 0) return Promise.reject(new TransferQueueTimeoutError(0));
      return new Promise<() => void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const leave = () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => { leave(); reject(signal!.reason); };
        const waiter: Waiter = {
          grant: () => { leave(); resolve(releaser()); },
        };
        queue.push(waiter);
        if (waitMs != null) timer = setTimeout(() => { leave(); reject(new TransferQueueTimeoutError(Date.now() - started, options.deadlineAt != null && Date.now() >= options.deadlineAt)); }, waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

let shared: TransferLimiter | null = null;

/** The process-wide limiter, sized from the environment on first use. */
export function transferLimiter(): TransferLimiter {
  return (shared ??= createTransferLimiter(transferConcurrency()));
}
