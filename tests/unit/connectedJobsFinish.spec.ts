import { test, expect } from "@playwright/test";
import { canProgress, isOpen, resumeAge, resumeGivesUp, resumeLine, resumePhase, resumeProblem, shortName } from "../../lib/higgsfield-consumer/resume";
import { COLLECT_BACKOFF_MS, COLLECT_POLL_MS, COLLECT_UNSETTLED_POLLS, ConnectedCollector } from "../../lib/shell/connected-collector";
import type { ConnectedJob } from "../../lib/higgsfield-consumer/generation-client";

/**
 * A page opened after its connected-account jobs were left running picks them
 * back up. The shell's collector is the one reader: it lists what is still
 * open, reads each sent job (never a quote, never a submit) and says what it
 * knows; the pages show it, with no invented progress and no card that asks
 * forever.
 */
const RECEIPT = { response: "submitted" };

test("every open job is listed; a read can move one that is rendering, or unconfirmed with a receipt", () => {
  const jobs = [
    { id: "a", status: "quoted" }, { id: "b", status: "accepted" }, { id: "c", status: "uncertain", providerReceipt: RECEIPT },
    { id: "d", status: "completed" }, { id: "e", status: "dispatching" }, { id: "f", status: "failed" }, { id: "g", status: "uncertain" },
  ];
  expect(jobs.filter((j) => isOpen(j.status)).map((j) => j.id)).toEqual(["b", "c", "e", "g"]);
  expect(jobs.filter(canProgress).map((j) => j.id)).toEqual(["b", "c"]);
});

test("each state has one short label; a job nobody is asking after says why instead of claiming to render", () => {
  const at = (status: string, extra: Record<string, unknown> = {}) => ({ status, createdAt: 0, ...extra });
  expect(resumePhase(at("accepted"))).toEqual({ label: "Rendering", tone: "blue" });
  expect(resumePhase(at("uncertain", { providerReceipt: RECEIPT }))).toEqual({ label: "Confirming", tone: "amber" });
  expect(resumePhase(at("uncertain"))).toEqual({ label: "Not confirmed · never sent twice", tone: "amber" });
  expect(resumePhase(at("dispatching"))).toEqual({ label: "Not confirmed · never sent twice", tone: "amber" });
  expect(resumePhase(at("uncertain", { setAside: true }))).toEqual({ label: "Set aside · never sent again", tone: "amber" });
  // Still being read, or stopped after a read that could not move it, or an error that would repeat.
  expect(resumePhase(at("dispatching"), true)).toEqual({ label: "Confirming", tone: "amber" });
  expect(resumePhase(at("uncertain", { providerReceipt: RECEIPT }), false).label).toBe("Not confirmed · never sent twice");
  expect(resumePhase(at("accepted"), false)).toEqual({ label: "Can't be checked", tone: "amber" });
  expect(resumePhase(at("completed")).label).toBe("Complete");
  expect(resumePhase(at("failed")).label).toBe("Failed · not billed");
  expect(resumePhase(at("failed", { failureCode: "invalid_result" })).label).toBe("Not kept · receipt saved");
  // No percentages: the account reports none, so none is drawn.
  expect(Object.keys(resumePhase(at("accepted")))).toEqual(["label", "tone"]);
  // The age rides along only while it is still followed.
  expect(resumeLine(at("accepted"), 12 * 60_000)).toBe("Rendering · 12 min");
  expect(resumeLine(at("uncertain", { providerReceipt: RECEIPT }), 3 * 3_600_000)).toBe("Confirming · 3 h");
  expect(resumeLine(at("uncertain"), 27 * 3_600_000)).toBe("Not confirmed · never sent twice");
  expect(resumeLine(at("accepted"), 3 * 86_400_000, false)).toBe("Can't be checked");
  expect([0, 59_000, 4 * 60_000, 3 * 3_600_000, 5 * 86_400_000].map((ms) => resumeAge(0, ms))).toEqual(["just now", "just now", "4 min", "3 h", "5 d"]);
  expect(resumeAge(10_000, 0)).toBe("just now");
});

test("names are cut on a word with an ellipsis, never mid-word", () => {
  const prompt = "A slow dolly push across the wet harbour at blue hour, lanterns swaying over the moored boats";
  expect(shortName(prompt, 60)).toBe("A slow dolly push across the wet harbour at blue hour…");
  expect(shortName("  Short   and\nplain ", 60)).toBe("Short and plain");
  expect(shortName("x".repeat(90), 60)).toBe(`${"x".repeat(59)}…`);
  expect(shortName("", 60)).toBe("");
  expect(shortName(prompt, 80).length).toBeLessThanOrEqual(80);
});

test("a failed read is said in the product's words; one that would repeat for this job stops the asking", () => {
  const err = (code?: string, status?: number, message = "x") => Object.assign(new Error(message), { code, status });
  expect(resumeProblem(err("reconnect_required", 401))).toBe("Reconnect the account in Workspace › Engines to finish this take.");
  expect(resumeProblem(err("connection_changed", 409))).toBe("Started on an earlier account connection, so it can't be checked from here.");
  expect(resumeProblem(err("original_quota", 507))).toBe("Workspace storage is full. Make room to collect this take.");
  expect(resumeProblem(err(undefined, 404))).toBe("This job can no longer be checked from here.");
  expect(resumeProblem(err(undefined, 429, "Too many requests. Try again shortly."))).toBe("Too many requests. Try again shortly.");
  expect(resumeProblem(err(undefined, 503, "x".repeat(300)))).toBe("The account could not be reached. Trying again.");
  expect(resumeProblem("not an error")).toBe("The account could not be reached. Trying again.");
  expect(resumeProblem(null)).toBe("The account could not be reached. Trying again.");
  // The collector passes the reply's own fields and message.
  expect(resumeProblem({ status: 429 }, "Too many requests. Try again shortly.")).toBe("Too many requests. Try again shortly.");
  expect([err("connection_changed", 409), err(undefined, 404), err(undefined, 403), { status: 409, code: "connection_changed" }].every(resumeGivesUp)).toBe(true);
  expect([err("reconnect_required", 401), err("original_quota", 507), err(undefined, 429), err(undefined, 503), new Error("offline")].some(resumeGivesUp)).toBe(false);
});

/* ── The shell's collector: the one reader, and what the pages show ───────── */
const DRAFT = "draft-1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (n: number, status: ConnectedJob["status"], over: Record<string, unknown> = {}) => ({
  id: uuid(n), draftId: DRAFT, status, workspaceId: uuid(900), workspaceName: "Wallet", creditUnit: "higgsfield_credits", quoteCredits: 12,
  providerJobId: status === "quoted" ? null : uuid(500 + n), quoteExpiresAt: 1, createdAt: n,
  model: { id: "kling_3_0", name: "Kling 3.0", outputType: "video" }, composer: "gen",
  input: { type: "video", model: "kling_3_0", prompt: `take ${n}`, parameters: {}, medias: [] }, ...over,
});
type Answer = { status: number; body: unknown } | "hang";

function harness(listing: () => unknown[], answers: Record<string, Answer[]>) {
  let clock = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const reads: string[] = [];
  let lists = 0, changes = 0;
  const settled: ConnectedJob[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const collector = new ConnectedCollector({
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as (typeof timers)[number]); if (i >= 0) timers.splice(i, 1); },
    onSettled: (j) => settled.push(j),
    onChange: () => { changes++; },
    fetch: async (url, init = {}) => {
      if (!init.method) { lists++; return reply(200, { jobs: listing() }); }
      const body = JSON.parse(String(init.body)) as { action: string; draftId: string; id: string };
      expect(body).toEqual({ action: "status", draftId: DRAFT, id: body.id });
      reads.push(body.id);
      const next = answers[body.id]?.shift();
      if (next === "hang") return new Promise<Response>(() => {});
      return next ? reply(next.status, next.body) : reply(503, { error: "busy" });
    },
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > clock) break;
      timers.shift();
      due.fn();
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    }
  };
  const shown = () => Object.fromEntries(collector.collected(DRAFT).map((c) => [c.job.id, { status: c.job.status, following: c.following, problem: c.problem }]));
  return { collector, reads, settled, advance, shown, lists: () => lists, changes: () => changes };
}
const ok = (body: unknown, pollAfterSeconds = 15) => ({ status: 200, body: { job: body, pollAfterSeconds } });

test("the pages show what the collector reads: every job seen in flight, its latest state, and a passing failure in plain words", async () => {
  const { collector, reads, settled, advance, shown, changes } = harness(
    () => [job(1, "accepted"), job(2, "uncertain", { providerReceipt: RECEIPT }), job(3, "quoted"), job(4, "completed")],
    {
      [uuid(1)]: [ok(job(1, "accepted")), ok(job(1, "completed"))],
      [uuid(2)]: [{ status: 429, body: { error: "Too many requests. Try again shortly." } }, ok(job(2, "failed"))],
    },
  );
  await collector.list(DRAFT);
  /* Only jobs that were sent and have not settled: a priced one was never sent, a settled one is history. */
  expect(Object.keys(shown())).toEqual([uuid(1), uuid(2)]);
  expect(shown()[uuid(1)]).toEqual({ status: "accepted", following: true, problem: null });
  /* The same array until something changes, so a page re-renders only on news. */
  expect(collector.collected(DRAFT)).toBe(collector.collected(DRAFT));
  const before = changes();
  await advance(0);
  expect(changes()).toBeGreaterThan(before);
  /* In fixed words (checkingProblem), never the route's own text. */
  expect(shown()[uuid(2)]).toEqual({ status: "uncertain", following: true, problem: "Could not check this take. Checking again shortly." });
  await advance(COLLECT_POLL_MS);
  /* Settled: announced once by the collector, still shown with its outcome, no longer followed. */
  expect(settled.map((j) => j.status)).toEqual(["completed"]);
  expect(shown()[uuid(1)]).toEqual({ status: "completed", following: false, problem: null });
  await advance(COLLECT_BACKOFF_MS);
  expect(shown()[uuid(2)]).toEqual({ status: "failed", following: false, problem: null });
  expect(settled.map((j) => j.status)).toEqual(["completed", "failed"]);
  expect(reads).toEqual([uuid(1), uuid(2), uuid(1), uuid(2)]);
  /* Another draft's page shows none of these. */
  expect(collector.collected("draft-2")).toEqual([]);
});

test("asking is bounded: an earlier connection's job stops at once, an unmoved one after a few reads, and a listing takes neither up again until it moves", async () => {
  let unconfirmed: Record<string, unknown> = job(6, "uncertain");
  const { collector, reads, advance, shown, lists } = harness(
    () => [job(5, "accepted"), unconfirmed],
    {
      [uuid(5)]: [{ status: 409, body: { code: "connection_changed", error: "The account connection changed." } }],
      [uuid(6)]: [...Array.from({ length: COLLECT_UNSETTLED_POLLS }, () => ok(job(6, "uncertain"))), ok(job(6, "accepted")), ok(job(6, "completed"))],
    },
  );
  await collector.list(DRAFT);
  await advance(0);
  expect(shown()[uuid(5)]).toEqual({ status: "accepted", following: false, problem: "Started on an earlier account connection, so it can't be checked from here." });
  for (let i = 0; i < COLLECT_UNSETTLED_POLLS + 2; i++) await advance(COLLECT_POLL_MS);
  expect(reads.filter((id) => id === uuid(5))).toHaveLength(1);
  expect(reads.filter((id) => id === uuid(6))).toHaveLength(COLLECT_UNSETTLED_POLLS);
  expect(shown()[uuid(6)]).toEqual({ status: "uncertain", following: false, problem: null });
  /* The page changes and the project is listed again: nothing moved, so nothing is asked again. */
  await collector.list(DRAFT);
  await collector.list(DRAFT);
  for (let i = 0; i < 3; i++) await advance(COLLECT_POLL_MS);
  expect(lists()).toBe(3);
  expect(reads).toHaveLength(1 + COLLECT_UNSETTLED_POLLS);
  /* The account confirmed it after all (the sweep reconciled it): the next listing shows it moved, and it is read to the end. */
  unconfirmed = job(6, "accepted");
  await collector.list(DRAFT);
  await advance(0);
  await advance(COLLECT_POLL_MS);
  expect(shown()[uuid(6)]).toMatchObject({ status: "completed", following: false });
  expect(reads.filter((id) => id === uuid(5))).toHaveLength(1);
});

test("a reconnect stops every read and says so on each open job; a job left to its own view is not read here, and is dropped once the view settles it", async () => {
  const { collector, reads, advance, shown } = harness(
    () => [job(7, "accepted"), job(8, "uncertain", { providerReceipt: RECEIPT }), job(9, "accepted")],
    { [uuid(7)]: [{ status: 401, body: { code: "reconnect_required", error: "Reconnect the account in Workspace › Engines before continuing." } }] },
  );
  /* The Ads composer is reading job 9 back after a reload: it is the composer's alone. */
  collector.watch(uuid(9));
  await collector.list(DRAFT);
  expect(shown()[uuid(9)]).toMatchObject({ following: true });
  await advance(0);
  const reconnect = "Reconnect the account in Workspace › Engines to finish this take.";
  expect(shown()[uuid(7)]).toEqual({ status: "accepted", following: false, problem: reconnect });
  expect(shown()[uuid(8)]).toEqual({ status: "uncertain", following: false, problem: reconnect });
  await advance(COLLECT_BACKOFF_MS * 3);
  expect(reads).toEqual([uuid(7)]);
  expect(collector.tracking()).toEqual([]);
  /* The composer settled its job and showed it: nothing is left for a page to pick up. */
  collector.release(DRAFT, { id: uuid(9), status: "completed" });
  expect(shown()[uuid(9)]).toBeUndefined();
});

test("a job read back by its composer is never read here at the same time; let go unsettled, the collector reads it again", async () => {
  const { collector, reads, advance, shown } = harness(() => [job(10, "accepted")], { [uuid(10)]: [ok(job(10, "accepted")), ok(job(10, "completed"))] });
  await collector.list(DRAFT);
  /* The composer starts reading it back before the collector's first read. */
  collector.watch(uuid(10));
  await advance(COLLECT_POLL_MS * 2);
  expect(reads).toEqual([]);
  /* Its read-back gave up (an outage): the collector asks again. */
  collector.unwatch(uuid(10));
  await advance(0);
  await advance(COLLECT_POLL_MS);
  expect(reads).toEqual([uuid(10), uuid(10)]);
  expect(shown()[uuid(10)]).toMatchObject({ status: "completed", following: false });
  /* A job the server does not know is forgotten outright. */
  collector.unwatch(uuid(10), true);
  expect(shown()[uuid(10)]).toBeUndefined();
});

test("a job its own view gave up on is not taken up when the view lets it go, nor by a listing that shows it unchanged", async () => {
  const { collector, reads, advance } = harness(() => [job(11, "accepted")], {});
  /* An Ads composer was polling it; its read failed the way every read would (an earlier connection). */
  collector.watch(uuid(11));
  await collector.list(DRAFT);
  collector.forgo(uuid(11), "accepted");
  collector.release(DRAFT, { id: uuid(11), status: "accepted" });
  await advance(COLLECT_POLL_MS * 3);
  await collector.list(DRAFT);
  await advance(COLLECT_POLL_MS);
  expect(reads).toEqual([]);
  /* A view that lets go of a job it did not give up on hands it over as before. */
  collector.watch(uuid(12));
  collector.release(DRAFT, { id: uuid(12), status: "accepted" });
  await advance(0);
  expect(reads).toEqual([uuid(12)]);
});
