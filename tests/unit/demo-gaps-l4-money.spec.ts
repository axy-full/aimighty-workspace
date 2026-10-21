import { test, expect } from "@playwright/test";
import type { RigAgentPaidStepView, RigAgentRunView } from "../../lib/workbench/rig-agent-plan";
import { planModel, type PlanInput } from "../../components/graphite/board/cards/plan/model";
import { planLineKey, planMoneyState } from "../../components/graphite/board/cards/plan/money-state";
import * as budgetPauseModule from "../../lib/budgetPause";
import { budgetPause, cleanBudget, cleanWarnPct, planBudgetLine } from "../../lib/budgetPause";
import { settingProblem } from "../../lib/settingValues";
import { DEFAULTS } from "../../lib/settings";
import { budgetHelp, budgetLine, budgetPatch, digits } from "../../components/graphite/settings/rules/budget-words";
import { retryQuoteBody } from "../../lib/workspace/retry-request";
import { creditsText } from "../../lib/shell/price-words";
import type { Generation } from "../../lib/jobs";

/*
 * Gap screens, lane 4 (money): the board's money states and Settings › Spending rules › Budget and cap, held to the
 * code. Every figure in these states is the server's (the plan's quotes, the budget read, the pack list); these check
 * the words and the arithmetic. Neutral names only. Owner values (6 Oct): sample budget 400 cr with the warning at 320 cr.
 * Retired on 21 Oct 2026 (owner): the per-shot admin cap and its "needs an admin" state ("the admin approval rule is retired;
 * every member approves their own spend with their own tap on the quote"), and the Paused card ("The monthly limit stays as a
 * mechanism, off by default, owner-only, no Paused card").
 */

const FP = "b".repeat(64);
const step = (seq: number, title: string, over: Partial<RigAgentPaidStepView> = {}): RigAgentPaidStepView => ({
  seq, tool: "render", title, state: "next", quote: null, worst: null, pause: null, charged: null, outcome: null, charge: null,
  reason: null, canRender: false, fingerprint: null, ...over,
});
function run(over: Partial<RigAgentRunView> = {}): RigAgentRunView {
  return {
    id: "rar_000000000000000000000009", state: "awaiting_approval", reason: null, goal: "A 15-second film", mine: true,
    proposal: { title: "Three shots", summary: "", groups: [], cards: 0, wires: 0, tidy: false, next: [], fingerprint: FP },
    steps: [], built: { cards: 0, wires: 0 }, held: [], undo: null, canUndo: false, credits: 9,
    money: { mode: "ask", limit: 500, spent: 9, inFlight: 0, left: 491, planning: { state: "settled", credits: 9 } },
    paid: [step(1, "Shot 1"), step(2, "Shot 2"), step(3, "Shot 3")], at: 0, ...over,
  };
}
const quoted = { 1: { credits: 43, approximate: false }, 2: { credits: 43, approximate: false }, 3: { credits: 7, approximate: false } };
const input = (over: Partial<PlanInput> = {}): PlanInput => ({ run: run(), enabled: true, estimates: quoted, balance: 2000, readOnly: null, ...over });
const money = (plan: PlanInput, over: Partial<Parameters<typeof planMoneyState>[0]> = {}) =>
  planMoneyState({ model: planModel(plan)!, topUp: "Top up · 500 cr · $50", ...over });

/* ── Short ─────────────────────────────────────────────────────────────── */

/** The plan gate (plan approval, lib/workbench/plan-approval.ts): built, each render priced by the run, the server's quote waiting. */
const atGate = (prices: [number, number, number]) => {
  const total = prices.reduce((a, b) => a + b, 0);
  return run({
    state: "needs_you", proposal: null, reason: "Shot 1 is ready to render.",
    paid: prices.map((q, i) => step(i + 1, `Shot ${i + 1}`, { state: "waiting", quote: q, worst: q, canRender: true, fingerprint: FP })),
    plan: { quote: { total, ceiling: 2 * total, approximate: false, fingerprint: "d".repeat(64), covered: prices.map((_, i) => i + 1) }, blocked: null, approval: null },
  });
};

test("short, at the plan gate: the server's 93 cr against a 40 cr balance is short by 53 cr; Approve · 93 cr waits and Top up is offered beside it", () => {
  const plan = input({ run: atGate([43, 43, 7]), balance: 40 });
  const model = planModel(plan)!;
  expect(model.total).toEqual({ kind: "exact", credits: 93 });
  /* Approve waits: it is blocked with the short line, never pressed through. */
  expect(model.primary).toMatchObject({ kind: "plan", label: "Approve · 93 cr", blocked: "Top up, then approve. Nothing is spent until you do." });
  expect(money(plan)).toEqual({ kind: "short", line: "Short by 53 cr", topUp: "Top up · 500 cr · $50" });
  /* The pack words come from the platform's list; with none read, plain "Top up". */
  expect(money(plan, { topUp: "Top up" })).toMatchObject({ topUp: "Top up" });
  /* Enough: no money state; exactly the total is enough. */
  expect(money(input({ run: atGate([43, 43, 7]), balance: 93 }))).toBeNull();
  /* Before the gate (Build · free) the card adds nothing up, so there is nothing to be short of. */
  expect(money(input({ balance: 40 }))).toBeNull();
});

test("no step needs an admin at the plan gate (retired 21 Oct 2026): an 86 cr shot is in the total like the rest, and Approve covers all three", () => {
  const plan = input({ run: atGate([86, 43, 7]) });
  const model = planModel(plan)!;
  expect(model.primary).toMatchObject({ kind: "plan", label: "Approve · 136 cr" });
  expect(money(plan)).toBeNull();
  expect(JSON.stringify(model)).not.toMatch(/needs an admin|Approve the rest/);
});

/* ── No admin state ────────────────────────────────────────────────────── */

test("a shot over what a workspace once stored as its per-shot cap has no admin state: 86 cr is its price, nothing more; no default cap is left", () => {
  const plan = input({ estimates: { ...quoted, 1: { credits: 86, approximate: false } } });
  expect(money(plan)).toBeNull();
  expect(money(plan, { approvePriced: true })).toBeNull();
  for (const gone of ["approvalRule", "shotCapCredits"]) expect(DEFAULTS, gone).not.toHaveProperty(gone);
});

/* ── Engine unavailable ────────────────────────────────────────────────── */

test("unavailable: the server's reason; Move Shot 3 to the plan's other engine at that engine's quote, or approve the rest", () => {
  const plan = input({ estimates: { ...quoted, 3: { unavailable: "no key on this workspace" } } });
  const model = planModel(plan)!;
  expect(model.steps[2].unavailable).toBe("Unavailable · no key on this workspace");
  const offer = { seq: 3, engine: "dreamina-seedance-2-5-260628", engineLabel: "Seedance 2.5", price: { kind: "exact" as const, credits: 43 } };
  expect(money(plan, { move: offer })).toEqual({
    kind: "unavailable", line: "Shot 3 can't render · no key on this workspace", seq: 3,
    restLine: "The rest: 2 shots · 86 cr", approveLabel: "Approve 2 shots", rest: { kind: "exact", credits: 86 },
    move: { label: "Move Shot 3 to Seedance 2.5 · 43 cr", price: { kind: "exact", credits: 43 }, seq: 3, engine: "dreamina-seedance-2-5-260628" },
  });
  expect(money(plan, { move: offer, approvePriced: true })).toMatchObject({ approveLabel: "Approve 2 shots · 86 cr" });
  /* No quote for the other engine yet (or none at all): no Move button, never a guessed price. */
  expect(money(plan, { move: { ...offer, price: null } })).toMatchObject({ move: null });
  expect(money(plan)).toMatchObject({ move: null });
  /* An offer for another step is not this step's. */
  expect(money(plan, { move: { ...offer, seq: 2 } })).toMatchObject({ move: null });
});

/* ── A take failed ─────────────────────────────────────────────────────── */

test("failed: Nothing billed only where the ledger says the provider billed nothing; charged says what; otherwise not known yet", () => {
  const working = (s2: Partial<RigAgentPaidStepView>) => input({ run: run({ state: "running", proposal: null, paid: [step(1, "Shot 1", { state: "done", charged: 43 }), step(2, "Shot 2", { state: "failed", ...s2 }), step(3, "Shot 3", { state: "rendering", quote: 7 })] }) });
  expect(money(working({ outcome: "not_billed" }))).toEqual({ kind: "failed", seq: 2, nothingBilled: true, line: "Shot 2 failed · Nothing billed" });
  expect(money(working({ outcome: "charged", charge: { credits: 43, settled: true } }))).toEqual({ kind: "failed", seq: 2, nothingBilled: false, line: "Shot 2 failed · charged 43 cr" });
  /* A charge the ledger holds that the provider has not answered for is not called "charged", and never "nothing billed". */
  for (const s of [{ outcome: "unknown" as const, charge: { credits: 43, settled: false } }, { outcome: null }]) {
    const state = money(working(s));
    expect(state).toMatchObject({ kind: "failed", nothingBilled: false, line: "Shot 2 failed · what it was charged isn't known yet" });
  }
});

/* ── No Paused card (owner, 21 Oct 2026) ───────────────────────────────── */

/* A render's reason Auto's budget ask wrote before 20 Oct 2026: it stays on the record, and no card is drawn from it any more. */
const ASK = "Paused at 80 % of the budget: 320 of 400 cr used. Continue or stop. Shot 3 is next · about 7 cr.";
const waitingRun = (quote = 7, reason: string | null = ASK) => run({
  state: "needs_you", proposal: null, reason,
  paid: [step(1, "Shot 1", { state: "done", charged: 43 }), step(2, "Shot 2", { state: "done", charged: 43 }), step(3, "Shot 3", { state: "waiting", quote, canRender: true, fingerprint: FP, reason })],
});

test("no Paused card: 320 of a 400 cr budget used and a render waiting with the old budget-ask reason is its own tap at its price, with no paused state", () => {
  for (const reason of [ASK, "Shot 3 is ready to render · about 7 cr.", null]) {
    const plan = input({ run: waitingRun(7, reason), meta: { 3: "Kling 3.0 Standard · 5 s" } });
    expect(money(plan), String(reason)).toBeNull();
    expect(planModel(plan)!.primary).toMatchObject({ kind: "render", seq: 3, label: "Render · 7 cr", price: { kind: "exact", credits: 7 } });
  }
  /* Nothing writes or reads the pause's line any more. */
  for (const gone of ["budgetPauseLine", "isBudgetPauseReason"]) expect(budgetPauseModule, gone).not.toHaveProperty(gone);
});

test("the plan gate's budget line is read again when the plan is re-priced or the run's spend moves; off the gate there is nothing to read", () => {
  const gate = planModel(input({ run: atGate([43, 43, 7]) }))!;
  const key = planLineKey(gate.primary, { spent: 9, inFlight: 0 });
  expect(key).not.toBeNull();
  /* Re-priced: a new fingerprint is a new key. */
  const repriced = planModel(input({ run: run({ ...atGate([43, 43, 7]), plan: { ...atGate([43, 43, 7]).plan!, quote: { ...atGate([43, 43, 7]).plan!.quote!, fingerprint: "e".repeat(64) } } }) }))!;
  expect(planLineKey(repriced.primary, { spent: 9, inFlight: 0 })).not.toBe(key);
  /* Spend moved (settled or held): a new key. The same figures: the same key. */
  expect(planLineKey(gate.primary, { spent: 52, inFlight: 0 })).not.toBe(key);
  expect(planLineKey(gate.primary, { spent: 9, inFlight: 43 })).not.toBe(key);
  expect(planLineKey(gate.primary, { spent: 9, inFlight: 0 })).toBe(key);
  /* Off the gate (a render's tap, or no model): null, and the hook reads nothing. */
  expect(planLineKey(planModel(input({ run: waitingRun() }))!.primary, { spent: 9, inFlight: 0 })).toBeNull();
  expect(planLineKey(null, null)).toBeNull();
});

test("the warning's arithmetic: 80 % of 400 cr is 320 cr, rounded down, so it never warns later than the share", () => {
  expect(budgetPause({ cap: 400, spent: 320, needs: 7, warnPct: 80 })).toEqual({ cap: 400, spent: 320, needs: 7, pauseAt: 320, pct: 80, reached: true });
  expect(budgetPause({ cap: 401, spent: 0, needs: 0, warnPct: 80 })!.pauseAt).toBe(320);
  expect(budgetPause({ cap: 400, spent: 313, needs: 7, warnPct: 80 })!.reached).toBe(true);
  expect(budgetPause({ cap: 400, spent: 312, needs: 7, warnPct: 80 })!.reached).toBe(false);
  expect(budgetPause({ cap: 400, spent: 0, needs: 0, warnPct: 90 })!.pauseAt).toBe(360);
  expect(budgetPause({ cap: null, spent: 999, needs: 1, warnPct: 80 })).toBeNull();
  expect(budgetPause({ cap: 0, spent: 0, needs: 1, warnPct: 80 })).toBeNull();
  /* The share is the workspace's capWarnPct, 80 unless set, kept between 1 and 100. */
  expect(cleanWarnPct("")).toBe(80);
  expect(cleanWarnPct("nonsense")).toBe(80);
  expect(cleanWarnPct(150)).toBe(100);
  expect(cleanWarnPct(70)).toBe(70);
});

/* ── Settings › Spending rules › Budget and cap ────────────────────────── */

test("the budget per production is a whole number of credits or none; the route refuses anything else; the per-shot cap is no setting any more", () => {
  expect(DEFAULTS.productionBudgetCredits).toBe("");
  expect(cleanBudget("")).toBeNull();
  expect(cleanBudget("400")).toBe(400);
  for (const bad of ["0", "-5", "12.5", "4e2", "abc", "99999999", null, undefined]) expect(cleanBudget(bad), String(bad)).toBeNull();
  expect(settingProblem("productionBudgetCredits", "")).toBeNull();
  expect(settingProblem("productionBudgetCredits", "400")).toBeNull();
  for (const bad of ["0", "-1", "1.5", "x", "10000000"]) expect(settingProblem("productionBudgetCredits", bad), bad).not.toBeNull();
  /* Retired on 21 Oct 2026: not a default, and the settings route refuses it whole (tests/unit/settingsRoute.spec.ts). */
  expect(DEFAULTS).not.toHaveProperty("shotCapCredits");
});

test("Budget and cap in words: the warning at 320 cr of 400, and what the typed budget saves; no cap per shot (retired 21 Oct 2026)", () => {
  /* Said as the code does it: the producer is warned at 80 %; there is no Auto (owner, 20 Oct 2026), so nothing "asks" there of its own. */
  expect(budgetLine({ budget: 400, warnPct: 80 }, creditsText)).toBe("warns at 320 cr (80 %)");
  expect(budgetLine({ budget: null, warnPct: 80 }, creditsText)).toBe("none · a production follows its own cap, if it has one");
  /* A figure typed on the way to another (0) is no budget, never a crash. */
  expect(budgetHelp({ budget: 0, warnPct: 80 }, creditsText)).toBe("No budget: each production follows its own cap, if it has one.");
  expect(budgetLine({ budget: 0, warnPct: 80 }, creditsText)).toBe("none · a production follows its own cap, if it has one");
  expect(budgetHelp({ budget: 400, warnPct: 80 }, creditsText)).toBe("Warns at 80 % (320 cr); every render still waits for a person, and an approved plan runs on to the budget.");
  expect(digits("4a0b0")).toBe("400");
  expect(budgetPatch("400")).toEqual({ patch: { productionBudgetCredits: "400" } });
  expect(budgetPatch("")).toEqual({ patch: { productionBudgetCredits: "" } });
  expect(budgetPatch("0")).toHaveProperty("problem");
  /* Every value the field saves is one the settings route accepts, and never a retired key. */
  for (const r of [budgetPatch("400"), budgetPatch("")]) {
    expect(Object.keys((r as { patch: Record<string, string> }).patch)).toEqual(["productionBudgetCredits"]);
    for (const [k, v] of Object.entries((r as { patch: Record<string, string> }).patch)) expect(settingProblem(k, v), `${k}=${v}`).toBeNull();
  }
});

/* ── A failed take's Retry, priced ─────────────────────────────────────── */

const take = (over: Partial<Generation> = {}): Pick<Generation, "kind" | "model" | "params" | "prompt" | "projectId" | "shotId" | "status" | "task"> => ({
  kind: "video", model: "dreamina-seedance-2-5-260628", prompt: "Mist over the water.", projectId: "prod-a", shotId: "shot-a1", status: "failed", task: undefined,
  params: { ratio: "16:9", resolution: "1080p", duration: 5, references: [{ genId: "gen_still", role: "first frame" }, { uploadId: "upl_one" }, { nope: 1 }] },
  ...over,
} as Pick<Generation, "kind" | "model" | "params" | "prompt" | "projectId" | "shotId" | "status" | "task">);

test("Retry's price is the quote of the request Retry makes again; a take Make can't remake, or one that didn't fail, has none", () => {
  expect(retryQuoteBody(take())).toEqual({
    prompt: "Mist over the water.", model: "dreamina-seedance-2-5-260628", projectId: "prod-a", shotId: "shot-a1", ratio: "16:9", resolution: "1080p", duration: 5,
    refine: false, references: [{ genId: "gen_still", role: "first frame" }, { uploadId: "upl_one", role: "reference" }], firstFrameAssetId: "",
  });
  /* No quote body carries an approval: no ceiling, no fingerprint. */
  expect(Object.keys(retryQuoteBody(take())!)).not.toContain("maxCredits");
  expect(Object.keys(retryQuoteBody(take())!)).not.toContain("quoteFingerprint");
  expect(retryQuoteBody(take({ params: { ratio: "16:9", resolution: "480p", duration: 5, draft: true } }))).toMatchObject({ draft: true, resolution: "480p" });
  expect(retryQuoteBody(take({ status: "succeeded" }))).toBeNull();
  expect(retryQuoteBody(take({ kind: "audio" }))).toBeNull();
  expect(retryQuoteBody(take({ projectId: null }))).toBeNull();
  expect(retryQuoteBody(take({ params: { ratio: "16:9", resolution: "1080p", finalOf: "gen_draft" } }))).toBeNull();
  expect(retryQuoteBody(take({ params: { resolution: "1080p" } }))).toBeNull();
});

test("the plan's at most against the budget, in one line: past the 80 % ask, more than is left (stops at the cap, or warns), or nothing", () => {
  const line = (o: Partial<Parameters<typeof planBudgetLine>[0]>) => planBudgetLine({ name: "A 15-second film", total: 93, atMost: 186, cap: 400, used: 0, warnPct: 80, unlocked: false, atCap: "producer", ...o });
  expect(line({})).toBeNull();
  expect(line({ used: 134 })).toBe("This plan can take A 15-second film past 80 % of its budget (320 of 400 cr).");
  expect(line({ used: 133 })).toBeNull();
  /* Less left than its renders without fixes (T = 93 cr): it will stop at the cap. */
  expect(line({ used: 320 })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (80 cr); it will stop at the cap.");
  expect(line({ used: 320, atCap: "stop" })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (80 cr); it will stop at the cap.");
  expect(line({ used: 320, atCap: "warn" })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (80 cr); it goes past the cap with a warning.");
  expect(line({ used: 500 })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (0 cr); it will stop at the cap.");
  expect(line({ used: 300, unlocked: true })).toBeNull();
  expect(line({ used: 320, unlocked: true })).toBeNull();
  expect(line({ cap: null })).toBeNull();
  expect(line({ atMost: 0 })).toBeNull();
  expect(line({ used: 134, name: " " })).toBe("This plan can take this production past 80 % of its budget (320 of 400 cr).");
});

test("the plan's renders fit but its fixes would not (T ≤ left < 2T): it stops at the cap only if it uses all its fixes", () => {
  const line = (o: Partial<Parameters<typeof planBudgetLine>[0]>) => planBudgetLine({ name: "A 15-second film", total: 93, atMost: 186, cap: 400, used: 0, warnPct: 80, unlocked: false, atCap: "producer", ...o });
  expect(line({ used: 300 })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (100 cr). If it uses all its fixes, it stops at the cap.");
  expect(line({ used: 300, atCap: "stop" })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (100 cr). If it uses all its fixes, it stops at the cap.");
  expect(line({ used: 300, atCap: "warn" })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (100 cr). If it uses all its fixes, it goes past the cap with a warning.");
  /* Exactly T left: its renders fit. One credit under T: they don't. Exactly 2T left: it all fits (the 80 % line, not the cap). */
  expect(line({ used: 307 })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (93 cr). If it uses all its fixes, it stops at the cap.");
  expect(line({ used: 308 })).toBe("This plan’s at most 186 cr is more than A 15-second film has left (92 cr); it will stop at the cap.");
  expect(line({ used: 214 })).toBe("This plan can take A 15-second film past 80 % of its budget (400 of 400 cr).");
  expect(line({ used: 300, unlocked: true })).toBeNull();
});
