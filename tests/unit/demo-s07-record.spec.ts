import { test, expect } from "@playwright/test";
import { approvalWords, recordApprovals, recordBrief, recordBudget, recordDecisions } from "../../lib/shell/project-record";
import type { ActivityRun, RunStep } from "../../lib/control-room/activity";
import type { QueueItem } from "../../lib/control-room/queue";

/* Stream 7 · the Project record as a model: approved steps priced → settled, open decisions, spend against the budget. Credits only. */
const step = (id: string, more: Partial<RunStep> = {}): RunStep => ({
  id, kind: "paid", title: id, priced: { kind: "exact", credits: 8 }, settled: { kind: "settled", credits: 8 }, state: "done", by: "Ana", byYou: false, auto: false, at: 10, ...more,
});
const run = (steps: RunStep[], more: Partial<ActivityRun> = {}): ActivityRun => ({
  id: "board:rar_a", source: "board", n: 1, title: "t", project: { productionId: "p", draftId: "d", name: "n" }, startedAt: 1, state: "done", reason: null, steps, settled: 0, settling: false, request: "", open: { kind: "board", productionId: "p", draftId: "d" }, ...more,
});

test("one row per approved step, newest first; a step that was never approved is not a row", () => {
  const rows = recordApprovals([run([
    step("a", { at: 10 }), step("b", { at: 30 }), step("c", { at: 20, state: "waiting" }), step("d", { at: 25, state: "skipped" }), step("e", { at: 5, state: "turned down" }), step("f", { at: 15, state: "failed", settled: { kind: "nothing" } }),
  ])]);
  expect(rows.map((r) => r.title)).toEqual(["b", "f", "a"]);
});

test("priced → settled: the figures as the ledger shows them, never invented", () => {
  const rows = recordApprovals([run([
    step("thinking", { kind: "thinking", priced: { kind: "up-to", credits: 4 }, settled: { kind: "settled", credits: 4 }, at: 1 }),
    step("render", { settled: { kind: "settling" }, state: "running", at: 2 }),
    step("failed", { settled: { kind: "nothing" }, state: "failed", at: 3 }),
    step("unknown", { settled: { kind: "unknown" }, at: 4 }),
    step("unbilled", { priced: null, settled: { kind: "unbilled" }, at: 5 }),
  ])]);
  const by = Object.fromEntries(rows.map((r) => [r.title, approvalWords(r)]));
  expect(by.thinking).toBe("up to 4 cr → 4 cr");
  expect(by.render).toBe("8 cr → settling");
  expect(by.failed).toBe("8 cr → Nothing billed");
  expect(by.unknown).toBe("8 cr");
  expect(by.unbilled).toBe("");
  for (const words of Object.values(by)) expect(words).not.toMatch(/\$|quoted/);
});

test("who approved reads 'you' for the viewer, else the ledger's name; Auto says so", () => {
  const [mine, auto] = recordApprovals([run([step("m", { byYou: true, at: 2 }), step("x", { auto: true, by: null, at: 1 })])]);
  expect(mine.by).toBe("you");
  expect(auto.auto).toBe(true);
});

const queued = (id: string, productionId: string | null, more: Partial<QueueItem> = {}): QueueItem => ({
  id, source: "board-render", title: id, where: "Board", at: 1, project: { productionId, draftId: null, name: null }, price: { kind: "exact", credits: 8 }, needsAdmin: false, canApprove: true,
  why: null, shortBy: null, note: null, step: null, sample: false, approve: null, decline: null, open: { kind: "board", productionId: productionId ?? "", draftId: null }, ...more,
});
test("open decisions are this production's queue items only, and never the sample's", () => {
  const rows = recordDecisions([queued("a", "p"), queued("b", "q"), queued("c", "p", { source: "held" }), queued("d", "p", { sample: true })], "p");
  expect(rows.map((r) => [r.id, r.where])).toEqual([["a", "board"], ["c", "approvals"]]);
  expect(recordDecisions([queued("a", "p")], null)).toEqual([]);
});

test("spend against the budget: N of M cr with the bar; no budget says so; no 80 % line; unbilled shows no figure", () => {
  expect(recordBudget({ inCredits: true, cap: 200, spent: 161 })).toMatchObject({ kind: "capped", line: "161 of 200 cr", over: false });
  expect((recordBudget({ inCredits: true, cap: 200, spent: 161 }) as { fraction: number }).fraction).toBeCloseTo(0.805);
  expect(recordBudget({ inCredits: true, cap: 200, spent: 250 })).toMatchObject({ kind: "capped", over: true, fraction: 1 });
  expect(recordBudget({ inCredits: true, cap: null, spent: 12.34 })).toEqual({ kind: "none", spent: 12.3, line: "12.3 cr spent · no budget" });
  expect(recordBudget({ inCredits: true, cap: 0, spent: 3 }).kind).toBe("none");
  expect(recordBudget({ inCredits: false, cap: 200, spent: 5 })).toEqual({ kind: "unbilled" });
  for (const b of [recordBudget({ inCredits: true, cap: 200, spent: 161 }), recordBudget({ inCredits: true, cap: null, spent: 1 })]) expect((b as { line: string }).line).not.toMatch(/80 ?%|paused|held/i);
});

test("the brief reads as the board's brief card does", () => {
  expect(recordBrief({ brief: " A film. ", direction: " Warm. ", aspect: "16:9", fps: 24, length: "15 s" })).toEqual({ brief: "A film.", look: "Warm.", footer: "16:9 · 24 fps · 15 s" });
  expect(recordBrief({ brief: "", direction: "", aspect: "16:9", fps: 24, length: null }).footer).toBe("16:9 · 24 fps");
});
