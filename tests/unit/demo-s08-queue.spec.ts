import { test, expect } from "@playwright/test";
import {
  BATCH_UNDER_DEFAULT, batchable, cleanUnder, countLine, countsByDraft, pressable, priceCredits, priceLabel, selectBatch, sortQueue,
  type QueueItem,
} from "../../lib/control-room/queue";
import { FREE, exact, upTo } from "../../lib/shell/price-words";

/**
 * The one approvals queue (lib/control-room/queue.ts): what "approve
 * everything under N cr" covers and leaves out, its total, the order things
 * are sent in, and that every price is worded by the shared price words.
 */

let n = 0;
function item(over: Partial<QueueItem> = {}): QueueItem {
  n++;
  const id = over.id ?? `held:gen_${n}`;
  return {
    id, source: "held", title: `Item ${n}`, where: "Make", at: 1_000 + n,
    project: { productionId: "prod_a", draftId: "draft_a", name: "Project A" },
    price: exact(3), needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
    approve: { kind: "release", genId: `gen_${n}`, credits: 3 }, decline: { kind: "discard", genId: `gen_${n}` },
    open: { kind: "take", genId: `gen_${n}`, draftId: "draft_a" },
    ...over,
  };
}
const render = (over: Partial<QueueItem> = {}) => item({
  source: "board-render", where: "Board",
  approve: { kind: "board-render", productionId: "prod_a", runId: `rar_${"a".repeat(24)}`, seq: 4, fingerprint: "f".repeat(64) },
  decline: { kind: "board-skip", productionId: "prod_a", runId: `rar_${"a".repeat(24)}`, seq: 4 },
  open: { kind: "board", productionId: "prod_a", draftId: "draft_a" },
  ...over,
});
const thread = (over: Partial<QueueItem> = {}) => item({
  source: "thread", where: "Atomik", price: upTo(4), step: { n: 1, of: 3 },
  approve: { kind: "thread", chatId: "ach_1", stepId: "astp_1", productionId: "prod_a" }, decline: { kind: "thread-stop", stepId: "astp_1" },
  open: { kind: "thread", chatId: "ach_1", productionId: "prod_a" },
  ...over,
});
const plan = (over: Partial<QueueItem> = {}) => item({
  source: "board-plan", where: "Board", price: FREE,
  approve: { kind: "board-approve", productionId: "prod_a", runId: `rar_${"b".repeat(24)}`, fingerprint: "e".repeat(64) },
  decline: { kind: "board-decline", productionId: "prod_a", runId: `rar_${"b".repeat(24)}` },
  open: { kind: "board", productionId: "prod_a", draftId: "draft_a" },
  ...over,
});

test("everything under N cr covers the priced items a person may press, in the order they waited, and totals them", () => {
  const first = item({ at: 10, price: exact(3) });
  const second = render({ at: 20, price: upTo(7) });
  const atTen = item({ at: 30, price: exact(10) });
  const batch = selectBatch([atTen, second, first], 10);
  /* "Under" is strict: a 10 cr item is not under 10 cr. Oldest first. */
  expect(batch.items.map((i) => i.id)).toEqual([first.id, second.id]);
  /* Any estimate makes the total "up to", worded by the shared price words. */
  expect(batch.total).toEqual(upTo(10));
  expect(priceLabel(batch.total)).toBe("up to 10 cr");
  expect(selectBatch([first], 10).total).toEqual(exact(3));
  expect(selectBatch([], 10).total).toBeNull();
});

test("one tap never covers an item over the per-shot rule, a plan's step, a proposed build, the sample, a short balance or someone else's", () => {
  const admin = item({ price: exact(5), needsAdmin: true });
  const step = thread({ price: upTo(2) });
  const build = plan();
  const sample = item({ sample: true });
  const short = item({ shortBy: 2 });
  const notMine = render({ canApprove: false, why: "Only the person who asked Atomik for this run can approve its renders." });
  const unpriced = render({ price: null });
  const ok = item({ price: exact(1) });
  const batch = selectBatch([admin, step, build, sample, short, notMine, unpriced, ok], 10);
  expect(batch.items.map((i) => i.id)).toEqual([ok.id]);
  /* Listed, so a person sees what was left out and why. */
  expect(batch.adminOut.map((i) => i.id)).toEqual([admin.id]);
  expect(batch.inPlan.map((i) => i.id)).toEqual([step.id]);
  for (const out of [admin, step, build, sample, short, notMine, unpriced]) expect(batchable(out)).toBe(false);
  expect(batchable(ok)).toBe(true);
});

test("a plan's step can be opened without a stored figure; anything else needs a price to be pressed", () => {
  expect(pressable(thread({ price: null }))).toBe(true);
  expect(pressable(item({ price: null }))).toBe(false);
  expect(pressable(item({ canApprove: false }))).toBe(false);
  expect(pressable(item({ sample: true }))).toBe(false);
  expect(pressable(item({ approve: null }))).toBe(false);
  expect(pressable(plan())).toBe(true);
});

test("prices are worded only by the shared price words: never quoted, never about, free for nothing", () => {
  expect(priceLabel(exact(43))).toBe("43 cr");
  expect(priceLabel(upTo(68.2))).toBe("up to 69 cr");
  expect(priceLabel(FREE)).toBe("free");
  expect(priceLabel(exact(0))).toBe("free");
  expect(priceLabel(null)).toBe("");
  for (const value of [exact(43), upTo(68.2), FREE]) expect(priceLabel(value)).not.toMatch(/quoted|about|\$/);
  expect(priceCredits(FREE)).toBe(0);
  expect(priceCredits(upTo(7))).toBe(7);
  expect(priceCredits(null)).toBeNull();
});

test("the count line, the per-draft counts for Home, the order and the batch figure", () => {
  const a = item({ at: 3, project: { productionId: "p1", draftId: "d1", name: "One" } });
  const b = item({ at: 1, project: { productionId: "p1", draftId: "d1", name: "One" } });
  const c = thread({ at: 2, project: { productionId: "p2", draftId: null, name: "Two" } });
  expect(countLine([a, b, c])).toBe("3 items across 2 projects");
  expect(countLine([a])).toBe("1 item across 1 project");
  expect([...countsByDraft([a, b, c])]).toEqual([["d1", 2]]);
  expect(sortQueue([a, b, c]).map((i) => i.at)).toEqual([1, 2, 3]);
  expect(cleanUnder("25")).toBe(25);
  expect(cleanUnder("2.9")).toBe(2);
  for (const bad of ["", "0", "-4", "ten", null]) expect(cleanUnder(bad)).toBe(BATCH_UNDER_DEFAULT);
});
