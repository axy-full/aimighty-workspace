import { test, expect } from "@playwright/test";
import { POLL, poll, pollAfter, pollDelay, retryDelay, turnHint, type PollClock, type PollPresence } from "../../lib/poll";
import { settledState } from "../../lib/shell/use-connected-job";
import { activeMediaJob } from "../../lib/workbench/job-recovery";
import type { ConnectedJob } from "../../lib/higgsfield-consumer/generation-client";

/**
 * lib/poll: every status read in the app (Gen's takes, connected jobs, Ads,
 * Image ads, Motion Transfer, a re-edit) waits 2 s, then 1.5× longer each
 * time up to 10 s, or the server's own pollAfterSeconds when that is longer;
 * ±20% jitter; a failed read backs off; nothing is asked while the tab is
 * hidden; one read at a time; it stops on the terminal set.
 */
const MID = () => 0.5; // no jitter

/** A hand-driven clock: timers run only when the spec moves time on. */
function fakeClock(random = MID) {
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: PollClock = {
    setTimeout: (run, ms) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    random,
  };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].run();
      await flush();
    }
    now = until;
    await flush();
  }
  return { clock, advance, flush, now: () => now, pending: () => timers.size };
}
function fakePresence(away = false) {
  const listeners = new Set<() => void>();
  const presence: PollPresence = { away: () => away, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  return { presence, set(value: boolean) { away = value; for (const fn of listeners) fn(); }, listeners: () => listeners.size };
}

test("the pace: 2 s, then 1.5x each read, capped at 10 s", () => {
  expect([0, 1, 2, 3, 4, 5, 20].map((reads) => pollDelay(reads, { random: MID }))).toEqual([2000, 3000, 4500, 6750, 10_000, 10_000, 10_000]);
  expect(POLL.startMs).toBe(2000);
  expect(POLL.capMs).toBe(10_000);
});

test("the server's own pollAfterSeconds holds the next read back when it is longer, bounded to a minute", () => {
  expect(pollDelay(0, { hintSeconds: 15, random: MID })).toBe(15_000);
  expect(pollDelay(0, { hintSeconds: 30, random: MID })).toBe(30_000);
  /* A shorter hint never makes the page ask faster than its own pace. */
  expect(pollDelay(4, { hintSeconds: 3, random: MID })).toBe(10_000);
  expect(pollDelay(0, { hintSeconds: 900, random: MID })).toBe(60_000);
  for (const junk of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(pollDelay(0, { hintSeconds: junk, random: MID })).toBe(2000);
  expect(pollAfter({ job: {}, pollAfterSeconds: 15 })).toBe(15);
  expect(pollAfter({ job: {} })).toBeNull();
  expect(pollAfter({ pollAfterSeconds: "15" })).toBeNull();
  expect(pollAfter(null)).toBeNull();
});

test("jitter stays within ±20% at every step, and moves the wait", () => {
  for (let reads = 0; reads < 12; reads++) {
    const base = pollDelay(reads, { random: MID });
    for (const r of [0, 0.1, 0.37, 0.5, 0.81, 0.999]) {
      const wait = pollDelay(reads, { random: () => r });
      expect(wait).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(wait).toBeLessThanOrEqual(Math.ceil(base * 1.2));
    }
  }
  expect(pollDelay(0, { random: () => 0 })).toBe(1600);
  expect(pollDelay(0, { random: () => 0.999999 })).toBe(2400);
  const spread = new Set(Array.from({ length: 50 }, () => pollDelay(3)));
  expect(spread.size).toBeGreaterThan(5);
});

test("failed reads back off, doubling up to a minute", () => {
  expect(pollDelay(1, { misses: 1, random: MID })).toBe(6000);
  expect(pollDelay(2, { misses: 2, random: MID })).toBe(18_000);
  expect(pollDelay(3, { misses: 3, random: MID })).toBe(54_000);
  expect(pollDelay(9, { misses: 9, random: MID })).toBe(60_000);
  /* A one-off read (a list, a catalogue): about 2 s, 6 s, 18 s, then only Try again. */
  expect([1, 2, 3, 4].map((n) => retryDelay(n, { random: MID }))).toEqual([2000, 6000, 18_000, null]);
  expect(retryDelay(0, { random: MID })).toBeNull();
  expect(retryDelay(Number.NaN, { random: MID })).toBeNull();
  expect(retryDelay(2, { tries: 1, random: MID })).toBeNull();
});

test("reads in turn share the server's pace out across the jobs", () => {
  expect(turnHint(15, 3)).toBe(5);
  expect(turnHint(15, 0)).toBe(15);
  expect(turnHint(null, 3)).toBeNull();
  expect(turnHint(-1, 3)).toBeNull();
});

test("a poll waits its pace between reads and stops on the terminal set", async () => {
  const time = fakeClock();
  const reads: number[] = [];
  const seen: string[] = [];
  const replies = ["queued", "running", "running", "running", "running", "running", "succeeded"];
  const poller = poll({
    clock: time.clock, presence: null,
    read: async () => { reads.push(time.now()); return { status: replies[reads.length - 1] }; },
    done: (job) => !activeMediaJob(job),
    onValue: (job) => seen.push(job.status),
  });
  await time.advance(1999);
  expect(reads).toEqual([]);
  await time.advance(1);
  expect(reads).toEqual([2000]);
  await time.advance(120_000);
  /* 2 s, 3 s, 4.5 s, 6.75 s, 10 s, 10 s, 10 s — then succeeded ends it. */
  expect(reads).toEqual([2000, 5000, 9500, 16_250, 26_250, 36_250, 46_250]);
  expect(seen.at(-1)).toBe("succeeded");
  expect(time.pending()).toBe(0);
  await time.advance(600_000);
  expect(reads).toHaveLength(7);
  poller.stop();
});

test("the full terminal set ends a take's poll: succeeded, failed, cancelled; held and queued keep asking", () => {
  for (const status of ["succeeded", "failed", "cancelled"]) expect(activeMediaJob({ status })).toBe(false);
  for (const status of ["queued", "running", "held"]) expect(activeMediaJob({ status })).toBe(true);
});

test("the server's hint sets the next wait", async () => {
  const time = fakeClock();
  const reads: number[] = [];
  const poller = poll({
    clock: time.clock, presence: null,
    read: async () => { reads.push(time.now()); return { pollAfterSeconds: 15 }; },
    hint: (reply) => reply.pollAfterSeconds, done: () => false, onValue: () => undefined,
  });
  await time.advance(40_000);
  expect(reads).toEqual([2000, 17_000, 32_000]);
  poller.stop();
  expect(time.pending()).toBe(0);
});

test("errors back off instead of looping, a good read resets the pace, and a hopeless error stops", async () => {
  const time = fakeClock();
  const reads: number[] = [];
  const misses: number[] = [];
  let failing = 4;
  const poller = poll({
    clock: time.clock, presence: null,
    read: async () => { reads.push(time.now()); if (failing-- > 0) throw Object.assign(new Error("503"), { status: 503 }); return "ok"; },
    done: () => false, onValue: () => undefined,
    onError: (_error, n) => { misses.push(n); },
  });
  await time.advance(2000 + 6000 + 18_000 + 54_000 + 60_000 + 10_000);
  expect(reads).toEqual([2000, 8000, 26_000, 80_000, 140_000, 150_000]);
  expect(misses).toEqual([1, 2, 3, 4]);
  poller.stop();

  const gone = fakeClock();
  let asked = 0;
  poll({
    clock: gone.clock, presence: null,
    read: async () => { asked++; throw Object.assign(new Error("Not found"), { status: 404 }); },
    done: () => false, onValue: () => undefined,
    onError: (error) => ((error as { status?: number }).status === 404 ? "stop" : undefined),
  });
  await gone.advance(600_000);
  expect(asked).toBe(1);
  expect(gone.pending()).toBe(0);

  /* A reply the caller cannot parse counts once, as a miss. */
  const bad = fakeClock();
  const badReads: number[] = [];
  const stopBad = poll({
    clock: bad.clock, presence: null,
    read: async () => { badReads.push(bad.now()); return "garbled"; },
    done: () => false, onValue: () => { throw new Error("unparseable"); },
  });
  await bad.advance(8000);
  expect(badReads).toEqual([2000, 8000]);
  stopBad.stop();
});

test("nothing is asked while the tab is hidden; the read that fell due is made when it is back", async () => {
  const time = fakeClock();
  const page = fakePresence();
  const reads: number[] = [];
  const poller = poll({ clock: time.clock, presence: page.presence, read: async () => { reads.push(time.now()); return 1; }, done: () => false, onValue: () => undefined });
  await time.advance(2000);
  expect(reads).toEqual([2000]);
  page.set(true);
  await time.advance(10 * 60_000);
  expect(reads).toEqual([2000]);
  expect(time.pending()).toBe(0);
  page.set(false);
  await time.flush();
  expect(reads).toEqual([2000, 602_000]);
  /* And the pace carries on from there. */
  await time.advance(4500);
  expect(reads).toEqual([2000, 602_000, 606_500]);
  poller.stop();
  expect(page.listeners()).toBe(0);

  /* Hidden from the start, even when asked to read at once. */
  const later = fakeClock();
  const away = fakePresence(true);
  let asked = 0;
  poll({ clock: later.clock, presence: away.presence, immediate: true, read: async () => { asked++; return 1; }, done: () => true, onValue: () => undefined });
  await later.advance(60_000);
  expect(asked).toBe(0);
  away.set(false);
  await later.flush();
  expect(asked).toBe(1);
  expect(away.listeners()).toBe(0);
});

test("one read at a time: a slow reply never has a second read queued behind it; stop aborts it and ignores its reply", async () => {
  const time = fakeClock();
  let release: (value: string) => void = () => undefined;
  const got: { signal?: AbortSignal } = {};
  let asked = 0;
  const seen: string[] = [];
  const poller = poll({
    clock: time.clock, presence: null, immediate: true,
    read: (s) => { asked++; got.signal = s; return new Promise<string>((resolve) => { release = resolve; }); },
    done: () => false, onValue: (value) => seen.push(value),
  });
  expect(asked).toBe(1);
  await time.advance(120_000);
  poller.now();
  expect(asked).toBe(1);
  release("late but good");
  await time.flush();
  expect(seen).toEqual(["late but good"]);
  await time.advance(3000);
  expect(asked).toBe(2);
  poller.stop();
  expect(got.signal?.aborted).toBe(true);
  release("after stop");
  await time.flush();
  expect(seen).toEqual(["late but good"]);
  await time.advance(600_000);
  expect(asked).toBe(2);
});

test("now() reads at once (a Try again) and the pace continues from it", async () => {
  const time = fakeClock();
  const reads: number[] = [];
  const poller = poll({ clock: time.clock, presence: null, read: async () => { reads.push(time.now()); return 1; }, done: () => false, onValue: () => undefined });
  await time.advance(500);
  poller.now();
  await time.flush();
  expect(reads).toEqual([500]);
  await time.advance(3000);
  expect(reads).toEqual([500, 3500]);
  poller.stop();
});

test("a good status read clears the problem a failed one put on a running connected job", () => {
  const job = { id: "9d2b3c4e-5f60-4a7b-8c9d-000000000001", status: "accepted" } as ConnectedJob;
  expect(settledState(job)).toEqual({ phase: "running", job });
  expect("problem" in settledState(job)).toBe(false);
});
