import { test, expect } from "@playwright/test";
import { BUSY, NO_RECEIPT, NOT_HERE, QueuedCancelError, UNSURE, cancelQueuedVideo, handleOf, servedHere, type ProviderSeen, type QueuedCancelDeps, type QueuedRow } from "../../lib/queuedCancel";

/**
 * Cancel for a queued Seedance (BytePlus) or Kling and Topaz (fal) take (lib/queuedCancel.ts; owner's rule: a cancel bills nothing
 * only while the provider still has the job queued). The orchestration, against a fake provider and a fake ledger: each case
 * says what was asked of the provider, what was settled, and what was answered. The same paths run on the real ledger in
 * tests/queued-cancel-workbench.spec.ts.
 */
const ARK: QueuedRow = { id: "g1", status: "queued", provider: "byteplus", kind: "video", model: "dreamina-seedance-2-5-260628", createdBy: "u1", arkTaskId: "task-1", params: {} };
const FAL: QueuedRow = { id: "g2", status: "queued", provider: "fal", kind: "video", model: "fal-ai/kling-video/v3/standard", createdBy: "u1", arkTaskId: null, params: { falRequestId: "req-1", falModel: "fal-ai/kling-video/v3" } };

function world(row: QueuedRow | null, opts: { actor?: { id: string; role: string } | null; seen?: (ProviderSeen | "throw")[]; cancel?: "ok" | "throw"; settled?: string } = {}) {
  const calls: string[] = [];
  let status = row?.status ?? "";
  let claimed = false;
  const seen = [...(opts.seen ?? ["queued"])];
  const deps: QueuedCancelDeps = {
    exclusive: (_id, run) => run(),
    load: async () => (row ? { ...row, status } : null),
    actor: () => (opts.actor === undefined ? { id: "u1", role: "member" } : opts.actor),
    poll: async () => { calls.push("poll"); const next = seen.length > 1 ? seen.shift()! : seen[0]; if (next === "throw") throw new Error("unreachable"); return next; },
    cancel: async () => { calls.push("cancel"); if (opts.cancel === "throw") throw new Error("vendor said no"); },
    claim: async () => { calls.push("claim"); await Promise.resolve(); if (claimed) return false; claimed = true; return true; },
    unclaim: async () => { calls.push("unclaim"); claimed = false; },
    markAsked: async () => { calls.push("markAsked"); if (row) row = { ...row, params: { ...row.params, cancelRequestedAt: 1 } }; },
    settle: async () => { calls.push("settle"); status = opts.settled ?? status; return { status }; },
  };
  return { deps, calls };
}
const refused = async (run: () => Promise<unknown>) => run().then(() => null, (e: unknown) => (e instanceof QueuedCancelError ? e : Promise.reject(e)));

test("queued at the provider, cancelled by it: the provider is asked once, the take is settled, and the answer is cancelled", async () => {
  for (const row of [ARK, FAL]) {
    const w = world(row, { settled: "cancelled" });
    expect(await cancelQueuedVideo(row.id, w.deps)).toEqual({ status: "cancelled" });
    expect(w.calls).toEqual(["claim", "poll", "cancel", "poll", "markAsked", "settle"]);
  }
});

test("asked but not yet confirmed: the answer is requested, never cancelled, and nothing is released here", async () => {
  const w = world(FAL, { settled: "queued" });
  expect(await cancelQueuedVideo("g2", w.deps)).toEqual({ status: "requested" });
});

test("the provider says it is running or done: refused in its words, nothing asked of it, billing left as it is", async () => {
  const running = world(ARK, { seen: ["running"] });
  expect(await cancelQueuedVideo("g1", running.deps)).toEqual({ status: "running" });
  expect(running.calls).toEqual(["claim", "poll", "unclaim"]);
  for (const done of ["succeeded", "failed"] as const) {
    const w = world(ARK, { seen: [done] });
    expect(await cancelQueuedVideo("g1", w.deps)).toEqual({ status: done });
    expect(w.calls).toEqual(["claim", "poll", "settle", "unclaim"]);
  }
  /* Our own row says running: the provider's queue no longer holds it, and it is not even asked. */
  const started = world({ ...ARK, status: "running" });
  expect(await cancelQueuedVideo("g1", started.deps)).toEqual({ status: "running" });
  expect(started.calls).toEqual([]);
});

test("the provider errors: refused, the hold is kept (nothing settled, nothing marked), and no word about billing", async () => {
  const lost = world(ARK, { seen: ["throw"] });
  const a = await refused(() => cancelQueuedVideo("g1", lost.deps));
  expect(a?.status).toBe(503);
  expect(a?.message).toBe(UNSURE);
  expect(lost.calls).toEqual(["claim", "poll", "unclaim"]);
  const refusing = world(FAL, { cancel: "throw" });
  const b = await refused(() => cancelQueuedVideo("g2", refusing.deps));
  expect(b?.status).toBe(503);
  expect(refusing.calls).toEqual(["claim", "poll", "cancel", "poll", "unclaim"]);
  expect(refusing.calls).not.toContain("settle");
  expect(refusing.calls).not.toContain("markAsked");
  expect(UNSURE).not.toMatch(/nothing (was )?billed/i);
});

test("a cancel the provider refuses because the job just started says it started, and is not an error", async () => {
  const w = world(ARK, { seen: ["queued", "running"], cancel: "throw" });
  expect(await cancelQueuedVideo("g1", w.deps)).toEqual({ status: "running" });
  expect(w.calls).toEqual(["claim", "poll", "cancel", "poll", "unclaim"]);
});

test("a double press is one cancel: a cancelled take answers cancelled without asking, and one already asked is only settled", async () => {
  const done = world({ ...ARK, status: "cancelled" });
  expect(await cancelQueuedVideo("g1", done.deps)).toEqual({ status: "cancelled" });
  expect(done.calls).toEqual([]);
  const asked = world({ ...FAL, params: { ...FAL.params, cancelRequestedAt: 5 } }, { settled: "cancelled" });
  expect(await cancelQueuedVideo("g2", asked.deps)).toEqual({ status: "cancelled" });
  expect(asked.calls).toEqual(["settle"]);
  expect(asked.calls).not.toContain("claim");
  /* The same take twice in a row: the second press never reaches the provider's cancel again. */
  const w = world(FAL, { settled: "cancelled" });
  await cancelQueuedVideo("g2", w.deps);
  expect(await cancelQueuedVideo("g2", w.deps)).toEqual({ status: "cancelled" });
  expect(w.calls.filter((c) => c === "cancel")).toHaveLength(1);
});

test("another workspace's take is not found; a take that is not the author's needs an admin; other engines are not served here", async () => {
  const other = world(null);
  expect((await refused(() => cancelQueuedVideo("nope", other.deps)))?.status).toBe(404);
  expect(other.calls).toEqual([]);
  const stranger = world(ARK, { actor: { id: "u2", role: "member" } });
  expect((await refused(() => cancelQueuedVideo("g1", stranger.deps)))?.status).toBe(403);
  expect(stranger.calls).toEqual([]);
  const admin = world(ARK, { actor: { id: "u2", role: "admin" }, settled: "cancelled" });
  expect(await cancelQueuedVideo("g1", admin.deps)).toEqual({ status: "cancelled" });
  expect((await refused(() => cancelQueuedVideo("g1", world(ARK, { actor: null }).deps)))?.status).toBe(403);
  const still = world({ ...ARK, provider: "google", kind: "image" });
  const wrong = await refused(() => cancelQueuedVideo("g1", still.deps));
  expect([wrong?.status, wrong?.message]).toEqual([404, NOT_HERE]);
  const noReceipt = world({ ...ARK, arkTaskId: null });
  const none = await refused(() => cancelQueuedVideo("g1", noReceipt.deps));
  expect([none?.status, none?.message]).toEqual([409, NO_RECEIPT]);
  expect(noReceipt.calls).toEqual([]);
});

test("a take's receipt at its provider: an Ark task id or a fal request id with its queue, for video only", () => {
  expect(handleOf(ARK)).toEqual({ provider: "byteplus", ref: "task-1", model: ARK.model });
  expect(handleOf(FAL)).toEqual({ provider: "fal", ref: "req-1", model: FAL.model, endpoint: "fal-ai/kling-video/v3" });
  expect(handleOf({ ...FAL, params: {} })).toBeNull();
  expect(handleOf({ ...ARK, kind: "image" })).toBeNull();
  expect([servedHere(ARK), servedHere(FAL), servedHere({ provider: "higgsfield", kind: "video" }), servedHere({ provider: "fal", kind: "image" })]).toEqual([true, true, false, false]);
});

test("two presses at once make one call to the provider: the loser is told one is already being sent", async () => {
  const w = world(ARK, { settled: "cancelled" });
  const [a, b] = await Promise.allSettled([cancelQueuedVideo("g1", w.deps), cancelQueuedVideo("g1", w.deps)]);
  expect(w.calls.filter((c) => c === "cancel")).toHaveLength(1);
  const results = [a, b];
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(lost.reason).toBeInstanceOf(QueuedCancelError);
  expect([lost.reason.status, lost.reason.message]).toEqual([409, BUSY]);
});

test("a failed cancel lets go of the claim, so the next press may try; one accepted keeps it", async () => {
  const failing = world(FAL, { cancel: "throw" });
  await refused(() => cancelQueuedVideo("g2", failing.deps));
  expect(failing.calls.at(-1)).toBe("unclaim");
  const ok = world(FAL, { settled: "cancelled" });
  await cancelQueuedVideo("g2", ok.deps);
  expect(ok.calls).not.toContain("unclaim");
});

test("fal answers 202 for a request that is already running: read again afterwards, a running job is not marked cancel-asked and is billed as today", async () => {
  /* queued before the PUT, in progress after it, and (later) completed by the vendor: nothing is marked, settled or released here. */
  const w = world(FAL, { seen: ["queued", "running"] });
  expect(await cancelQueuedVideo("g2", w.deps)).toEqual({ status: "running" });
  expect(w.calls).toEqual(["claim", "poll", "cancel", "poll", "unclaim"]);
  expect(w.calls).not.toContain("markAsked");
  expect(w.calls).not.toContain("settle");
});

test("a vendor that no longer answers after the PUT is left to the take's sync: marked as asked, settled, and said only as requested until it ends", async () => {
  const w = world(FAL, { seen: ["queued", "throw"], settled: "queued" });
  expect(await cancelQueuedVideo("g2", w.deps)).toEqual({ status: "requested" });
  expect(w.calls).toEqual(["claim", "poll", "cancel", "poll", "markAsked", "settle"]);
});
