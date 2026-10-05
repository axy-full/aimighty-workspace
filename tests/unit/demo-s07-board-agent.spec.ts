import { test, expect } from "@playwright/test";
import { agentAsk, planItemOf, raiseTarget, renderItemOf, renderPrice, runNeedsYou, runOpen, buildLine, AGENT_OFF, SAMPLE_LINE } from "../../lib/shell/board-agent";
import type { QueueItem } from "../../lib/control-room/queue";
import type { RigAgentRunView } from "../../lib/workbench/rig-agent-plan";

/* Stream 7 · the board's docked panel as a model: which queue row is which press, the ask's price, and what the lines say. */
const run = (more: Partial<RigAgentRunView> = {}): RigAgentRunView => ({
  id: "rar_a", state: "needs_you", reason: null, goal: "g", mine: true, proposal: null, steps: [], built: { cards: 4, wires: 4 }, held: [], undo: null,
  canUndo: false, credits: 1, money: { mode: "ask", limit: 14, jobCeiling: 9, spent: 1, inFlight: 0, left: 13, planning: null }, paid: [], at: 1, ...more,
});
const item = (id: string, more: Partial<QueueItem> = {}): QueueItem => ({
  id, source: "board-render", title: "t", where: "Board", at: 1, project: { productionId: "p", draftId: "d", name: "n" }, price: { kind: "exact", credits: 8 },
  needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false, approve: null, decline: null, open: { kind: "board", productionId: "p", draftId: "d" }, ...more,
});

test("a proposal's and a render's queue rows are found by run and step, never by title", () => {
  const plan = item("board-plan:rar_a", { source: "board-plan", approve: { kind: "board-approve", productionId: "p", runId: "rar_a", fingerprint: "f" } });
  const r1 = item("board-render:rar_a:6", { approve: { kind: "board-render", productionId: "p", runId: "rar_a", seq: 6, fingerprint: "f" } });
  const paused = item("board-render:rar_a:7", { decline: { kind: "board-skip", productionId: "p", runId: "rar_a", seq: 7 } });
  const other = item("board-render:rar_b:6", { approve: { kind: "board-render", productionId: "p", runId: "rar_b", seq: 6, fingerprint: "f" } });
  const items = [other, plan, r1, paused];
  expect(planItemOf(items, run())?.id).toBe("board-plan:rar_a");
  expect(renderItemOf(items, run(), 6)?.id).toBe("board-render:rar_a:6");
  expect(renderItemOf(items, run(), 7)?.id).toBe("board-render:rar_a:7");
  expect(renderItemOf(items, run(), 8)).toBeNull();
  expect(planItemOf(items, null)).toBeNull();
});

test("a render's price is its price, or up to the most it may settle at; none without a figure", () => {
  expect(renderPrice({ quote: 8, worst: 8 })).toEqual({ kind: "exact", credits: 8 });
  expect(renderPrice({ quote: 8, worst: 24 })).toEqual({ kind: "up-to", credits: 24 });
  expect(renderPrice({ quote: null, worst: null })).toBeNull();
});

test("Ask · up to N cr is the planning figure and disabled, with the reason, when it cannot be pressed", () => {
  const base = { read: true, enabled: true, run: null, planning: 14, words: "two shots", busy: false, sample: false, offline: false };
  expect(agentAsk(base)).toMatchObject({ label: "Ask · up to 14 cr", disabled: false, reason: null, price: { kind: "up-to", credits: 14 } });
  expect(agentAsk({ ...base, words: "" })).toMatchObject({ label: "Ask · up to 14 cr", disabled: true, reason: null });
  expect(agentAsk({ ...base, planning: null })).toMatchObject({ label: "Ask", disabled: true });
  expect(agentAsk({ ...base, planning: null }).reason).toMatch(/no price/);
  expect(agentAsk({ ...base, enabled: false }).reason).toBe(AGENT_OFF);
  expect(agentAsk({ ...base, sample: true }).reason).toBe(SAMPLE_LINE);
  expect(agentAsk({ ...base, run: run() }).reason).toMatch(/working on this board/);
  expect(agentAsk({ ...base, offline: true }).reason).toBe("Needs a connection");
  expect(agentAsk({ ...base, read: false }).reason).toBe("Reading Atomik…");
  for (const input of [base, { ...base, planning: null }, { ...base, enabled: false }]) expect(agentAsk(input).label).not.toMatch(/quoted/i);
});

test("a run that ended or is only waiting is not open; a stopped one can be asked again", () => {
  expect(runOpen(null)).toBe(false);
  expect(runOpen(run({ state: "done" }))).toBe(false);
  expect(runOpen(run({ state: "stopped" }))).toBe(false);
  expect(runOpen(run({ state: "awaiting_approval" }))).toBe(true);
  expect(runNeedsYou(run({ state: "awaiting_approval" }))).toBe(true);
  expect(runNeedsYou(run({ state: "awaiting_approval", mine: false }))).toBe(false);
  expect(runNeedsYou(run({ state: "running" }))).toBe(false);
});

test("a render paused on the run's limit needs a raise to what its worst case is short of; none when nothing is paused on it", () => {
  const paused = { seq: 6, tool: "render" as const, title: "t", state: "paused" as const, quote: 8, worst: 24, pause: "limit" as const, charged: null, outcome: null, charge: null, reason: null, canRender: true, fingerprint: null };
  expect(raiseTarget(run({ paid: [paused] }))?.to).toBe(Math.ceil(14 + (24 - 13)));
  expect(raiseTarget(run({ paid: [{ ...paused, pause: "credits" }] }))).toBeNull();
  expect(raiseTarget(run())).toBeNull();
});

test("the build line counts the steps that are not the renders after it", () => {
  expect(buildLine(run({ steps: [{ seq: 1, label: "a", state: "done", held: [] }, { seq: 2, label: "b", state: "queued", held: [] }, { seq: 3, label: "c", state: "next", held: [] }] }))).toBe("Building · 1 of 2 steps");
  expect(buildLine(run())).toBeNull();
});
