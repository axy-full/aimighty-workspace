/**
 * How a page asks "has it finished yet?" — one pace for every status read
 * (a take rendering, a connected-account job, a re-edit, a Genjutsu run):
 *
 *  - the first wait is 2 s, and each read after it waits 1.5× longer, up to 10 s;
 *  - never sooner than the server's own `pollAfterSeconds` when it gives one,
 *    bounded to a minute: the server holds the job's poll lease for exactly
 *    that long after its reply and answers a read inside it with the stored
 *    job and a 30 s wait, so a read that lands early costs a whole round;
 *  - ±20% jitter, so tabs and teammates do not ask in step — upward only when
 *    the server's hint sets the wait, so the jitter never lands a read inside
 *    the lease;
 *  - a failed read doubles the wait, up to a minute, instead of asking again at once;
 *  - one read at a time: a slow reply never has a second read queued behind it;
 *  - nothing is asked while the tab is hidden or offline; the read that fell
 *    due is made the moment the page is back;
 *  - it stops on the terminal set the caller names.
 *
 * Status reads only. A quote or a submit costs money or spends a price, and
 * nothing here ever repeats one.
 */

export const POLL = {
  startMs: 2_000,
  factor: 1.5,
  capMs: 10_000,
  jitter: 0.2,
  /** The most a server hint may hold the next read back. */
  hintCapMs: 60_000,
  /** Added to a server hint, so the read lands after the lease even when the reply was quick. */
  hintMarginMs: 500,
  /** The most consecutive failures may hold the next read back. */
  missCapMs: 60_000,
} as const;

export type PollPace = {
  /** The server's `pollAfterSeconds` from the last reply, if it gave one. */
  hintSeconds?: number | null;
  /** Failed reads in a row. */
  misses?: number;
  /** 0 ≤ n < 1; Math.random by default. */
  random?: () => number;
};

/** ±20% around `ms`. */
function jittered(ms: number, random: () => number): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.max(0, Math.round(ms * (1 + (r * 2 - 1) * POLL.jitter)));
}
/** 0 to +20% above `ms`: spread out, never sooner. */
function jitteredUp(ms: number, random: () => number): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(ms * (1 + r * POLL.jitter));
}

/**
 * The wait before the next read, after `reads` reads (0 before the first).
 * A server hint is a floor: the read lands after it (plus a small margin),
 * whatever the jitter. Pure; `random` is injected so a spec can pin the jitter.
 */
export function pollDelay(reads: number, pace: PollPace = {}): number {
  const { hintSeconds, misses = 0, random = Math.random } = pace;
  const grown = Math.min(POLL.capMs, POLL.startMs * POLL.factor ** Math.max(0, reads));
  const hint = typeof hintSeconds === "number" && Number.isFinite(hintSeconds) && hintSeconds > 0 ? Math.min(POLL.hintCapMs, hintSeconds * 1000) : 0;
  const floor = hint > 0 ? hint + POLL.hintMarginMs : 0;
  const paced = Math.max(grown, hint);
  const backed = misses > 0 ? Math.min(POLL.missCapMs, paced * 2 ** Math.min(misses, 6)) : paced;
  /* The server's hint sets the wait: spread upward from it. The page's own pace: ±20%, still never under the hint. */
  if (floor > 0 && backed <= floor) return jitteredUp(floor, random);
  return Math.max(floor, jittered(backed, random));
}

/** Automatic retries of a one-off read (a list, a catalogue) before the page waits for Try again. */
export const RETRY_TRIES = 3;
/**
 * The wait before automatic retry `misses` of a one-off read that failed
 * `misses` times in a row — about 2 s, 6 s, then 18 s — or null once
 * `tries` are spent and only the person's Try again reads it.
 */
export function retryDelay(misses: number, pace: { tries?: number; random?: () => number } = {}): number | null {
  const { tries = RETRY_TRIES, random } = pace;
  if (!Number.isFinite(misses) || misses < 1 || misses > tries) return null;
  return pollDelay(misses - 1, { misses: misses - 1, random });
}

/** Whether the page can be asked for now, and a way to hear when that changes. */
export type PollPresence = { away: () => boolean; subscribe: (onChange: () => void) => () => void };
export type PollClock = { setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void; random: () => number };

/** The browser's own: away while the tab is hidden or the device is offline. */
export function pagePresence(): PollPresence | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    away: () => document.hidden === true || (typeof navigator !== "undefined" && navigator.onLine === false),
    subscribe: (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      window.addEventListener("online", onChange);
      return () => { document.removeEventListener("visibilitychange", onChange); window.removeEventListener("online", onChange); };
    },
  };
}
const browserClock: PollClock = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

/**
 * `run` after `ms`, never while the page is away: a wait that ends while the
 * tab is hidden or offline runs when the page is back (a one-off read's
 * automatic retry). Returns the cancel.
 */
export function presentTimeout(run: () => void, ms: number, options: { presence?: PollPresence | null; clock?: Pick<PollClock, "setTimeout" | "clearTimeout"> } = {}): () => void {
  const clock = options.clock ?? browserClock;
  const presence = options.presence === undefined ? pagePresence() : options.presence;
  let over = false;
  let unsubscribe: (() => void) | undefined;
  const cancel = () => { over = true; clock.clearTimeout(handle); unsubscribe?.(); unsubscribe = undefined; };
  function fire() {
    if (over) return;
    if (presence?.away()) { unsubscribe ??= presence.subscribe(fire); return; }
    cancel();
    run();
  }
  const handle = clock.setTimeout(fire, ms);
  return cancel;
}

export type PollOptions<T> = {
  /** One status read. Aborted when the poll stops. */
  read: (signal: AbortSignal) => Promise<T>;
  /** The reply is in the terminal set: stop asking. */
  done: (value: T) => boolean;
  onValue: (value: T) => void;
  /** The server's own pacing in the reply, in seconds (`pollAfterSeconds`). */
  hint?: (value: T) => number | null | undefined;
  /** Pacing already known before the first read (a job read moments ago by an earlier poll), in seconds. */
  firstHint?: number | null;
  /** A failed read, with the failures in a row so far. "stop" when asking again cannot help (it is gone, or not this person's). */
  onError?: (error: unknown, misses: number) => "stop" | void;
  /** Read at once instead of after the first wait. */
  immediate?: boolean;
  clock?: PollClock;
  /** null: always present (a server, a spec). Defaults to the page's own visibility and connection. */
  presence?: PollPresence | null;
};
export type Poller = {
  /** Stop for good: no further read, the one in flight is aborted and its reply ignored. */
  stop: () => void;
  /** Read now (after a Try again), unless a read is already out. */
  now: () => void;
};

export function poll<T>(options: PollOptions<T>): Poller {
  const clock = options.clock ?? browserClock;
  const presence = options.presence === undefined ? pagePresence() : options.presence;
  let stopped = false, reads = 0, misses = 0, hint: number | null = options.firstHint ?? null;
  let timer: unknown = null, due = false;
  let inFlight: AbortController | null = null;
  /* Back from hidden or offline: the read that fell due meanwhile is made at once. */
  const unsubscribe = presence?.subscribe(() => {
    if (!stopped && due && !presence.away()) void run();
  });

  const clear = () => { if (timer !== null) { clock.clearTimeout(timer); timer = null; } };
  const finish = () => {
    stopped = true;
    clear();
    unsubscribe?.();
    inFlight?.abort();
    inFlight = null;
  };
  const schedule = () => {
    if (stopped) return;
    clear();
    timer = clock.setTimeout(fire, pollDelay(reads, { hintSeconds: hint, misses, random: clock.random }));
  };
  function fire() {
    timer = null;
    if (stopped) return;
    /* Away: nothing is asked; the read that fell due is made on return. */
    if (presence?.away()) { due = true; return; }
    void run();
  }
  async function run() {
    if (stopped || inFlight) return;
    due = false;
    const controller = new AbortController();
    inFlight = controller;
    let settled = false;
    try {
      const value = await options.read(controller.signal);
      if (stopped || inFlight !== controller) return;
      /* A reply the caller cannot use counts as a failed read, once. */
      options.onValue(value);
      settled = options.done(value);
      const next = options.hint?.(value);
      hint = typeof next === "number" && Number.isFinite(next) ? next : null;
      reads++; misses = 0;
    } catch (error) {
      if (stopped || inFlight !== controller) return;
      reads++; misses++;
      try { settled = options.onError?.(error, misses) === "stop"; } catch { /* asked again after the longer wait */ }
    } finally {
      if (inFlight === controller) inFlight = null;
    }
    if (stopped) return;
    if (settled) { finish(); return; }
    schedule();
  }
  if (options.immediate) {
    if (presence?.away()) due = true;
    else void run();
  } else schedule();

  return {
    stop: finish,
    now: () => {
      if (stopped || inFlight) return;
      clear();
      if (presence?.away()) { due = true; return; }
      void run();
    },
  };
}

/** The server's pacing for a status reply, when it sent one. */
export function pollAfter(reply: unknown): number | null {
  const value = reply && typeof reply === "object" ? (reply as { pollAfterSeconds?: unknown }).pollAfterSeconds : null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Several jobs read in turn, one read per wait: the account's pace for one job
 * is shared out across all of them, so each is still asked about that often,
 * and never more.
 */
export function turnHint(hintSeconds: number | null | undefined, jobs: number): number | null {
  return typeof hintSeconds === "number" && Number.isFinite(hintSeconds) && hintSeconds > 0 ? hintSeconds / Math.max(1, jobs) : null;
}
