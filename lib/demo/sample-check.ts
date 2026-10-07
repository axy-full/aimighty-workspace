import { CHECK_BACKOFF_MS, sampleWorkspaceAnswer, type SampleCheck } from "./sample";

/*
 * The browser's check of "is this the sample workspace?", kept once per workspace scope and shared by every screen that
 * asks (no React here: use-sample.ts reads it through useSyncExternalStore). One read of GET /api/demo/sample answers
 * "sample", "normal" or "unknown" (the read failed). While it is unknown the screens keep their priced controls hidden,
 * as the server refuses a paid job it cannot clear, but they do not call the workspace the sample: this store re-reads
 * on its own after 2 s, 5 s and 15 s, then stops until `retry` (the person's free Try again).
 */

/** The answer for a scope: null while the first read is out, then what the last read said, and how many reads have failed in a row. */
export type CheckSlot = { state: SampleCheck | null; failures: number; at: number };

const KEPT_MS = 15_000;
const EMPTY: CheckSlot = { state: null, failures: 0, at: 0 };

type Env = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  delays: readonly number[];
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

export function createSampleChecker(env: Env) {
  const slots = new Map<string, CheckSlot>();
  const reading = new Map<string, Promise<void>>();
  const timers = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const keyOf = (scope: string | null) => scope ?? "";
  const put = (key: string, slot: CheckSlot) => { slots.set(key, slot); emit(); };

  function read(scope: string | null): Promise<void> {
    const key = keyOf(scope);
    const open = reading.get(key);
    if (open) return open;
    const clock = timers.get(key);
    if (clock !== undefined) { env.clearTimer(clock); timers.delete(key); }
    const work = (async () => {
      let answer: SampleCheck;
      try {
        const res = await env.fetch("/api/demo/sample", { cache: "no-store", ...(scope != null ? { headers: { "X-Workbench-Scope": scope } } : {}) });
        const body = res.ok ? await res.json().catch(() => null) : null;
        answer = sampleWorkspaceAnswer({ ok: res.ok, body });
      } catch {
        answer = sampleWorkspaceAnswer(null);
      }
      const before = slots.get(key) ?? EMPTY;
      const failures = answer === "unknown" ? before.failures + 1 : 0;
      put(key, { state: answer, failures, at: env.now() });
      /* A failed read is read again, a little later each time, and then left for the person. */
      if (answer === "unknown" && failures <= env.delays.length) {
        timers.set(key, env.setTimer(() => { timers.delete(key); void read(scope); }, env.delays[failures - 1]));
      }
    })().finally(() => { reading.delete(key); });
    reading.set(key, work);
    return work;
  }

  const api = {
    /** The slot for a scope, the same object until it changes (a stable snapshot). */
    get(scope: string | null): CheckSlot { return slots.get(keyOf(scope)) ?? EMPTY; },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Reads when there is no answer, or a good one that has gone stale; a failed one is already being retried. */
    ensure(scope: string | null): Promise<void> {
      const key = keyOf(scope);
      const slot = slots.get(key);
      if (!slot || slot.state === null) return read(scope);
      const stale = env.now() - slot.at >= KEPT_MS;
      if (slot.state === "unknown") {
        /* Waiting on its next automatic read: leave it. Out of automatic reads: a screen that mounts later starts them over. */
        if (timers.has(key) || reading.has(key)) return Promise.resolve();
        return stale ? api.retry(scope) : Promise.resolve();
      }
      return stale ? read(scope) : Promise.resolve();
    },
    /** The person's Try again: read now, with the automatic waits starting over. */
    retry(scope: string | null): Promise<void> {
      const key = keyOf(scope);
      const slot = slots.get(key);
      if (slot) slots.set(key, { ...slot, failures: 0 });
      return read(scope);
    },
  };
  return api;
}

export const sampleChecker = createSampleChecker({
  fetch: (url, init) => fetch(url, init),
  delays: CHECK_BACKOFF_MS,
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
