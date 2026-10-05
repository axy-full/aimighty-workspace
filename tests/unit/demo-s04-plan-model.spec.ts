import { test, expect } from "@playwright/test";
import type { RigAgentPaidStepView, RigAgentRunView } from "../../lib/workbench/rig-agent-plan";
import {
  NOT_MINE, SHORT_LINE, SWITCHED_OFF, balanceLine, estimatePrice, fixLine, planModel, runStepPrice, type PlanInput,
} from "../../components/graphite/board/cards/plan/model";

/*
 * The plan card (design/particl-graphite/README.md § 3.1 e; lead decisions 27 and 28): Atomik's durable run,
 * approved by the person who asked; each render then asks at its price; the fix allowance is information only.
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
    money: { mode: "ask", limit: 14, jobCeiling: 200, spent: 14, inFlight: 0, left: 0, planning: { state: "settled", credits: 14 } },
    paid: [step(1, "Shot 1"), verify(2, "Shot 1"), step(3, "Shot 2"), verify(4, "Shot 2"), step(5, "Shot 3"), verify(6, "Shot 3")],
    at: 0, ...over,
  };
}
const estimates = { 1: { credits: 43, approximate: false }, 3: { credits: 43, approximate: false }, 5: { credits: 7, approximate: false } };
const base = (over: Partial<PlanInput> = {}): PlanInput => ({ run: run(), enabled: true, estimates, balance: 2000, rule: null, readOnly: null, ...over });

test("the proposal lists every take at the server's price, the total as a line, the fix allowance and the balance after", () => {
  const m = planModel(base())!;
  expect(m.phase).toBe("proposal");
  expect(m.title).toBe("Make 3 shots");
  expect(m.steps.map((s) => [s.title, s.price, s.source])).toEqual([
    ["Shot 1", { kind: "exact", credits: 43 }, "estimate"],
    ["Shot 2", { kind: "exact", credits: 43 }, "estimate"],
    ["Shot 3", { kind: "exact", credits: 7 }, "estimate"],
  ]);
  expect(m.total).toEqual({ kind: "exact", credits: 93 });
  /* The button carries no figure: approving builds (free) and each render asks at its own price. The total is a line. */
  expect(m.primary).toMatchObject({ kind: "approve", label: "Approve", price: null, fingerprint: FP, blocked: null });
  expect(m.totalLine).toBe("93 cr for the 3 shots");
  /* 2 × the take prices, never added to the total (decision 28: 93 → 186). */
  expect(m.fixAllowance).toBe(186);
  expect(fixLine(m)).toBe("Fixes if needed: up to 2 per shot, at most 186 cr");
  expect(balanceLine(m)).toBe("1,907 cr left after");
  /* Verify steps cost nothing today and are not on the card. */
  expect(m.steps).toHaveLength(3);
});

test("Approve raises the run's limit first when it is short of the takes' worst case", () => {
  /* Limit 14, all spent on thinking: the takes need 93 more. */
  const m = planModel(base())!;
  expect(m.primary).toMatchObject({ kind: "approve", raiseTo: 107 });
  /* A limit that already holds them is left alone. */
  const roomy = planModel(base({ run: run({ money: { mode: "ask", limit: 200, jobCeiling: 200, spent: 14, inFlight: 0, left: 186, planning: { state: "settled", credits: 14 } } }) }))!;
  expect(roomy.primary).toMatchObject({ kind: "approve", raiseTo: null });
});

test("a keyframe still is priced and totalled but left out of the fix allowance (66 → 114)", () => {
  const m = planModel(base({
    run: run({ paid: [step(1, "Keyframes"), step(2, "Hero take"), step(3, "Draft takes")] }),
    estimates: { 1: { credits: 9, approximate: false }, 2: { credits: 43, approximate: false }, 3: { credits: 14, approximate: false } },
    stills: new Set([1]),
  }))!;
  expect(m.total).toEqual({ kind: "exact", credits: 66 });
  expect(m.fixAllowance).toBe(114);
  expect(m.steps[0].kind).toBe("still");
});

test("an engine that settles on what the provider states reads up to its band, and so does the total", () => {
  expect(estimatePrice({ credits: 43, approximate: true })).toEqual({ kind: "up-to", credits: 129 });
  const m = planModel(base({ estimates: { ...estimates, 1: { credits: 43, approximate: true } } }))!;
  expect(m.total).toEqual({ kind: "up-to", credits: 179 });
  expect(m.primary).toMatchObject({ label: "Approve" });
  expect(m.totalLine).toBe("up to 179 cr for the 3 shots");
  expect(m.fixAllowance).toBe(358);
});

test("a take with no price yet leaves the total, the allowance and the raise unknown: Approve carries no figure", () => {
  const m = planModel(base({ estimates: { 1: estimates[1], 3: estimates[3] } }))!;
  expect(m.steps[2].price).toBeNull();
  expect(m.total).toBeNull();
  expect(m.fixAllowance).toBeNull();
  expect(fixLine(m)).toBeNull();
  expect(m.primary).toMatchObject({ kind: "approve", label: "Approve", raiseTo: null });
  expect(balanceLine(m)).toBeNull();
});

test("an unavailable engine says why and is left out of the total", () => {
  const m = planModel(base({ estimates: { ...estimates, 5: { unavailable: "no key for this engine" } } }))!;
  expect(m.steps[2].unavailable).toBe("Unavailable · no key for this engine");
  expect(m.total).toEqual({ kind: "exact", credits: 86 });
});

test("the per-shot rule marks the steps over it, worded by role", () => {
  const m = planModel(base({ rule: { rule: "cap", cap: 40, admin: false } }))!;
  expect(m.steps.map((s) => s.needsAdmin)).toEqual([true, true, false]);
  expect(m.ruleLine).toBe("Members up to 40 cr a shot; an admin above it.");
  expect(planModel(base({ rule: { rule: "anyone", cap: 50, admin: false } }))!.ruleLine).toBeNull();
});

test("only the person who asked approves, never while switched off, read-only or short", () => {
  expect(planModel(base({ run: run({ mine: false }) }))!.primary?.blocked).toBe(NOT_MINE);
  expect(planModel(base({ enabled: false }))!.primary?.blocked).toBe(SWITCHED_OFF);
  expect(planModel(base({ readOnly: "Sample production · nothing you do here spends credits" }))!.primary?.blocked).toBe("Sample production · nothing you do here spends credits");
  const short = planModel(base({ balance: 50 }))!;
  expect(short.primary?.blocked).toBe(SHORT_LINE);
  expect(short.balance?.short).toBe(43);
  expect(balanceLine(short)).toBe("Short by 43 cr");
});

test("after approval each render asks at its own price, in its own words", () => {
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
  const limit = planModel(base({ run: run({ state: "needs_you", money: { mode: "ask", limit: 14, jobCeiling: 200, spent: 14, inFlight: 0, left: 0, planning: { state: "settled", credits: 14 } },
    paid: [step(1, "Shot 1", { state: "paused", pause: "limit", quote: 43, worst: 43, canRender: true, fingerprint: FP })] }) }))!;
  expect(limit.primary).toEqual({ kind: "raise", label: "Raise the limit to 57 cr", raiseTo: 57, blocked: null });
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
  expect(m.modeLine).toBe("Each shot asks at its price before it renders.");
  const auto = planModel(base({ run: run({ money: { mode: "auto", limit: 300, jobCeiling: 200, spent: 14, inFlight: 0, left: 286, planning: { state: "released", credits: null } } }) }))!;
  expect(auto.modeLine).toBe("Drafts up to 200 cr each render without asking; anything else asks.");
  expect(auto.thinking).toBe("Thinking · not billed");
});

test("no run, no card; a build with no renders is free to approve", () => {
  expect(planModel(base({ run: null }))).toBeNull();
  const build = planModel(base({ run: run({ paid: [] }) }))!;
  expect(build.title).toBe("Three shots");
  expect(build.total).toEqual({ kind: "free" });
  expect(build.primary).toMatchObject({ label: "Approve · free" });
  expect(build.fixAllowance).toBeNull();
  expect(build.modeLine).toBeNull();
});

test("no word on the card is the bare 'quoted' or 'about'", () => {
  const texts = (m: ReturnType<typeof planModel>) => JSON.stringify(m);
  for (const m of [planModel(base()), planModel(base({ estimates: { ...estimates, 1: { credits: 43, approximate: true } } }))])
    expect(texts(m)).not.toMatch(/\bquoted\b|\babout\b/);
});
