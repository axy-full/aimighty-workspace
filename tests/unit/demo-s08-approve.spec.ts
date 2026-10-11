import { test, expect } from "@playwright/test";
import { LOST_REPLY, THREAD_CONTINUE, approveBatch, approveItem, declineItem, type Fetcher } from "../../lib/control-room/approve";
import type { QueueItem } from "../../lib/control-room/queue";
import { exact, upTo } from "../../lib/shell/price-words";

/**
 * Pressing a queue item (lib/control-room/approve.ts): each goes through its
 * own existing route with its own price or fingerprint; "Approve in one go"
 * sends them one at a time and stops at the first refusal; nothing is ever
 * sent twice, and nothing is sent for an item this person may not press.
 */

const RUN = `rar_${"a".repeat(24)}`;
const FP = "f".repeat(64);
let n = 0;
function held(over: Partial<QueueItem> = {}): QueueItem {
  n++;
  return {
    id: `held:gen_${n}`, source: "held", title: `Take ${n}`, where: "Make", at: n,
    project: { productionId: "prod", draftId: "draft", name: "P" },
    price: exact(3), needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
    approve: { kind: "release", genId: `gen_${n}`, credits: 3 }, decline: { kind: "discard", genId: `gen_${n}` },
    open: { kind: "take", genId: `gen_${n}`, draftId: "draft" }, ...over,
  };
}
const render = (seq: number, over: Partial<QueueItem> = {}) => held({
  source: "board-render", price: upTo(7),
  approve: { kind: "board-render", productionId: "prod", runId: RUN, seq, fingerprint: FP },
  decline: { kind: "board-skip", productionId: "prod", runId: RUN, seq }, ...over,
});

type Call = { url: string; method: string; body: unknown };
function recorder(answers: ((call: Call) => Response | Promise<Response>)[] = []) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const answer = answers[calls.length - 1];
    return answer ? answer(call) : Response.json({ ok: true });
  };
  return { calls, fetcher };
}

test("each item is approved through its own route at its own price or fingerprint", async () => {
  const take = held({ approve: { kind: "release", genId: "gen_x", credits: 21 }, price: exact(21) });
  const build = held({ source: "board-plan", price: { kind: "free" }, approve: { kind: "board-approve", productionId: "prod", runId: RUN, fingerprint: FP } });
  const shot = render(7);
  const { calls, fetcher } = recorder();
  for (const it of [take, build, shot]) expect(await approveItem(it, fetcher)).toEqual({ ok: true });
  expect(calls).toEqual([
    { url: "/api/jobs/gen_x/release", method: "POST", body: { credits: 21 } },
    { url: "/api/workbench/team-canvas", method: "POST", body: { action: "agent.approve", productionId: "prod", runId: RUN, fingerprint: FP } },
    { url: "/api/workbench/team-canvas", method: "POST", body: { action: "agent.render", productionId: "prod", runId: RUN, seq: 7, fingerprint: FP } },
  ]);
});

test("nothing is sent for an item this person may not press, nor for a plan's step (its own Continue prices it live)", async () => {
  const { calls, fetcher } = recorder();
  const notMine = held({ canApprove: false, why: "Only the person who made this take, or an admin, can release it." });
  expect(await approveItem(notMine, fetcher)).toEqual({ ok: false, reason: notMine.why, status: null });
  expect(await approveItem(held({ sample: true }), fetcher)).toMatchObject({ ok: false });
  expect(await approveItem(held({ price: null }), fetcher)).toMatchObject({ ok: false });
  const step = held({ source: "thread", price: upTo(4), approve: { kind: "thread", chatId: "ach", stepId: "astp", productionId: "prod" } });
  expect(await approveItem(step, fetcher)).toEqual({ ok: false, reason: THREAD_CONTINUE, status: null });
  expect(calls).toEqual([]);
});

test("a route's refusal comes back in its own words; a release answered as already done counts as done", async () => {
  const { fetcher } = recorder([
    () => Response.json({ error: "Still short: this needs 21 credits and 4 are left.", credits: 21 }, { status: 402 }),
    () => Response.json({ released: true, id: "gen_y", already: true }),
  ]);
  expect(await approveItem(held(), fetcher)).toEqual({ ok: false, reason: "Still short: this needs 21 credits and 4 are left.", status: 402 });
  expect(await approveItem(held(), fetcher)).toEqual({ ok: true, already: true });
});

test("Approve in one go sends one at a time, in order, and stops at the first refusal: nothing after it is sent", async () => {
  const a = held(), b = render(2), c = held(), d = held();
  const { calls, fetcher } = recorder([
    () => Response.json({ released: true }),
    () => Response.json({ agent: {} }),
    () => Response.json({ error: "This take is not held." }, { status: 409 }),
    () => Response.json({ released: true }),
  ]);
  const steps: string[] = [];
  const out = await approveBatch([a, b, c, d], fetcher, (done) => steps.push(done.id));
  expect(out.approved.map((i) => i.id)).toEqual([a.id, b.id]);
  expect(out.refused).toEqual({ item: c, reason: "This take is not held." });
  expect(out.unsent.map((i) => i.id)).toEqual([d.id]);
  expect(steps).toEqual([a.id, b.id]);
  expect(calls.map((c) => c.url)).toEqual(["/api/jobs/gen_" + a.id.split("_")[1] + "/release", "/api/workbench/team-canvas", "/api/jobs/gen_" + c.id.split("_")[1] + "/release"]);
});

test("a lost answer stops the batch and is never sent again from here", async () => {
  const a = held(), b = held();
  const { calls, fetcher } = recorder([() => { throw new TypeError("Failed to fetch"); }]);
  const out = await approveBatch([a, b], fetcher);
  expect(out).toEqual({ approved: [], refused: { item: a, reason: LOST_REPLY }, unsent: [b] });
  expect(calls).toHaveLength(1);
});

test("an item that may not go in a batch stops it before anything is sent for it", async () => {
  const ok = held(), admin = held({ needsAdmin: true }), after = held();
  const { calls, fetcher } = recorder();
  const out = await approveBatch([ok, admin, after], fetcher);
  expect(out.approved).toEqual([ok]);
  expect(out.refused?.item).toBe(admin);
  expect(calls).toHaveLength(1);
});

test("Not now goes through each item's own way to let it go", async () => {
  const { calls, fetcher } = recorder();
  await declineItem(held({ decline: { kind: "discard", genId: "gen_d" } }), fetcher);
  await declineItem(held({ decline: { kind: "board-decline", productionId: "prod", runId: RUN } }), fetcher);
  await declineItem(render(3), fetcher);
  await declineItem(held({ decline: { kind: "thread-stop", stepId: "astp_9" } }), fetcher);
  expect(calls).toEqual([
    { url: "/api/jobs/gen_d", method: "DELETE", body: null },
    { url: "/api/workbench/team-canvas", method: "POST", body: { action: "agent.decline", productionId: "prod", runId: RUN } },
    { url: "/api/workbench/team-canvas", method: "POST", body: { action: "agent.skip", productionId: "prod", runId: RUN, seq: 3 } },
    { url: "/api/atomik/steps/astp_9", method: "PATCH", body: { status: "rejected" } },
  ]);
  const { calls: none, fetcher: f2 } = recorder();
  expect(await declineItem(held({ decline: null, why: "Only the person who made this take, or an admin, can release it." }), f2)).toMatchObject({ ok: false });
  expect(none).toEqual([]);
});
