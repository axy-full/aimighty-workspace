import { test, expect } from "@playwright/test";
import { COLLECT_POLL_MS, COLLECT_UNSETTLED_POLLS, ConnectedCollector } from "../../lib/shell/connected-collector";
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

function harness(listing: unknown[], answers: Record<string, (unknown)[]>) {
  let clock = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const calls: { method: string; body?: { action: string; id: string } }[] = [];
  const settled: ConnectedJob[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const collector = new ConnectedCollector({
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as (typeof timers)[number]); if (i >= 0) timers.splice(i, 1); },
    onSettled: (j) => settled.push(j),
    fetch: async (url, init = {}) => {
      if (!init.method) {
        calls.push({ method: "GET" });
        expect(url).toBe(`/api/higgsfield/consumer/generation?draftId=${DRAFT}`);
        return reply(200, { jobs: listing });
      }
      const body = JSON.parse(String(init.body)) as { action: string; draftId: string; id: string };
      calls.push({ method: "POST", body });
      expect(body).toEqual({ action: "status", draftId: DRAFT, id: body.id });
      const queue = answers[body.id];
      const next = queue?.length ? queue.shift() : null;
      if (next === 403) return reply(403, { error: "Owner only." });
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
  return { collector, calls, settled, advance };
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
  for (let i = 0; i < COLLECT_UNSETTLED_POLLS + 3; i++) await advance(COLLECT_POLL_MS);
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
  for (let i = 0; i < COLLECT_UNSETTLED_POLLS + 3; i++) await never.advance(COLLECT_POLL_MS);
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

test("the toast says where a finished render went, and that a failed one was not billed", () => {
  const done = { ...job(1, "completed"), originalAvailable: true, originalAvailability: "available" } as unknown as ConnectedJob;
  expect(settledToast(done)).toBe("Kling 3.0 finished on the connected account.");
  expect(settledToast({ ...job(1, "failed") } as unknown as ConnectedJob)).toBe("Kling 3.0 failed on the connected account. Failed renders are not billed.");
});
