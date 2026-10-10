import { test, expect } from "@playwright/test";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import type { PlanModel } from "../../components/graphite/board/cards/plan/model";
import {
  CLIENT_MARK, clientRoundGoal, clientRoundModel, feedbackOf, hasRound, isClientRound, latestRound, looksLikeClientFeedback, parseFeedback, roundBadge, roundDate, roundOf,
  whatChangedText, type BoardRound,
} from "../../lib/v12/rounds";

/**
 * Client rounds (lib/v12/rounds.ts; redesign P2-c): the client's reply read as a change per shot, asked of Atomik as today's ask,
 * shown as the plan's own steps with the one approval "Approve all · N cr", kept in the draft once approved, and said as words
 * to paste into WhatsApp or email. Pure; the schema keeps the rounds in the draft's JSON.
 */
const REPLY = "Loving it. Shot 2 — sphere bigger in the wide. Shot 4: bottle fuller, label to camera. Shot 7 lose the second figure. Rest approved 👍";

test("a client's reply is read as a change per shot, in their words", () => {
  expect(parseFeedback(REPLY)).toEqual([
    { shot: 2, text: "Sphere bigger in the wide" }, { shot: 4, text: "Bottle fuller, label to camera" }, { shot: 7, text: "Lose the second figure" },
  ]);
  expect(parseFeedback("shot 3 warmer\nSHOT 3 colder\nshots 5: no")).toEqual([{ shot: 3, text: "Warmer" }, { shot: 5, text: "No" }]);
  expect(parseFeedback("Looks good to us")).toEqual([]);
});

test("it is feedback when two shots are named, or one is and the client says so; an ordinary ask is not", () => {
  expect(looksLikeClientFeedback(REPLY)).toBe(true);
  expect(looksLikeClientFeedback("Client says shot 3 needs more light")).toBe(true);
  expect(looksLikeClientFeedback("Shot 3 needs more light")).toBe(false);
  expect(looksLikeClientFeedback("Warmer light on the whole board")).toBe(false);
});

test("the ask says what it is, within the ask's limit, and the client's words come back out of it", () => {
  const goal = clientRoundGoal(REPLY);
  expect(goal.startsWith(CLIENT_MARK)).toBe(true);
  expect(isClientRound(goal)).toBe(true);
  expect(isClientRound(REPLY)).toBe(false);
  expect(feedbackOf(`${goal} (16:9)`)).toBe(REPLY);
  expect(clientRoundGoal("x".repeat(5000)).length).toBe(2000);
});

const model = (over: Partial<PlanModel> = {}): PlanModel => ({
  runId: "run-1", phase: "proposal", title: "Make 3 shots",
  steps: [2, 4, 7].map((n, i) => ({ seq: i + 1, kind: "take", title: `Shot ${n} · Wide`, meta: "Seedance", price: null, source: "estimate", unavailable: null, needsAdmin: false, asksAlone: null, state: "proposed", status: "Planned", reason: null, canRender: false, fingerprint: null })),
  total: null, ceiling: null, used: null, balance: null, totalLine: null, thinking: null, modeLine: null, ruleLine: null, adminLine: "", note: null, mine: true,
  primary: { kind: "plan", label: "Approve · 93 cr", price: { kind: "exact", credits: 93 } as never, fingerprint: "f", blocked: null }, ...over,
});

test("the plan reads as a client round: a step per shot with what was asked, and 'Approve all' at the plan's own price", () => {
  const out = clientRoundModel(model(), clientRoundGoal(REPLY));
  expect(out.title).toBe("Client round · 3 changes");
  expect(out.steps.map((s) => s.title)).toEqual(["Shot 2 · Sphere bigger in the wide", "Shot 4 · Bottle fuller, label to camera", "Shot 7 · Lose the second figure"]);
  expect(out.primary).toMatchObject({ kind: "plan", label: "Approve all · 93 cr" });
  /* Prices and state are the plan's: nothing is added or worked out here. */
  expect(out.steps[0]).toMatchObject({ price: null, state: "proposed" });
  expect(clientRoundModel(model({ steps: model().steps.slice(0, 1) }), clientRoundGoal(REPLY)).title).toBe("Client round · 1 change");
  expect(clientRoundModel(model({ phase: "working" }), clientRoundGoal(REPLY)).title).toBe("Round 2 · 3 changes");
});

test("the approved plan makes round 2, with what each shot had before; the next is round 3", () => {
  const at = Date.UTC(2026, 9, 9, 10, 40);
  const r2 = roundOf({ runId: "run-1", goal: clientRoundGoal(REPLY), stepTitles: ["Shot 7 · Wide", "Shot 2 · Wide", "Shot 4 · Wide"], rounds: [], before: { "2": "g2", "4": "g4", "9": "g9" }, at });
  expect(r2).toEqual({ n: 2, runId: "run-1", at, changes: [{ shot: 2, text: "Sphere bigger in the wide" }, { shot: 4, text: "Bottle fuller, label to camera" }, { shot: 7, text: "Lose the second figure" }], before: { "2": "g2", "4": "g4" } });
  const r3 = roundOf({ runId: "run-2", goal: clientRoundGoal("Shot 1 darker. Shot 2 lighter"), stepTitles: ["Shot 1"], rounds: [r2], before: {}, at });
  expect(r3.n).toBe(3);
  expect(hasRound([r2, r3], "run-2")).toBe(true);
  expect(hasRound([r2], "run-2")).toBe(false);
  expect(latestRound([r2, r3])).toBe(r3);
  expect(latestRound(undefined)).toBeNull();
});

test("the words for WhatsApp or email, and the header's badge", () => {
  const round: BoardRound = { n: 2, runId: "r", at: new Date(2026, 9, 9, 12).getTime(), changes: [{ shot: 2, text: "Sphere bigger in the wide" }, { shot: 4, text: "Bottle fuller" }], before: {} };
  expect(roundDate(round.at)).toBe("9 Oct 2026");
  expect(roundBadge(round)).toBe("Round 2 · 2 changed");
  expect(whatChangedText("Harbour film", round, 8)).toBe("Harbour film · R2 · 9 Oct 2026\nWhat changed in round 2:\n• Shot 2: Sphere bigger in the wide\n• Shot 4: Bottle fuller\nThe other 6 shots are as you approved them.");
});

test("the rounds are part of the draft JSON: the project schema takes them and refuses nonsense", () => {
  const round: BoardRound = { n: 2, runId: "run-1", at: 1, changes: [{ shot: 2, text: "Bigger" }], before: { "2": "g2" } };
  const project = { ...newProject("Board"), boardRounds: [round] };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardRounds: [{ ...round, n: 1 }] }).success).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardRounds: [{ ...round, before: { x: "g" } }] }).success).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardRounds: [{ ...round, extra: true }] }).success).toBe(false);
});
