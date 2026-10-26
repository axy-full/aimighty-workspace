import { test, expect } from "@playwright/test";
import { BUTTONS, QUESTIONS } from "../../lib/copy";
import { AD_FILM_BRIEF } from "../../lib/productionModel/checklists";
import { inMemoryRecord, questionEngine, QuestionEngineError, skippedKey, type QuestionEngine } from "../../lib/productionModel/questionEngine";
import type { RecordView } from "../../lib/productionModel/questionTypes";
import { fixture } from "./questionBriefFixtures";

/*
 * The Brief as a conversation (owner, 25 Oct 2026; SOW v2 §9 Brief, Part II.1): above the floor, tonality, the hook, the
 * penny-drop moment, montage or not, high speed or not and the moments, each one question per card with likely answers as
 * chips, a field for the person's own words, Skip and Decide for me; an answer reads "from you · Change"; the floor rows
 * are untouched and are always asked first. Pure engine tests: no model, no database, no price.
 */

const WS_A = "ws_conversation_a";
const WS_B = "ws_conversation_b";
const CONVERSATION_KEYS = ["q:tone", "q:hook", "q:penny_drop", "q:montage", "q:high_speed", "q:moments"];
const without = (picks: Record<string, string>, key: string) => Object.fromEntries(Object.entries(picks).filter(([k]) => k !== key));
const PICKS: Record<string, string> = { "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "warm", "q:hook": "h", "q:penny_drop": "p", "q:montage": "montage", "q:high_speed": "normal_speed", "q:moments": "m" };

/** The synthetic deck with its two open floor rows answered by the person: the floor closed, the conversation open. */
function floorClosed(workspaceId = WS_A): QuestionEngine {
  const deck = fixture("synthetic-d11-deck");
  const engine = questionEngine(AD_FILM_BRIEF, inMemoryRecord(workspaceId, "prod_conversation", deck.read)).answer("real", "no_one").answer("ceiling", "none");
  expect(engine.floorClosed).toBe(true);
  return engine;
}
const rowOf = (engine: QuestionEngine, key: string) => engine.rows.find((row) => row.key === key)!;

test("the six conversation rows: the owner's order, the copy table's words, no row on the floor", () => {
  const conversation = AD_FILM_BRIEF.aboveFloor.filter((row) => row.question !== undefined);
  expect(conversation.map((row) => row.key)).toEqual(CONVERSATION_KEYS);
  for (const row of conversation) {
    expect(row.floor, row.key).toBe(false);
    expect(Object.hasOwn(QUESTIONS, row.question!), row.key).toBe(true);
    for (const pill of row.bank ?? []) expect(pill.copy && Object.hasOwn(QUESTIONS, pill.copy), `${row.key}.${pill.id}`).toBe(true);
  }
  /* Tonality offers the owner's six words; montage and speed offer both sides; the hook, the penny drop and the moments are the film's own. */
  const bank = (key: string) => (AD_FILM_BRIEF.aboveFloor.find((row) => row.key === key)!.bank ?? []).map((pill) => QUESTIONS[pill.copy!]);
  expect(bank("q:tone")).toEqual(["Warm", "Cold", "Standoffish", "Deadpan", "Over the top", "Emotional"]);
  expect(bank("q:montage")).toEqual(["Montage", "No montage"]);
  expect(bank("q:high_speed")).toEqual(["High speed", "Normal speed"]);
  for (const key of ["q:hook", "q:penny_drop", "q:moments"]) expect(bank(key), key).toEqual([]);
  /* G's subject, message and audience stay Atomik's to ask in its own words. */
  expect(AD_FILM_BRIEF.aboveFloor.filter((row) => row.question === undefined).map((row) => row.key)).toEqual(["q:subject", "q:message", "q:audience"]);
  expect(BUTTONS.skip).toBe("Skip");
});

test("the floor comes first: no conversation question while a floor row is open", () => {
  const open = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "prod_conversation", fixture("synthetic-d11-deck").read));
  expect(open.floorClosed).toBe(false);
  expect(open.nextAbove()).toBeNull();
  expect(open.next()?.key).toBe("real");
});

test("one question per card: at most four chips, Atomik's likely answers first, a field, Skip, nothing lit", () => {
  const engine = floorClosed();
  expect(engine.next()).toBeNull();
  const tone = engine.nextAbove()!;
  expect(tone).toEqual({
    key: "q:tone", text: QUESTIONS.tone, shape: "pick_one", field: true, fieldLabel: QUESTIONS.other, skip: true,
    pills: [
      { id: "warm", label: "Warm", lit: false }, { id: "cold", label: "Cold", lit: false },
      { id: "standoffish", label: "Standoffish", lit: false }, { id: "deadpan", label: "Deadpan", lit: false },
    ],
  });
  /* Atomik's words for this film lead; one that repeats a bank word is shown once; four in all. */
  const proposed = engine.nextAbove({ "q:tone": ["Wry", " Warm ", "Emotional", "Tender"] })!;
  expect(proposed.pills.map((pill) => [pill.id, pill.label])).toEqual([["Wry", "Wry"], ["Warm", "Warm"], ["Emotional", "Emotional"], ["Tender", "Tender"]]);
  /* The hook has no bank: Atomik's proposals or the field alone. */
  const atHook = engine.answer("q:tone", "warm");
  expect(atHook.nextAbove()).toMatchObject({ key: "q:hook", text: QUESTIONS.hook, pills: [], field: true, skip: true });
  expect(atHook.nextAbove({ "q:hook": ["The bottle is still cold at midnight"] })!.pills).toEqual([{ id: "The bottle is still cold at midnight", label: "The bottle is still cold at midnight", lit: false }]);
});

test("the conversation: each question once, in order, a chip or the person's own words, each reading 'from you · Change'", () => {
  let engine = floorClosed();
  const asked: string[] = [];
  const said: Record<string, string> = { "q:tone": "deadpan", "q:hook": "A train that never arrives", "q:penny_drop": "The last sip", "q:montage": "no_montage", "q:high_speed": "high_speed", "q:moments": "The lid opening" };
  for (let guard = 0; guard < 20; guard++) {
    const question = engine.nextAbove();
    if (!question) break;
    expect(asked, `${question.key} is never asked twice`).not.toContain(question.key);
    asked.push(question.key);
    engine = engine.answer(question.key, said[question.key]);
    expect(rowOf(engine, question.key)).toMatchObject({ state: "known", source: "said", value: said[question.key], line: `${QUESTIONS.fromYou} · ${BUTTONS.change}` });
  }
  expect(asked).toEqual(CONVERSATION_KEYS);
  expect(engine.nextAbove()).toBeNull();
  expect(engine.writes.filter((w) => w.key.startsWith("q:")).map((w) => [w.key, w.source, w.reason])).toEqual(CONVERSATION_KEYS.map((key) => [key, "said", "answer"]));
  /* The floor rows are untouched by the conversation. */
  for (const row of engine.rows.filter((r) => r.floor)) expect(row.state, row.key).not.toBe("open");
});

test("Skip: the row is never asked again, never guessed, reads no line, and is the person's own act", () => {
  const engine = floorClosed().answer("q:tone", "cold");
  const skipped = engine.skip("q:hook");
  expect(rowOf(skipped, "q:hook")).toEqual({ key: "q:hook", floor: false, state: "skipped", value: null, source: null, fromStep: null, line: null });
  expect(skipped.nextAbove()?.key).toBe("q:penny_drop");
  expect(skipped.open).not.toContain("q:hook");
  expect(skipped.mayAsk("q:hook")).toBe(false);
  expect(skipped.writes.at(-1)).toEqual({ workspaceId: WS_A, productionId: "prod_conversation", key: skippedKey("q:hook"), value: "yes", source: "said", reason: "skip" });
  /* Decide for me needs no pick for a skipped row and never writes it. */
  const decided = skipped.decideForMe(without(PICKS, "q:hook"));
  expect(decided.writes.some((w) => w.key === "q:hook")).toBe(false);
  expect(rowOf(decided, "q:hook").state).toBe("skipped");
  /* Skipping twice, or a row already answered, changes nothing. */
  expect(skipped.skip("q:hook").writes).toEqual(skipped.writes);
  expect(skipped.skip("q:tone").writes).toEqual(skipped.writes);
  /* The person may still answer it later, in their own words. */
  expect(rowOf(skipped.answer("q:hook", "A cold bottle at midnight"), "q:hook")).toMatchObject({ state: "known", line: `${QUESTIONS.fromYou} · ${BUTTONS.change}` });
});

test("Skip is for the conversation only: never a floor row, never a row Atomik asks in its own words, never a stranger", () => {
  const engine = floorClosed();
  for (const key of ["kind", "ceiling", "real", "q:subject", "q:anything", "not a key"]) {
    expect(() => engine.skip(key), key).toThrow("Only a conversation question can be skipped.");
  }
  const open = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "prod_conversation", fixture("nothing").read));
  expect(() => open.skip("language")).toThrow(QuestionEngineError);
});

test("Decide for me closes the conversation with Atomik's picks, each 'I assumed … · Change' in the chip's words", () => {
  const decided = floorClosed().decideForMe(PICKS);
  expect(decided.nextAbove()).toBeNull();
  expect(rowOf(decided, "q:tone")).toMatchObject({ state: "assumed", source: "assumed", line: `${QUESTIONS.assumed} Warm · ${BUTTONS.change}` });
  expect(rowOf(decided, "q:high_speed").line).toBe(`${QUESTIONS.assumed} Normal speed · ${BUTTONS.change}`);
  expect(rowOf(decided, "q:hook").line).toBe(`${QUESTIONS.assumed} h · ${BUTTONS.change}`);
  /* Without a pick for a conversation row, Decide for me refuses, naming the row: nothing is guessed. */
  expect(() => floorClosed().decideForMe(without(PICKS, "q:moments"))).toThrow(/q:moments/);
});

test("proposals are checked: only conversation rows, only short words", () => {
  const engine = floorClosed();
  for (const key of ["kind", "q:subject", "q:unknown"]) expect(() => engine.nextAbove({ [key]: ["x"] }), key).toThrow("That row is not on this step's checklist.");
  for (const bad of [[""], ["  "], ["x".repeat(81)], [7 as unknown as string], "warm" as unknown as string[]]) {
    expect(() => engine.nextAbove({ "q:tone": bad }), JSON.stringify(bad)).toThrow("That answer is not one of this question's choices.");
  }
  expect(engine.nextAbove({ "q:tone": ["x".repeat(80)] })!.pills[0].id).toHaveLength(80);
});

test("tenancy: a skip carries its workspace and production; another workspace's skip is refused, never read", () => {
  const a = floorClosed(WS_A).skip("q:tone");
  const b = floorClosed(WS_B);
  expect(a.writes.at(-1)).toMatchObject({ workspaceId: WS_A, productionId: "prod_conversation" });
  expect(rowOf(b, "q:tone").state).toBe("open");
  const leaky: RecordView = {
    workspaceId: WS_B,
    productionId: "prod_conversation",
    get: (key) => (key === skippedKey("q:tone") ? { workspaceId: WS_A, value: "yes", source: "said" } : null),
  };
  expect(() => questionEngine(AD_FILM_BRIEF, leaky)).toThrow("That row is not in this workspace.");
});

test("deterministic: the same brief, proposals, answers and skips give the same questions and writes, twice", () => {
  const run = () => {
    const start = floorClosed();
    const first = start.nextAbove({ "q:tone": ["Wry"] });
    const end = start.answer("q:tone", "Wry").skip("q:hook").answer("q:penny_drop", "The last sip");
    return JSON.stringify({ first, next: end.nextAbove(), rows: end.rows, writes: end.writes });
  };
  expect(run()).toBe(run());
});
