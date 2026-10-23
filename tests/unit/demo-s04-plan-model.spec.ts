import { test, expect } from "@playwright/test";
import type { RigAgentPaidStepView, RigAgentRunView } from "../../lib/workbench/rig-agent-plan";
import {
  NOT_MINE, NO_PRICE, SHORT_LINE, SWITCHED_OFF, balanceLine, estimatePrice, fixLine, planModel, runStepPrice, type PlanInput,
} from "../../components/graphite/board/cards/plan/model";

/*
 * The plan card (design/particl-graphite/README.md § 3.1 e; CLAUDE.md rule 14): Atomik's durable run. Before the
 * build, Build · free; at the plan gate the server's total is the button and one approval covers the plan, fixes
 * included, up to 2 × that total; outside it a render asks at its own price.
 */

const FP = "a".repeat(64);
const step = (seq: number, title: string, over: Partial<RigAgentPaidStepView> = {}): RigAgentPaidStepView => ({
  seq, tool: "render", title, state: "next", quote: null, worst: null, pause: null, charged: null, outcome: null, charge: null,
  reason: null, canRender: false, fingerprint: null, ...over,
});
const verify = (seq: number, title: string): RigAgentPaidStepView => ({ ...step(seq, title), tool: "verify" });

function run(over: Partial<RigAgentRunView> = {}): RigAgentRunView {
  return {
    id: "rar_000000000000000000000001", state: "awaiting_approval", reason: null, goal: "Make the three shots", mine: true,
    proposal: { title: "Three shots", summary: "", groups: [], cards: 0, wires: 0, tidy: false, next: [], fingerprint: FP },
    steps: [], built: { cards: 0, wires: 0 }, held: [], undo: null, canUndo: false, credits: 14,
    money: { mode: "ask", limit: 14, spent: 14, inFlight: 0, left: 0, planning: { state: "settled", credits: 14 } },
    paid: [step(1, "Shot 1"), verify(2, "Shot 1"), step(3, "Shot 2"), verify(4, "Shot 2"), step(5, "Shot 3"), verify(6, "Shot 3")],
    at: 0, ...over,
  };
}
const estimates = { 1: { credits: 43, approximate: false }, 3: { credits: 43, approximate: false }, 5: { credits: 7, approximate: false } };
const base = (over: Partial<PlanInput> = {}): PlanInput => ({ run: run(), enabled: true, estimates, balance: 2000, readOnly: null, ...over });

test("before the gate (review L2) the proposal lists each take at the server's own quote, and adds nothing up: no total, no 'at most', no fix line, no balance after; Build · free only", () => {
  const m = planModel(base())!;
  expect(m.phase).toBe("proposal");
  expect(m.title).toBe("Make 3 shots");
  expect(m.steps.map((s) => [s.title, s.price, s.source])).toEqual([
    ["Shot 1", { kind: "exact", credits: 43 }, "estimate"],
    ["Shot 2", { kind: "exact", credits: 43 }, "estimate"],
    ["Shot 3", { kind: "exact", credits: 7 }, "estimate"],
  ]);
  /* The card never sums its own figures: they come only from the server's plan quote at the gate. */
  expect(m.total).toBeNull();
  expect(m.primary).toEqual({ kind: "approve", label: "Build · free", price: null, raiseTo: null, fingerprint: FP, blocked: null });
  expect(m.totalLine).toBeNull();
  expect(m.ceiling).toBeNull();
  expect(fixLine(m)).toBeNull();
  expect(m.balance).toBeNull();
  expect(balanceLine(m)).toBeNull();
  expect(m.title).not.toMatch(/at most|\d+ cr/);
  /* Whatever the estimates say, before the gate there is no figure to approve: the same with a short balance or an approximate engine. */
  for (const over of [{ balance: 50 }, { estimates: { ...estimates, 1: { credits: 43, approximate: true } } }] as Partial<PlanInput>[]) {
    const other = planModel(base(over))!;
    expect([other.total, other.ceiling, other.totalLine, fixLine(other), balanceLine(other), other.primary?.label]).toEqual([null, null, null, null, null, "Build · free"]);
  }
  /* Verify steps cost nothing today and are not on the card. */
  expect(m.steps).toHaveLength(3);
});

test("Build never raises the run's limit from the browser: the plan's one approval sets it on the server", () => {
  /* Limit 14, all spent on thinking: still no raise. */
  expect(planModel(base())!.primary).toMatchObject({ kind: "approve", raiseTo: null });
});

const GATE_FP = "b".repeat(64);
/** The plan gate: built, every render priced by the server, the server's quote waiting for the one approval. */
function gate(over: Partial<RigAgentRunView> = {}): RigAgentRunView {
  return run({
    state: "needs_you", reason: "Shot 1 is ready to render · about 43 cr.",
    paid: [
      step(1, "Shot 1", { state: "waiting", quote: 43, worst: 43, canRender: true, fingerprint: FP }), verify(2, "Shot 1"),
      step(3, "Shot 2", { state: "waiting", quote: 43, worst: 43, canRender: true, fingerprint: FP }), verify(4, "Shot 2"),
      step(5, "Shot 3", { state: "waiting", quote: 7, worst: 7, canRender: true, fingerprint: FP }), verify(6, "Shot 3"),
    ],
    plan: { quote: { total: 93, ceiling: 186, approximate: false, fingerprint: GATE_FP, covered: [1, 3, 5] }, blocked: null, approval: null },
    ...over,
  });
}

test("the plan gate: the title and the button are the server's figures, Make 3 shots · 93 cr · at most 186 cr, and Approve · 93 cr sends its quote", () => {
  /* The browser's own pre-quotes say otherwise: the card shows the server's quote, never its own sum. */
  const m = planModel(base({ run: gate(), estimates: { 1: { credits: 1, approximate: false } } }))!;
  expect(m.phase).toBe("proposal");
  expect(m.title).toBe("Make 3 shots · 93 cr · at most 186 cr");
  expect(m.total).toEqual({ kind: "exact", credits: 93 });
  expect(m.ceiling).toBe(186);
  expect(m.primary).toEqual({ kind: "plan", label: "Approve · 93 cr", price: { kind: "exact", credits: 93 }, fingerprint: GATE_FP, blocked: null });
  expect(fixLine(m)).toBe("Fixes if needed: up to 2 per shot, within 186 cr");
  expect(balanceLine(m)).toBe("1,907 cr left after");
  expect(m.modeLine).toBe("One approval covers the shots and up to 2 fixes each; anything else asks.");
  /* Short of the total: Approve waits. Someone else's plan: theirs. */
  expect(planModel(base({ run: gate(), balance: 50 }))!.primary?.blocked).toBe(SHORT_LINE);
  expect(planModel(base({ run: gate({ mine: false }) }))!.primary?.blocked).toBe(NOT_MINE);
  /* An approximate engine: up to. No render asks on its own for an admin (the admin approval rule was retired on 21 Oct 2026), so the button is never "the rest". */
  const approx = planModel(base({ run: gate({ plan: { quote: { total: 179, ceiling: 358, approximate: true, fingerprint: GATE_FP, covered: [1, 3, 5] }, blocked: null, approval: null } }) }))!;
  expect(approx.title).toBe("Make 3 shots · up to 179 cr · at most 358 cr");
  expect(approx.primary).toMatchObject({ kind: "plan", label: "Approve · up to 179 cr" });
  expect(JSON.stringify(approx)).not.toMatch(/needs an admin|Approve the rest/);
  /* No step is ever said to be over a per-render line. */
  expect(JSON.stringify(approx)).not.toMatch(/per-render line|over 200 cr/);
});

test("after the plan's approval: what it has used of its ceiling, and a render outside it asks at its own price", () => {
  const approval = { mine: true, at: 1, expiresAt: 2, total: 93, ceiling: 186, approximate: false, used: 43, fixes: {}, maxFixes: 2, open: true, closedReason: null };
  const m = planModel(base({ run: gate({ state: "running", plan: { quote: null, blocked: null, approval } }) }))!;
  expect(m.title).toBe("Making 3 shots");
  expect(m.total).toEqual({ kind: "exact", credits: 93, capped: true });
  expect(fixLine(m)).toBe("43 cr of 186 cr used · fixes up to 2 per shot");
  expect(m.modeLine).toBe("Inside the approved plan nothing asks again; anything outside it asks at its price.");
  expect(m.primary).toBeNull();
  const asks = planModel(base({ run: gate({ state: "needs_you", plan: { quote: null, blocked: null, approval } }) }))!;
  expect(asks.primary).toMatchObject({ kind: "render", label: "Render · 43 cr" });
  /* An approximate plan keeps "up to" after its approval, as at the gate (review L3). */
  const approx = planModel(base({ run: gate({ state: "running", plan: { quote: null, blocked: null, approval: { ...approval, total: 179, ceiling: 358, approximate: true } } }) }))!;
  expect(approx.total).toEqual({ kind: "up-to", credits: 179, capped: true });
});

test("a keyframe still is priced on its own line and marked a still", () => {
  const m = planModel(base({
    run: run({ paid: [step(1, "Keyframes"), step(2, "Hero take"), step(3, "Draft takes")] }),
    estimates: { 1: { credits: 9, approximate: false }, 2: { credits: 43, approximate: false }, 3: { credits: 14, approximate: false } },
    stills: new Set([1]),
  }))!;
  expect(m.steps.map((s) => s.price)).toEqual([{ kind: "exact", credits: 9 }, { kind: "exact", credits: 43 }, { kind: "exact", credits: 14 }]);
  expect(m.steps[0].kind).toBe("still");
});

test("an engine that settles on what the provider states reads up to its band on its line", () => {
  expect(estimatePrice({ credits: 43, approximate: true })).toEqual({ kind: "up-to", credits: 129 });
  const m = planModel(base({ estimates: { ...estimates, 1: { credits: 43, approximate: true } } }))!;
  expect(m.steps[0].price).toEqual({ kind: "up-to", credits: 129 });
  expect(m.primary).toMatchObject({ label: "Build · free" });
});

test("a take with no price yet leaves the total, the allowance and the raise unknown: Approve carries no figure", () => {
  const m = planModel(base({ estimates: { 1: estimates[1], 3: estimates[3] } }))!;
  expect(m.steps[2].price).toBeNull();
  expect(m.total).toBeNull();
  expect(m.ceiling).toBeNull();
  expect(fixLine(m)).toBeNull();
  expect(m.primary).toMatchObject({ kind: "approve", label: "Build · free", raiseTo: null });
  expect(balanceLine(m)).toBeNull();
});

test("an unavailable engine says why and carries no price", () => {
  const m = planModel(base({ estimates: { ...estimates, 5: { unavailable: "no key for this engine" } } }))!;
  expect(m.steps[2].unavailable).toBe("Unavailable · no key for this engine");
  expect(m.steps[2].price).toBeNull();
});

test("no step is marked for an admin and no rule line is shown: the per-shot rule was retired on 21 Oct 2026", () => {
  const m = planModel(base())!;
  for (const s of m.steps) for (const gone of ["needsAdmin", "asksAlone"]) expect(s, gone).not.toHaveProperty(gone);
  for (const gone of ["ruleLine", "adminLine"]) expect(m, gone).not.toHaveProperty(gone);
  expect(JSON.stringify(m)).not.toMatch(/needs an admin|an admin above/i);
});

test("only the person who asked builds, never while switched off or read-only; the balance is not judged before the plan is priced", () => {
  expect(planModel(base({ run: run({ mine: false }) }))!.primary?.blocked).toBe(NOT_MINE);
  expect(planModel(base({ enabled: false }))!.primary?.blocked).toBe(SWITCHED_OFF);
  expect(planModel(base({ readOnly: "Sample production · nothing you do here spends credits" }))!.primary?.blocked).toBe("Sample production · nothing you do here spends credits");
  /* Building spends nothing, so it is not held back by the balance; the plan's Approve is, at the gate (above). */
  const short = planModel(base({ balance: 50 }))!;
  expect(short.primary?.blocked).toBeNull();
  expect(short.balance).toBeNull();
  expect(balanceLine(short)).toBeNull();
});

test("a run with no plan approval (built before it, or a tap per render) still asks each render at its own price, in its own words", () => {
  const waiting = run({ state: "needs_you", reason: "Shot 1 is ready to render · about 43 cr.", paid: [
    step(1, "Shot 1", { state: "waiting", quote: 43, worst: 43, canRender: true, fingerprint: FP }), step(3, "Shot 2"), step(5, "Shot 3"),
  ] });
  const m = planModel(base({ run: waiting }))!;
  expect(m.title).toBe("Making 3 shots");
  expect(m.primary).toEqual({ kind: "render", label: "Render · 43 cr", price: { kind: "exact", credits: 43 }, seq: 1, fingerprint: FP, blocked: null });
  expect(m.steps[0].source).toBe("run");
  expect(m.note).toBe("Shot 1 is ready to render · about 43 cr.");
  /* The same tap for someone else's run is theirs. */
  const theirs = planModel(base({ run: { ...waiting, mine: false, paid: waiting.paid.map((p) => ({ ...p, canRender: false })) } }))!;
  expect(theirs.primary?.blocked).toBe(NOT_MINE);
});

test("a paused render: Retry at its price, Price again when it has none, Raise when the limit is reached", () => {
  const paused = (over: Partial<RigAgentPaidStepView>) => planModel(base({ run: run({ state: "needs_you", paid: [step(1, "Shot 1", { state: "paused", canRender: true, ...over })] }) }))!;
  expect(paused({ pause: "credits", quote: 43, worst: 43, fingerprint: FP }).primary).toMatchObject({ kind: "render", label: "Retry · 43 cr" });
  expect(paused({ pause: "unpriced" }).primary).toMatchObject({ kind: "render", label: "Price again", price: null });
  const limit = planModel(base({ run: run({ state: "needs_you", money: { mode: "ask", limit: 14, spent: 14, inFlight: 0, left: 0, planning: { state: "settled", credits: 14 } },
    paid: [step(1, "Shot 1", { state: "paused", pause: "limit", quote: 43, worst: 43, canRender: true, fingerprint: FP })] }) }))!;
  expect(limit.primary).toEqual({ kind: "raise", label: "Raise the limit to 57 cr", raiseTo: 57, blocked: null });
});

test("a tap that renders always shows its price: a waiting or paused render with none is not offered, and never reads Price again (which only prices afresh)", () => {
  const one = (over: Partial<RigAgentPaidStepView>) => planModel(base({ estimates: {}, run: run({ state: "needs_you", paid: [step(1, "Shot 1", { canRender: true, fingerprint: FP, ...over })] }) }))!;
  for (const over of [{ state: "waiting" }, { state: "paused", pause: "credits" }] as Partial<RigAgentPaidStepView>[]) {
    const m = one(over);
    expect(m.primary, JSON.stringify(over)).toMatchObject({ kind: "render", price: null, blocked: NO_PRICE });
    expect(m.primary?.label, JSON.stringify(over)).not.toBe("Price again");
  }
  /* Price again is only for a render paused unpriced, or on its record: the server prices it afresh and sends nothing. */
  expect(one({ state: "paused", pause: "record" }).primary).toMatchObject({ label: "Price again", price: null, blocked: null });
});

test("a chips plan (Agent mode's quick plan) has ONE price: no pre-quote of any step; a covered step shows none of its own; one outside the plan shows the server's", () => {
  const chips = gate({ kind: "chips", paid: [
    step(1, "Shot 1", { state: "waiting", canRender: true, fingerprint: FP }),
    step(3, "Shot 2", { state: "waiting", quote: 250, worst: 250, canRender: true, fingerprint: FP }),
  ], plan: { quote: { total: 43, ceiling: 86, approximate: false, fingerprint: GATE_FP, covered: [1] }, blocked: null, approval: null } });
  const m = planModel(base({ run: chips }))!;
  expect(m.steps.map((s) => [s.price, s.source])).toEqual([[null, "plan"], [{ kind: "exact", credits: 250 }, "run"]]);
  expect(m.primary).toMatchObject({ kind: "plan", label: "Approve · 43 cr" });
  /* After the approval: a step the server says the plan covers (planPriced) shows no price of its own until it settles. */
  const approved = run({ kind: "chips", state: "running", paid: [
    step(1, "Shot 1", { state: "rendering", inPlan: true, planPriced: true }),
    step(3, "Shot 2", { state: "done", quote: 7, worst: 7, charged: 7, inPlan: true }),
    step(5, "Shot 3", { state: "waiting", planPriced: true, fingerprint: FP }),
  ] });
  expect(planModel(base({ run: approved }))!.steps.map((s) => [s.price, s.source])).toEqual([[null, "plan"], [{ kind: "exact", credits: 7 }, "settled"], [null, "plan"]]);
});

test("a chips plan's step that pauses after the approval keeps its own price and its button: Retry · N cr for credits or a refusal, Raise for the limit (an in-plan step keeps the approval's id when it pauses)", () => {
  const money = { mode: "ask" as const, limit: 100, spent: 80, inFlight: 0, left: 20, planning: null };
  const paused = (pause: RigAgentPaidStepView["pause"]) => planModel(base({ estimates: {}, run: run({ kind: "chips", state: "needs_you", money, paid: [
    step(1, "Shot 1", { state: "done", quote: 40, worst: 40, charged: 40, inPlan: true }),
    step(3, "Shot 2", { state: "paused", pause, quote: 43, worst: 43, canRender: true, fingerprint: FP, inPlan: true }),
  ] }) }))!;
  for (const pause of ["credits", "refused"] as const) {
    const m = paused(pause);
    expect(m.steps[1].price, pause).toEqual({ kind: "exact", credits: 43 });
    expect(m.primary, pause).toMatchObject({ kind: "render", label: "Retry · 43 cr", price: { kind: "exact", credits: 43 }, seq: 3, fingerprint: FP, blocked: null });
  }
  const limit = paused("limit");
  expect(limit.steps[1].price).toEqual({ kind: "exact", credits: 43 });
  expect(limit.primary).toEqual({ kind: "raise", label: "Raise the limit to 123 cr", raiseTo: 123, blocked: null });
});

test("finished steps say what they settled at, or what the provider did with a failure", () => {
  const m = planModel(base({ run: run({ state: "running", paid: [
    step(1, "Shot 1", { state: "done", quote: 43, worst: 43, charged: 41 }),
    step(3, "Shot 2", { state: "failed", outcome: "not_billed", charge: { credits: 0, settled: true } }),
    step(5, "Shot 3", { state: "rendering", quote: 7, worst: 7 }),
  ] }) }))!;
  expect(m.steps.map((s) => s.status)).toEqual(["Rendered · 41 cr settled", "Failed · nothing billed", "Rendering"]);
  expect(runStepPrice(step(1, "x", { state: "done", charged: 41 }))).toEqual({ kind: "exact", credits: 41 });
  expect(runStepPrice(step(1, "x", { state: "waiting", quote: 43, worst: 129 }))).toEqual({ kind: "up-to", credits: 129 });
  expect(m.primary).toBeNull();
});

test("the thinking and the way renders ask are said plainly", () => {
  const m = planModel(base())!;
  expect(m.thinking).toBe("Thinking · 14 cr · billed when Atomik planned it");
  expect(m.modeLine).toBe("One approval covers the shots and up to 2 fixes each; anything else asks.");
  /* No Auto (owner, 20 Oct 2026): a run the server stored as "auto" is sent as "ask", and the card never says a render goes without asking. */
  const once = planModel(base({ run: run({ money: { mode: "ask", limit: 300, spent: 14, inFlight: 0, left: 286, planning: { state: "released", credits: null } } }) }))!;
  expect(once.modeLine).toBe("One approval covers the shots and up to 2 fixes each; anything else asks.");
  expect(once.thinking).toBe("Thinking · not billed");
  expect(planModel(base({ run: run({ state: "running" }) }))!.modeLine).not.toMatch(/without asking/);
});

test("no run, no card; a build with no renders is free to approve", () => {
  expect(planModel(base({ run: null }))).toBeNull();
  const build = planModel(base({ run: run({ paid: [] }) }))!;
  expect(build.title).toBe("Three shots");
  expect(build.total).toEqual({ kind: "free" });
  expect(build.primary).toMatchObject({ label: "Approve · free" });
  expect(build.ceiling).toBeNull();
  expect(build.modeLine).toBeNull();
});

test("no word on the card is the bare 'quoted' or 'about'", () => {
  const texts = (m: ReturnType<typeof planModel>) => JSON.stringify(m);
  for (const m of [planModel(base()), planModel(base({ estimates: { ...estimates, 1: { credits: 43, approximate: true } } }))])
    expect(texts(m)).not.toMatch(/\bquoted\b|\babout\b/);
});

test("the explore-only sample's plan: the guest sample's three shots at 43, 43 and 7 cr, Make 3 shots · 93 cr · at most 186 cr, and nothing can be pressed", async () => {
  const { samplePlanModel, samplePlanCard } = await import("../../components/graphite/board/cards/plan/sample");
  const line = "Sample production · nothing you do here spends credits";
  const m = samplePlanModel([
    { title: "Shot 1", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43 }, { title: "Shot 2", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43 },
    { title: "Shot 3", meta: "Kling 3.0 Standard · 5 s", credits: 7 },
  ], line);
  expect(m.title).toBe("Make 3 shots · 93 cr · at most 186 cr");
  expect(m.total).toEqual({ kind: "exact", credits: 93 });
  expect(m.totalLine).toBe("93 cr for the 3 shots");
  expect(m.ceiling).toBe(186);
  expect(fixLine(m)).toBe("Fixes if needed: up to 2 per shot, within 186 cr");
  expect(m.balance).toBeNull();
  expect(m.primary).toMatchObject({ kind: "plan", label: "Approve · 93 cr", blocked: line });
  /* Plain data, no style ids and no placeholder names in a row. */
  expect(JSON.stringify(m)).not.toMatch(/SH\d|Mira|Northline|Dune/);
  const card = samplePlanCard(m);
  expect(card).toMatchObject({ id: "plan:sample", kind: "plan", region: "storyboard", group: "group:storyboard" });
  expect(JSON.parse(JSON.stringify(card))).toEqual(card);
  /* At most twice the total, stills included (66 → 132). */
  const stills = samplePlanModel([{ title: "Keyframes", meta: "", credits: 9, kind: "still" }, { title: "Hero", meta: "", credits: 43 }, { title: "Draft", meta: "", credits: 14 }], line);
  expect([stills.total, stills.ceiling]).toEqual([{ kind: "exact", credits: 66 }, 132]);
  expect(samplePlanModel([], line).total).toEqual({ kind: "free" });
});
