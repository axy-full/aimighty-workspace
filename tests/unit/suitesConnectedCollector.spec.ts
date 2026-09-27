import { test, expect } from "@playwright/test";
import { COLLECT_PACE, COLLECT_POLL_MS, COLLECT_UNSETTLED_POLLS, ConnectedCollector } from "../../lib/shell/connected-collector";
import { settledToast } from "../../lib/shell/use-connected-collector";
import type { ConnectedJob } from "../../lib/higgsfield-consumer/generation-client";

/* Never a paid call: every request here is a GET listing or a `status` read, answered by a fake. */
const DRAFT = "draft-1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (n: number, status: ConnectedJob["status"], over: Record<string, unknown> = {}) => ({
  id: uuid(n), draftId: DRAFT, status, workspaceId: uuid(900), workspaceName: "Wallet", creditUnit: "higgsfield_credits", quoteCredits: 12,
  providerJobId: status === "quoted" ? null : uuid(500 + n), quoteExpiresAt: 1, createdAt: 1,
  model: { id: "kling_3_0", name: "Kling 3.0", outputType: "video" },
  input: { type: "video", model: "kling_3_0", prompt: "a fox", parameters: {}, medias: [] }, ...over,
});

/** An answer that names its own pollAfterSeconds (every other good answer asks for 15). */
const hinted = (answer: unknown, hint: number) => ({ hinted: answer, hint });

/** `random`: the jitter's draws (0.5 is none: every wait is its pace exactly). */
function harness(listing: unknown[], answers: Record<string, (unknown)[]>, random: () => number = () => 0.5) {
  let clock = 1_000;
  const start = clock;
  const timers: { at: number; fn: () => void }[] = [];
  const calls: { method: string; body?: { action: string; id: string }; at: number }[] = [];
  const settled: ConnectedJob[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const collector = new ConnectedCollector({
    now: () => clock,
    random,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as (typeof timers)[number]); if (i >= 0) timers.splice(i, 1); },
    onSettled: (j) => settled.push(j),
    fetch: async (url, init = {}) => {
      if (!init.method) {
        calls.push({ method: "GET", at: clock });
        expect(url).toBe(`/api/higgsfield/consumer/generation?draftId=${DRAFT}`);
        return reply(200, { jobs: listing });
      }
      const body = JSON.parse(String(init.body)) as { action: string; draftId: string; id: string };
      calls.push({ method: "POST", body, at: clock });
      expect(body).toEqual({ action: "status", draftId: DRAFT, id: body.id });
      const queue = answers[body.id];
      const next = queue?.length ? queue.shift() : null;
      if (next === 403) return reply(403, { error: "Owner only." });
      if (next && typeof next === "object" && "hinted" in next) { const { hinted: answer, hint } = next as ReturnType<typeof hinted>; return reply(200, { job: answer, pollAfterSeconds: hint }); }
      return next ? reply(200, { job: next, pollAfterSeconds: 15 }) : reply(503, { error: "busy" });
    },
  });
  /* Run every timer that is due by `ms` from now, in order. */
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > clock) break;
      timers.shift();
      due.fn();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  /* Run the clock exactly to the next timer, and say when that is (seconds from the start). */
  const next = async () => {
    timers.sort((a, b) => a.at - b.at);
    if (timers.length) await advance(timers[0].at - clock);
    return (clock - start) / 1000;
  };
  /** When each status read went out, in seconds from the start. */
  const readAt = (id?: string) => calls.filter((c) => c.method === "POST" && (!id || c.body?.id === id)).map((c) => (c.at - start) / 1000);
  return { collector, calls, settled, advance, next, readAt };
}

test("a job submitted from a view that has gone is read until it lands, then announced once", async () => {
  const running = job(1, "accepted");
  const { collector, calls, settled, advance } = harness(
    [job(1, "accepted"), job(2, "quoted"), job(3, "completed"), job(4, "failed")],
    { [uuid(1)]: [running, job(1, "completed")] },
  );
  await collector.list(DRAFT);
  /* Only the submitted, unsettled job is followed: a quote was never paid for, a settled job is done. */
  expect(collector.tracking()).toEqual([uuid(1)]);
  await advance(0);
  expect(settled).toHaveLength(0);
  await advance(COLLECT_POLL_MS - 1);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  await advance(1);
  expect(settled.map((j) => j.status)).toEqual(["completed"]);
  expect(collector.tracking()).toEqual([]);
  await advance(10 * COLLECT_POLL_MS);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  expect(calls.every((c) => c.method === "GET" || c.body?.action === "status")).toBe(true);
});

test("a view polling its own job keeps it; when the view lets go mid-render the collector follows it", async () => {
  const { collector, calls, settled, advance } = harness([job(1, "accepted")], { [uuid(1)]: [job(1, "completed")] });
  collector.watch(uuid(1));
  await collector.list(DRAFT);
  expect(collector.tracking()).toEqual([]);
  collector.release(DRAFT, { id: uuid(1), status: "accepted" });
  await advance(0);
  expect(settled.map((j) => j.id)).toEqual([uuid(1)]);
  /* A view that settled its job itself only lets go: nothing is read or announced twice. */
  collector.watch(uuid(2));
  collector.release(DRAFT, { id: uuid(2), status: "completed" });
  await advance(COLLECT_POLL_MS * 3);
  expect(calls.filter((c) => c.method === "POST").map((c) => c.body!.id)).toEqual([uuid(1)]);
});

test("a job the account never accepts is left after a few reads; a 403 stops the collector for good", async () => {
  const stuck = Array.from({ length: 20 }, () => job(5, "uncertain"));
  const { collector, calls, advance } = harness([job(5, "uncertain")], { [uuid(5)]: stuck });
  await collector.list(DRAFT);
  await advance(0);
  /* Its reads grow further apart (20, 30, 45 s, then a minute): a minute a step reaches every one. */
  for (let i = 0; i < COLLECT_UNSETTLED_POLLS + 3; i++) await advance(COLLECT_PACE.capMs);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(COLLECT_UNSETTLED_POLLS);
  expect(collector.tracking()).toEqual([]);

  const denied = harness([job(6, "accepted")], { [uuid(6)]: [403] });
  await denied.collector.list(DRAFT);
  await denied.advance(0);
  expect(denied.collector.tracking()).toEqual([]);
  await denied.collector.list(DRAFT);
  denied.collector.adopt(DRAFT, uuid(7));
  expect(denied.collector.tracking()).toEqual([]);
  expect(denied.calls.filter((c) => c.method === "GET")).toHaveLength(1);
});

test("a job handed over mid-submit that still reads quoted is kept, and followed once the submit lands", async () => {
  /* The view unmounted while its submit was out: the server has not taken it yet on the first read. */
  const { collector, calls, settled, advance } = harness([], { [uuid(8)]: [job(8, "quoted"), job(8, "accepted"), job(8, "completed")] });
  collector.watch(uuid(8));
  collector.release(DRAFT, { id: uuid(8), status: "dispatching" });
  await advance(0);
  expect(collector.tracking()).toEqual([uuid(8)]);
  await advance(COLLECT_POLL_MS);
  await advance(COLLECT_POLL_MS);
  expect(settled.map((j) => j.id)).toEqual([uuid(8)]);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  /* A submit that never reached the server is left after a few reads. */
  const never = harness([], { [uuid(9)]: Array.from({ length: 20 }, () => job(9, "quoted")) });
  never.collector.release(DRAFT, { id: uuid(9), status: "dispatching" });
  await never.advance(0);
  for (let i = 0; i < COLLECT_UNSETTLED_POLLS + 3; i++) await never.advance(COLLECT_PACE.capMs);
  expect(never.calls.filter((c) => c.method === "POST")).toHaveLength(COLLECT_UNSETTLED_POLLS);
  expect(never.collector.tracking()).toEqual([]);
  /* A quote the listing finds was never submitted: it is not followed. */
  const listed = harness([job(10, "quoted")], {});
  await listed.collector.list(DRAFT);
  expect(listed.collector.tracking()).toEqual([]);
});

test("the strip's job is its composer's: not read while in flight, forgotten without a toast once it settles there", async () => {
  const { collector, calls, settled, advance } = harness([job(11, "accepted")], { [uuid(11)]: [job(11, "completed")] });
  collector.show(uuid(11), false);
  await collector.list(DRAFT);
  await advance(COLLECT_POLL_MS * 3);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  /* The composer settles it and says so: the collector drops it, no second read, no second toast. */
  collector.show(uuid(11), true);
  expect(collector.tracking()).toEqual([]);
  await advance(COLLECT_POLL_MS * 3);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  expect(settled).toHaveLength(0);

  /* The strip moves on while the job is still in flight (Gen closed mid-render): the collector reads it. */
  const left = harness([job(12, "accepted")], { [uuid(12)]: [job(12, "completed")] });
  left.collector.show(uuid(12), false);
  await left.collector.list(DRAFT);
  await left.advance(COLLECT_POLL_MS);
  expect(left.settled).toHaveLength(0);
  left.collector.show(null, false);
  await left.advance(0);
  expect(left.settled.map((j) => j.id)).toEqual([uuid(12)]);
});

test("the pace: 1.5x further apart while nothing moves, up to a minute; a changed status starts it over; failures wait a minute, then twice as long", async () => {
  const uncertain = job(20, "uncertain", { providerReceipt: { response: "submitted" } }), accepted = job(20, "accepted");
  const { collector, next, readAt } = harness([uncertain], {
    [uuid(20)]: [uncertain, uncertain, accepted, accepted, accepted, accepted, accepted, null, null, accepted, accepted],
  });
  await collector.list(DRAFT);
  for (let i = 0; i < 11; i++) await next();
  /* Confirming: at once, then 20 s, 30 s. Accepted (moved on): 20 s again, then 30, 45, 60, 60. Two failed reads: a minute,
     then two. A good read ends the doubling and the pace goes on where it was (a minute). */
  expect(readAt()).toEqual([0, 20, 50, 70, 100, 145, 205, 265, 325, 445, 505]);
});

test("jitter spreads the waits ±20%: two jobs asked in the same round are next asked apart", async () => {
  const draws = [0, 0.999999];
  const { collector, next, readAt } = harness(
    [job(21, "accepted"), job(22, "accepted")],
    { [uuid(21)]: [job(21, "accepted"), job(21, "accepted")], [uuid(22)]: [job(22, "accepted"), job(22, "accepted")] },
    () => draws.shift() ?? 0.5,
  );
  await collector.list(DRAFT);
  await next();
  expect(readAt()).toEqual([0, 0]);
  /* The same 20 s, drawn low for one (16 s) and high for the other (24 s). */
  await next();
  await next();
  expect(readAt(uuid(21))).toEqual([0, 16]);
  expect(readAt(uuid(22))).toEqual([0, 24]);
});

test("a listing — the person opening a page of the project, or coming back — starts a followed job's pace over from its last read, never inside the account's window", async () => {
  const accepted = job(23, "accepted");
  const { collector, advance, next, readAt } = harness([accepted], {
    [uuid(23)]: [accepted, accepted, accepted, hinted(accepted, 40), accepted, accepted, accepted],
  });
  await collector.list(DRAFT);
  for (let i = 0; i < 3; i++) await next();
  expect(readAt()).toEqual([0, 20, 50]);
  /* Due at 95 s. The page is opened again at 60 s: 20 s after the last read, so 70 s. */
  await advance(10_000);
  await collector.list(DRAFT);
  await next();
  expect(readAt()).toEqual([0, 20, 50, 70]);
  /* That read's reply asked for 40 s. Opened again 5 s later: never before the 40 s (and a half) is up. */
  await advance(5000);
  await collector.list(DRAFT);
  await next();
  expect(readAt().at(-1)).toBeGreaterThanOrEqual(70 + 40.5);
  expect(readAt().at(-1)).toBeLessThanOrEqual(70 + 40.5 * 1.2);
});

test("a listing never holds a read back past the one already planned", async () => {
  let draw = 0;
  const accepted = job(25, "accepted");
  const { collector, advance, next, readAt } = harness([accepted], { [uuid(25)]: [accepted, accepted] }, () => draw);
  await collector.list(DRAFT);
  await next();
  /* Planned 16 s out (drawn low). A listing 5 s later draws high (24 s): the read stays at 16 s. */
  draw = 0.999999;
  await advance(5000);
  await collector.list(DRAFT);
  await next();
  expect(readAt()).toEqual([0, 16]);
});

test("a job a view lets go of is first read one pace after the view's own last read, never inside the account's window", async () => {
  const accepted = job(24, "accepted");
  const { collector, advance, readAt } = harness([], { [uuid(24)]: [accepted, job(24, "completed")] });
  collector.watch(uuid(24));
  /* The view read it at 0 s and the account asked for 30 s; the view goes 4 s later. */
  await advance(4000);
  collector.release(DRAFT, { id: uuid(24), status: "accepted" }, { at: 1000, hintSeconds: 30 });
  await advance(0);
  expect(readAt()).toEqual([]);
  /* 30 s and a half, spread upward only (no jitter drawn here: +10%). */
  await advance(33_550 - 4000 - 1);
  expect(readAt()).toEqual([]);
  await advance(1);
  expect(readAt()).toEqual([33.55]);
});

test("the toast says where a finished render went, and that a failed one was not billed", () => {
  const done = { ...job(1, "completed"), originalAvailable: true, originalAvailability: "available" } as unknown as ConnectedJob;
  expect(settledToast(done)).toBe("Kling 3.0 finished on the connected account.");
  expect(settledToast({ ...job(1, "failed") } as unknown as ConnectedJob)).toBe("Kling 3.0 failed on the connected account. Failed renders are not billed.");
});
