import { test, expect } from "@playwright/test";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import { deriveRounds } from "../../components/v12/rounds/round-derive";
import type { PlanModel } from "../../components/graphite/board/cards/plan/model";
import {
  CLIENT_MARK, ROUND_LIMITS, cleanRounds, withRound, shotOfNodeMap, shotOfStep, showsRound, clientRoundGoal, clientRoundModel, feedbackOf, hasRound, isClientRound, latestRound, looksLikeClientFeedback, parseFeedback, roundBadge, roundDate, roundOf,
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

/* The grid's own numbering: the card behind each shot. Atomik's step titles ("01 — Opening") name no shot; the card does. */
const SHOTS = shotOfNodeMap(Array.from({ length: 9 }, (_, i) => ({ nodeId: `card-${i + 1}`, index: i + 1 })));

const model = (over: Partial<PlanModel> = {}): PlanModel => ({
  runId: "run-1", phase: "proposal", title: "Make 3 shots",
  steps: [2, 4, 7].map((n, i) => ({ seq: i + 1, nodeId: `card-${n}`, kind: "take", title: `0${i + 1} — ${["Opening", "The turn", "Close"][i]}`, meta: "Seedance", price: null, source: "estimate", unavailable: null, needsAdmin: false, asksAlone: null, state: "proposed", status: "Planned", reason: null, canRender: false, fingerprint: null })),
  total: null, ceiling: null, used: null, balance: null, totalLine: null, thinking: null, modeLine: null, ruleLine: null, adminLine: "", note: null, mine: true,
  primary: { kind: "plan", label: "Approve · 93 cr", price: { kind: "exact", credits: 93 } as never, fingerprint: "f", blocked: null }, ...over,
});

test("the plan reads as a client round: a step per shot with what was asked, and 'Approve all' at the plan's own price", () => {
  const out = clientRoundModel(model(), clientRoundGoal(REPLY), SHOTS);
  expect(out.title).toBe("Client round · 3 changes");
  /* Atomik's own titles stay; what the client asked for each shot is beside them. */
  expect(out.steps.map((s) => s.title)).toEqual(["01 — Opening", "02 — The turn", "03 — Close"]);
  expect(out.steps.map((s) => s.meta)).toEqual(["Asked: “Sphere bigger in the wide” · Seedance", "Asked: “Bottle fuller, label to camera” · Seedance", "Asked: “Lose the second figure” · Seedance"]);
  expect(out.primary).toMatchObject({ kind: "plan", label: "Approve all · 93 cr" });
  /* Prices and state are the plan's: nothing is added or worked out here. */
  expect(out.steps[0]).toMatchObject({ price: null, state: "proposed" });
  expect(clientRoundModel(model({ steps: model().steps.slice(0, 1) }), clientRoundGoal(REPLY), SHOTS).title).toBe("Client round · 1 change");
  expect(clientRoundModel(model({ phase: "working" }), clientRoundGoal(REPLY), SHOTS).title).toBe("Round 2 · 3 changes");
});

test("a step is matched to a shot by its card, never by its title or its place in the list; 'N changes' counts changes", () => {
  /* The client asked about shots 2, 4 and 7. Step 1 stands in the first place and is called "Shot 2 · Wide", but its card is shot 5 (not asked).
     Step 2 stands second (a place the client DID ask about), has a card that is no shot on the grid, and a title that names no shot.
     Step 3 is shot 4's card, called "The bottle". */
  const base = model().steps[0];
  const steps = [
    { ...base, seq: 1, nodeId: "card-5", title: "Shot 2 · Wide" },
    { ...base, seq: 2, nodeId: "card-new", title: "Redraw" },
    { ...base, seq: 3, nodeId: "card-4", title: "The bottle" },
    { ...base, seq: 4, nodeId: null, title: "Shot 7 · Wide" },
  ];
  const out = clientRoundModel(model({ steps }), clientRoundGoal(REPLY), SHOTS);
  expect(out.steps.map((s) => s.meta)).toEqual(["Seedance", "Seedance", "Asked: “Bottle fuller, label to camera” · Seedance", "Seedance"]);
  expect(out.steps.map((s) => s.title)).toEqual(["Shot 2 · Wide", "Redraw", "The bottle", "Shot 7 · Wide"]);
  expect(out.title).toBe("Client round · 1 change");
  expect(shotOfStep({ nodeId: "card-7" }, SHOTS)).toBe(7);
  expect(shotOfStep({ nodeId: "card-new" }, SHOTS)).toBeNull();
  expect(shotOfStep({ nodeId: null }, SHOTS)).toBeNull();
  /* The round the approval records tags the same shot and no other (shot 5 was rendered but not asked about), and keeps the take that shot had before. */
  const round = roundOf({ runId: "r", goal: clientRoundGoal(REPLY), steps, shots: SHOTS, rounds: [], before: { "1": "g1", "2": "g2", "4": "g4", "5": "g5" }, at: 5 });
  expect(round.changes).toEqual([{ shot: 4, text: "The bottle" }]);
  expect(round.before).toEqual({ "4": "g4" });
  expect(roundOf({ runId: "r", goal: clientRoundGoal(REPLY), steps: [steps[1], steps[3]], shots: SHOTS, rounds: [], before: {}, at: 5 }).changes).toEqual([]);
});

test("a recorded round never makes the board unsavable: text, changes and rounds are cut to what the draft takes, and a 21st round still saves", () => {
  let rounds: BoardRound[] = [];
  for (let i = 0; i < 21; i++) {
    const long = Array.from({ length: 70 }, (_, k) => `Shot ${k + 1} ${"x".repeat(300)}`).join(". ");
    const next = roundOf({ runId: `run-${i}`, goal: clientRoundGoal(long), steps: Array.from({ length: 70 }, (_, k) => ({ nodeId: `card-${k + 1}`, title: `Wide ${k + 1} ${"y".repeat(300)}` })), shots: shotOfNodeMap(Array.from({ length: 70 }, (_, k) => ({ nodeId: `card-${k + 1}`, index: k + 1 }))), rounds, before: Object.fromEntries(Array.from({ length: 70 }, (_, k) => [String(k + 1), "g".repeat(150)])), at: 1000 + i });
    expect(next.changes.length).toBeLessThanOrEqual(ROUND_LIMITS.changes);
    expect(next.changes.every((c) => c.text.length <= ROUND_LIMITS.text)).toBe(true);
    rounds = withRound(rounds, next);
  }
  expect(rounds).toHaveLength(ROUND_LIMITS.rounds);
  expect(rounds[rounds.length - 1].runId).toBe("run-20");
  expect(rounds[0].runId).toBe("run-1");
  expect(projectSchema.safeParse({ ...newProject("Board"), boardRounds: rounds }).success).toBe(true);
  /* A draft read with more than the schema takes (older, or edited by hand) is cut to size on read. */
  const messy = [...rounds, { n: 7, runId: "bad id!", at: 1, changes: [], before: {} }, { n: 1, runId: "x", at: 1, changes: [], before: {} }, { ...rounds[0], runId: "long", changes: Array.from({ length: 80 }, (_, k) => ({ shot: k + 1, text: "y".repeat(500) })) }];
  const cleaned = cleanRounds(messy);
  expect(cleaned.length).toBeLessThanOrEqual(ROUND_LIMITS.rounds);
  expect(projectSchema.safeParse({ ...newProject("Board"), boardRounds: cleaned }).success).toBe(true);
  expect(cleanRounds("nonsense")).toEqual([]);
});

test("the approved plan makes round 2, with what each shot had before; the next is round 3", () => {
  const at = Date.UTC(2026, 9, 9, 10, 40);
  const r2 = roundOf({ runId: "run-1", goal: clientRoundGoal(REPLY), steps: [7, 2, 4].map((n) => ({ nodeId: `card-${n}`, title: `Redo ${n}` })), shots: SHOTS, rounds: [], before: { "2": "g2", "4": "g4", "9": "g9" }, at });
  expect(r2).toEqual({ n: 2, runId: "run-1", at, changes: [{ shot: 2, text: "Redo 2" }, { shot: 4, text: "Redo 4" }, { shot: 7, text: "Redo 7" }], before: { "2": "g2", "4": "g4" } });
  /* What is recorded is what was done (Atomik's step titles), never the client's words as if they had been applied. */
  const r3 = roundOf({ runId: "run-2", goal: clientRoundGoal("Shot 1 darker. Shot 2 lighter"), steps: [{ nodeId: "card-1", title: "Redo 1" }], shots: SHOTS, rounds: [r2], before: {}, at });
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

test("a customer's plan card never reads as a client round: the wording is on the new interface alone, and a board without rounds derives none", () => {
  const goal = clientRoundGoal(REPLY);
  expect(showsRound(true, goal)).toBe(true);
  expect(showsRound(false, goal)).toBe(false);
  expect(showsRound(true, "Make the opening")).toBe(false);
  expect(showsRound(true, undefined)).toBe(false);
  /* The round cards come only from rounds a board of the new interface recorded: a board with none (every customer's) derives nothing. */
  const project = newProject("Board");
  const src = (boardRounds?: unknown) => ({ kind: "studio" as const, project: { ...project, boardRounds } as never, library: [] });
  expect(deriveRounds(src())).toEqual([]);
  expect(deriveRounds(src("nonsense"))).toEqual([]);
  expect(deriveRounds(src([{ n: 2, runId: "run-1", at: 1, changes: [{ shot: 2, text: "Bigger" }], before: {} }])).map((c) => c.id)).toEqual(["round:changed", "round:cut", "round:deliver"]);
});
