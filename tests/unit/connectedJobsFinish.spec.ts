import { test, expect } from "@playwright/test";
import {
  canProgress, createResumeTracker, isOpen, resumableJobs, resumeAge, resumeDelayMs, resumeGivesUp, resumeLine, resumePhase, resumeProblem, shortName,
} from "../../lib/higgsfield-consumer/resume";

/**
 * A page opened after its connected-account jobs were left running picks them
 * back up: it lists what is still open, follows only what a status read can
 * move (never a quote, never a submit), and shows the rest as they are, with
 * no invented progress and no card that asks forever.
 */
const RECEIPT = { response: "submitted" };

test("a page lists every open job but follows only what a read can move: rendering, or unconfirmed with a receipt", () => {
  const jobs = [
    { id: "a", status: "quoted", createdAt: 1 }, { id: "b", status: "accepted", createdAt: 2 }, { id: "c", status: "uncertain", createdAt: 5, providerReceipt: RECEIPT },
    { id: "d", status: "completed", createdAt: 3 }, { id: "e", status: "dispatching", createdAt: 4 }, { id: "f", status: "failed", createdAt: 6 },
    { id: "g", status: "uncertain", createdAt: 7 },
  ];
  expect(resumableJobs(jobs).map((j) => j.id)).toEqual(["g", "c", "e", "b"]);
  expect(resumableJobs(jobs, (j) => j.id !== "c").map((j) => j.id)).toEqual(["g", "e", "b"]);
  expect(["quoted", "dispatching", "accepted", "uncertain", "completed", "failed"].map(isOpen)).toEqual([false, true, true, true, false, false]);
  expect(jobs.filter(canProgress).map((j) => j.id)).toEqual(["b", "c"]);
});

test("each state has one short label; a job nobody is asking after says why instead of claiming to render", () => {
  const at = (status: string, extra: Record<string, unknown> = {}) => ({ status, createdAt: 0, ...extra });
  expect(resumePhase(at("accepted"))).toEqual({ label: "Rendering", tone: "blue" });
  expect(resumePhase(at("uncertain", { providerReceipt: RECEIPT }))).toEqual({ label: "Confirming", tone: "amber" });
  expect(resumePhase(at("uncertain"))).toEqual({ label: "Not confirmed · never sent twice", tone: "amber" });
  expect(resumePhase(at("dispatching"))).toEqual({ label: "Not confirmed · never sent twice", tone: "amber" });
  expect(resumePhase(at("uncertain", { setAside: true }))).toEqual({ label: "Set aside · never sent again", tone: "amber" });
  // Stopped after a read that could not move it, or an error that would repeat.
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
  expect([err("connection_changed", 409), err(undefined, 404), err(undefined, 403)].every(resumeGivesUp)).toBe(true);
  expect([err("reconnect_required", 401), err("original_quota", 507), err(undefined, 429), err(undefined, 503), new Error("offline")].some(resumeGivesUp)).toBe(false);
  // The server's hint, bounded to 8–60 s; a job only the account can confirm every 30 s; misses back off to 2 min.
  expect([resumeDelayMs("accepted", 20), resumeDelayMs("accepted", 2), resumeDelayMs("accepted", 900), resumeDelayMs("accepted", null)]).toEqual([20_000, 8_000, 60_000, 10_000]);
  expect([resumeDelayMs("uncertain", 5), resumeDelayMs("accepted", 20, 1), resumeDelayMs("accepted", 20, 9)]).toEqual([30_000, 40_000, 120_000]);
});

type J = { id: string; status: string; providerReceipt?: unknown };
function harness() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const replies = new Map<string, () => Promise<{ job: J; pollAfterSeconds?: number }>>();
  const seen: string[] = [];
  const asked: string[] = [];
  const tracker = createResumeTracker<J>({
    status: async (id) => { asked.push(id); return replies.get(id)!(); },
    onUpdate: (job) => seen.push(`update:${job.id}:${job.status}`),
    onSettled: (job) => seen.push(`settled:${job.id}:${job.status}`),
    onStalled: (id, error) => seen.push(`stalled:${id}:${error ? (error as { code?: string }).code ?? "error" : "unmoved"}`),
    onProblem: (id) => seen.push(`problem:${id}`),
    schedule: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    cancel: (handle) => { (handle as { live: boolean }).live = false; },
  });
  const fire = async () => {
    const due = timers.filter((t) => t.live);
    for (const t of due) t.live = false;
    for (const t of due) t.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return due.map((t) => t.ms);
  };
  const pending = () => timers.filter((t) => t.live).map((t) => t.ms);
  return { tracker, replies, seen, asked, fire, pending };
}

test("the tracker follows several jobs on their own clocks until each settles, keeps going past one job's passing error, and goes quiet when stopped", async () => {
  const { tracker, replies, seen, asked, fire, pending } = harness();
  tracker.track([{ id: "a", status: "accepted" }, { id: "b", status: "accepted" }, { id: "c", status: "completed" }, { id: "d", status: "dispatching" }, { id: "e", status: "uncertain" }]);
  tracker.track([{ id: "a", status: "accepted" }]);
  // Never a job no read can move: not "dispatching", not "uncertain" without a receipt.
  expect(tracker.followed()).toEqual(["a", "b"]);
  replies.set("a", async () => ({ job: { id: "a", status: "accepted" }, pollAfterSeconds: 20 }));
  replies.set("b", async () => { throw Object.assign(new Error("offline"), { status: 503 }); });
  expect(await fire()).toEqual([1200, 1200]);
  expect(seen).toEqual(["update:a:accepted", "problem:b"]);
  // a follows the server's pace; b backs off from its own base.
  expect(pending()).toEqual([20_000, 20_000]);
  replies.set("a", async () => ({ job: { id: "a", status: "completed" } }));
  replies.set("b", async () => ({ job: { id: "b", status: "accepted" }, pollAfterSeconds: 15 }));
  await fire();
  expect(seen.slice(2)).toEqual(["update:a:completed", "settled:a:completed", "update:b:accepted"]);
  expect(tracker.followed()).toEqual(["b"]);
  // Dismissed or stopped: nothing is asked again and late replies are dropped.
  tracker.forget("b");
  expect(pending()).toHaveLength(0);
  tracker.stop();
  tracker.track([{ id: "f", status: "accepted" }]);
  expect(await fire()).toEqual([]);
  expect(asked).toEqual(["a", "b", "a", "b"]);
});

test("an unconfirmed job is asked once with its receipt, then left alone if that read cannot move it; an error that would repeat stops at once", async () => {
  const { tracker, replies, seen, asked, fire, pending } = harness();
  const receipted = { id: "r", status: "uncertain", providerReceipt: RECEIPT };
  const reconciled = { id: "s", status: "uncertain", providerReceipt: RECEIPT };
  tracker.track([receipted, reconciled, { id: "old", status: "accepted" }, { id: "slow", status: "accepted" }]);
  replies.set("r", async () => ({ job: receipted }));
  replies.set("s", async () => ({ job: { id: "s", status: "accepted" }, pollAfterSeconds: 15 }));
  replies.set("old", async () => { throw Object.assign(new Error("changed"), { code: "connection_changed", status: 409 }); });
  replies.set("slow", async () => { throw Object.assign(new Error("reconnect"), { code: "reconnect_required", status: 401 }); });
  await fire();
  expect(seen).toEqual(["update:r:uncertain", "stalled:r:unmoved", "update:s:accepted", "stalled:old:connection_changed", "problem:slow"]);
  // Only the reconciled job and the one waiting for a reconnect are asked again.
  expect(tracker.followed().sort()).toEqual(["s", "slow"]);
  expect(pending().sort((x, y) => x - y)).toEqual([15_000, 20_000]);
  // Six more rounds of fake time: the stalled two are never asked again.
  for (let i = 0; i < 6; i++) await fire();
  expect(asked.filter((id) => id === "r" || id === "old")).toEqual(["r", "old"]);
});
