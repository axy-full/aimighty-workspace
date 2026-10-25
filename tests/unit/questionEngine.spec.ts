import { test, expect } from "@playwright/test";
import { BUTTONS, QUESTIONS } from "../../lib/copy";
import { AD_FILM_BRIEF, checklistFor, CONSENT_FROM_BRIEF } from "../../lib/productionModel/checklists";
import { decidedKey, inMemoryRecord, questionEngine, QuestionEngineError, type QuestionEngine } from "../../lib/productionModel/questionEngine";
import type { Checklist, FloorRow, RecordView } from "../../lib/productionModel/questionTypes";
import { BRIEF_FIXTURES, fixture, type BriefFixture } from "./questionBriefFixtures";

/*
 * The question engine's deterministic core on mocked briefs (Amendment, 22 October 2026 (iii), G "Questions", H, K D1/D11;
 * SOW R2; PR plan L5). No model, no database, no price: the engine is pure, and these are its tests.
 *
 *   - the Ad film's Brief floor is H's seven rows, with words from the copy table;
 *   - every row's mark (known / assumed / open) from each fixture;
 *   - R2 extended (H): a brief that answers a floor row never produces its question; a brief that doesn't always does;
 *   - the order; one answer closing two rows; "Decide for me"; determinism; tenant isolation (rule 2).
 */

const WS_A = "ws_question_a";
const WS_B = "ws_question_b";
const FLOOR_KEYS = ["kind", "length", "plays", "language", "real", "material", "ceiling"];
const ABOVE_KEYS = ["q:subject", "q:message", "q:audience", "q:tone"];

const engineFor = (f: BriefFixture, workspaceId = WS_A, checklist: Checklist = AD_FILM_BRIEF) =>
  questionEngine(checklist, inMemoryRecord(workspaceId, `prod_${f.id}`, f.read));

const stateOf = (engine: QuestionEngine, key: string) => engine.rows.find((row) => row.key === key)?.state;

/** The interview: ask the next question, answer it with its lit pill (or the field when nothing is lit), until the floor closes. */
function interview(start: QuestionEngine): { asked: string[]; end: QuestionEngine } {
  const asked: string[] = [];
  let engine = start;
  for (let guard = 0; guard < 50; guard++) {
    const question = engine.next();
    if (!question) return { asked, end: engine };
    expect(asked, `${question.key} is never asked twice`).not.toContain(question.key);
    asked.push(question.key);
    const lit = question.pills.find((pill) => pill.lit);
    engine = engine.answer(question.key, lit ? lit.id : question.pills[0]?.id ?? "said in the field");
  }
  throw new Error("the interview did not end");
}

test("the Ad film's Brief floor: H's seven rows in H's order, at most four pills, every word from the copy table", () => {
  expect(checklistFor("ad_film", "brief")).toBe(AD_FILM_BRIEF);
  expect(checklistFor("ad_film", "script")).toBeNull();
  expect(AD_FILM_BRIEF.floor.map((row) => row.key)).toEqual(FLOOR_KEYS);
  expect(AD_FILM_BRIEF.aboveFloor.map((row) => row.key)).toEqual(ABOVE_KEYS);
  expect(AD_FILM_BRIEF.floor.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);

  const keys = AD_FILM_BRIEF.floor.map((row) => row.key);
  for (const row of AD_FILM_BRIEF.floor) {
    expect(row.money, row.key).toBe(true);
    expect(Object.hasOwn(QUESTIONS, row.question), row.key).toBe(true);
    const sets = "by" in row.pills ? Object.values(row.pills.sets) : [row.pills];
    for (const set of sets) {
      expect(set.pills.length, `${row.key}: at most four pills (A1)`).toBeLessThanOrEqual(4);
      if (set.lit !== null) expect(set.pills.map((pill) => pill.id), `${row.key}: the lit pill is a pill`).toContain(set.lit);
      for (const pill of set.pills) {
        /* Every pill's words come from the copy table, and no pill is a figure. */
        expect(pill.copy && Object.hasOwn(QUESTIONS, pill.copy), `${row.key}.${pill.id}`).toBe(true);
        expect(pill.id, `${row.key}.${pill.id}`).not.toMatch(/^(cap_)?\d+$/);
      }
    }
    /* A row reads only rows asked before it: no cycle, and nothing it waits on comes after it. */
    for (const dep of row.dependsOn ?? []) expect(keys.indexOf(dep), `${row.key} reads ${dep}`).toBeLessThan(keys.indexOf(row.key));
    if (row.agentPicks) for (const id of row.agentPicks) expect(sets.flatMap((set) => set.pills.map((pill) => pill.id))).toContain(id);
  }
  /* Rule 11: Atomik never picks a spend limit, nor says that consent is on file. */
  const row = (key: string) => AD_FILM_BRIEF.floor.find((r) => r.key === key)!;
  /* The spend limit (film-record-schema A.0, A.2, question 7): person-only, a reference ("none"), no free-text figure. */
  expect(row("ceiling")).toMatchObject({ personOnly: true, field: false, pills: { pills: [{ id: "none", copy: "ceilingNone" }, { id: "production", copy: "ceilingOther" }], lit: "none" } });
  expect(row("ceiling").answeredBy).not.toContain("house_default");
  expect(AD_FILM_BRIEF.floor.filter((r) => r.personOnly).map((r) => r.key)).toEqual(["ceiling"]);
  expect(row("real").agentPicks).not.toContain("yes_consent");
  /* The question's words are the copy table's. */
  expect(engineFor(fixture("nothing")).next()?.text).toBe(QUESTIONS.kind);
  expect(engineFor(fixture("nothing")).next()?.fieldLabel).toBe(QUESTIONS.other);
});

test("every row's mark, from every fixture", () => {
  for (const f of BRIEF_FIXTURES) {
    expect(f.synthetic, `${f.id} is labelled a stand-in`).toBe(true);
    const engine = engineFor(f);
    for (const key of FLOOR_KEYS) {
      const want = f.expect.known.includes(key) ? "known" : f.expect.assumed.includes(key) ? "assumed" : "open";
      expect(stateOf(engine, key), `${f.id}: ${key}`).toBe(want);
    }
    for (const key of ABOVE_KEYS) expect(stateOf(engine, key), `${f.id}: ${key}`).toBe(f.read[key] ? "known" : "open");
    expect(engine.rows.find((row) => row.key === "kind")?.source ?? null).toBe(f.read.kind?.source ?? null);
    expect(engine.floorClosed).toBe(f.expect.asks.length === 0);
  }
});

test("R2, as H extends it: a brief that answers a floor row never produces its question; one that doesn't always does", () => {
  for (const f of BRIEF_FIXTURES) {
    const { asked, end } = interview(engineFor(f));
    expect(asked, f.id).toEqual(f.expect.asks);
    for (const key of [...f.expect.known, ...f.expect.assumed]) expect(asked, `${f.id}: ${key} is answered`).not.toContain(key);
    expect(end.floorClosed, f.id).toBe(true);
    expect(end.next()).toBeNull();
    /* Every answer is the person's, written with its source. */
    expect(end.writes.filter((w) => w.reason !== "carry").map((w) => [w.key, w.source, w.reason])).toEqual(asked.map((key) => [key, "said", "answer"]));
  }
  /* The SOW's own example: a brief that says "Hindi VO" is never asked the language question. */
  const deck = fixture("synthetic-d11-deck");
  expect(deck.words).toContain("Hindi VO");
  expect(interview(engineFor(deck)).asked).not.toContain("language");
});

test("the order: floor before above the floor, by rank, never before what a row reads", () => {
  const nothing = engineFor(fixture("nothing"));
  expect(nothing.open).toEqual([...FLOOR_KEYS, ...ABOVE_KEYS]);
  expect(nothing.next()?.key).toBe("kind");
  /* length's pills are by kind: until kind is known, length shows the field only, and is never asked first. */
  const afterKind = nothing.answer("kind", "social");
  expect(afterKind.next()?.key).toBe("length");
  expect(afterKind.next()?.pills.map((pill) => [pill.id, pill.lit])).toEqual([["6s", false], ["15s", true], ["30s", false]]);
  expect(nothing.answer("kind", "short_film").next()?.pills.find((pill) => pill.lit)?.id).toBe("3min");
  expect(nothing.answer("kind", "music_video").next()).toMatchObject({ key: "length", pills: [], field: true });

  /* Rule 2 of the order, on its own: a row that reads another waits for it, whatever its rank. */
  const reads: Checklist = {
    filmType: "synthetic",
    step: "synthetic",
    floor: [
      { ...(AD_FILM_BRIEF.floor[1] as FloorRow), rank: 1 },
      { ...(AD_FILM_BRIEF.floor[0] as FloorRow), rank: 2 },
    ],
    aboveFloor: [],
  };
  const waiting = questionEngine(reads, inMemoryRecord(WS_A, "prod_order", {}));
  expect(waiting.open).toEqual(["kind", "length"]);
  expect(waiting.next()?.key).toBe("kind");

  /* Above the floor: Atomik's own words, never a floor row, never a row the record holds (H). */
  const deck = engineFor(fixture("synthetic-d11-deck"));
  expect(deck.mayAsk("q:tone")).toBe(true);
  expect(deck.mayAsk("q:subject")).toBe(false);
  expect(deck.mayAsk("q:anything_this_film_needs")).toBe(true);
  expect(deck.mayAsk("language")).toBe(false);
  expect(deck.mayAsk("real")).toBe(false);
  expect(deck.mayAsk("not a key")).toBe(false);
  expect(deck.answer("q:tone", "warm").mayAsk("q:tone")).toBe(false);
});

test("one answer closes two rows: the field's words, and what H carries to a later step", () => {
  /* The field's words name a length and where it plays: both close, and the next question moves past both. */
  const menu = engineFor(fixture("menu-only"));
  const both = menu.answer("length", "30s", { plays: "phone" });
  expect([stateOf(both, "length"), stateOf(both, "plays")]).toEqual(["known", "known"]);
  expect(both.next()?.key).toBe("language");
  expect(both.writes.map((w) => [w.key, w.value, w.source])).toEqual([["length", "30s", "said"], ["plays", "phone", "said"]]);

  /* H, Elements › source is "Answered by Brief › material": one answer at the Brief closes the row Elements would ask. */
  const nothingYet = menu.answer("material", "nothing");
  expect(nothingYet.writes).toEqual([
    { workspaceId: WS_A, productionId: "prod_menu-only", key: "material", value: "nothing", source: "said", reason: "answer" },
    { workspaceId: WS_A, productionId: "prod_menu-only", key: "source", value: "made", source: "earlier_step", reason: "carry", from: "material", fromStep: "brief" },
  ]);
  /* The Elements step's engine (its row as H drafts it, built here: Elements' checklist is a later PR) reads the same record. */
  const elements: Checklist = {
    filmType: "ad_film",
    step: "elements",
    floor: [{
      key: "source", floor: true, step: "elements", rank: 1, question: "material", shape: "upload", field: false, money: true,
      pills: { pills: [{ id: "photos" }, { id: "made" }], lit: "made" }, answeredBy: ["brief_material", "drop"], sets: ["training_or_sheet"],
    }],
    aboveFloor: [],
  };
  const atElements = questionEngine(elements, nothingYet.record);
  expect(stateOf(atElements, "source")).toBe("known");
  expect(atElements.next()).toBeNull();
  /* A carry never overwrites a row the record already holds; a script alone carries nothing. */
  expect(questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { source: { value: "photos", source: "said" } })).answer("material", "nothing").writes.map((w) => w.key)).toEqual(["material"]);
  expect(menu.answer("material", "script").writes.map((w) => w.key)).toEqual(["material"]);
  /* Changing an answer is a change, not a second question. */
  expect(nothingYet.answer("material", "media").writes.find((w) => w.key === "material" && w.value === "media")).toMatchObject({ reason: "change" });
});

test("a changed answer carries again: what this row carried is re-carried, or reopened; a person's own answer is never touched", () => {
  const menu = engineFor(fixture("menu-only"));
  const nothingYet = menu.answer("material", "nothing");
  /* nothing → media: Elements' source is re-carried, still from the Brief. */
  const media = nothingYet.answer("material", "media");
  expect(media.writes.slice(2)).toEqual([
    { workspaceId: WS_A, productionId: "prod_menu-only", key: "material", value: "media", source: "said", reason: "change" },
    { workspaceId: WS_A, productionId: "prod_menu-only", key: "source", value: "photos", source: "earlier_step", reason: "carry", from: "material", fromStep: "brief" },
  ]);
  expect(media.record.get("source")).toMatchObject({ value: "photos", source: "earlier_step", carriedFrom: "material", fromStep: "brief" });
  /* media → script: a script carries nothing, so the carried source reopens, and the Elements step asks it. */
  const script = media.answer("material", "script");
  expect(script.writes.at(-1)).toEqual({ workspaceId: WS_A, productionId: "prod_menu-only", key: "source", value: null, source: null, reason: "carry", from: "material", fromStep: "brief" });
  expect(script.record.get("source")).toBeNull();
  const elements: Checklist = {
    filmType: "ad_film",
    step: "elements",
    floor: [{
      key: "source", floor: true, step: "elements", rank: 1, question: "material", shape: "upload", field: false, money: true,
      pills: { pills: [{ id: "photos" }, { id: "made" }], lit: "made" }, answeredBy: ["brief_material", "drop"], sets: ["training_or_sheet"],
    }],
    aboveFloor: [],
  };
  expect(questionEngine(elements, script.record).next()?.key).toBe("source");
  expect(questionEngine(elements, media.record).next()).toBeNull();
  /* The same re-carry from a record that already holds the carried row (the record writes `carry:<row>`). */
  const held = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", {
    ...fixture("menu-only").read,
    material: { value: "nothing", source: "said" },
    source: { value: "made", source: "earlier_step", carriedFrom: "material", fromStep: "brief" },
  }));
  expect(held.answer("material", "both").writes.map((w) => [w.key, w.value, w.source])).toEqual([["material", "both", "said"], ["source", "photos", "earlier_step"]]);
  /* A source the person answered is never overwritten, nor reopened, whatever material becomes. */
  let said = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ...fixture("menu-only").read, source: { value: "photos", source: "said" } }));
  for (const value of ["nothing", "media", "script", "both"]) said = said.answer("material", value);
  expect(said.writes.map((w) => w.key)).toEqual(["material", "material", "material", "material"]);
  expect(said.record.get("source")).toMatchObject({ value: "photos", source: "said" });
});

test("a changed kind reopens the length it set, unless the person said a length that still stands", () => {
  const record = (length: { value: string; source: "said" | "assumed" | "document" }) =>
    questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { kind: { value: "ad_film", source: "said" }, length }));
  /* A length the person did not answer reopens for the new kind, and is asked next with the new kind's pills. */
  for (const source of ["assumed", "document"] as const) {
    const changed = record({ value: "30s", source }).answer("kind", "short_film");
    expect(stateOf(changed, "length"), source).toBe("open");
    expect(changed.writes.at(-1)).toEqual({ workspaceId: WS_A, productionId: "p", key: "length", value: null, source: null, reason: "change", from: "kind" });
    expect(changed.next()?.pills.map((pill) => pill.id)).toEqual(["1min", "3min", "5min"]);
  }
  /* A said length that is not one of the new kind's choices reopens too. */
  expect(stateOf(record({ value: "30s", source: "said" }).answer("kind", "short_film"), "length")).toBe("open");
  /* A said length that still stands is kept: one of the new kind's pills, or the field's own words. */
  expect(stateOf(record({ value: "15s", source: "said" }).answer("kind", "social"), "length")).toBe("known");
  expect(record({ value: "45 seconds", source: "said" }).answer("kind", "short_film").rows.find((r) => r.key === "length")).toMatchObject({ state: "known", value: "45 seconds" });
  /* The same kind again changes nothing; kind and length said together keep the new length. */
  expect(record({ value: "30s", source: "assumed" }).answer("kind", "ad_film").writes.map((w) => w.key)).toEqual(["kind"]);
  expect(record({ value: "30s", source: "assumed" }).answer("kind", "short_film", { length: "5min" }).rows.find((r) => r.key === "length")).toMatchObject({ state: "known", value: "5min" });
});

test("person-only answers: words the caller read never set the spend limit or consent, and nothing is written", () => {
  const menu = engineFor(fixture("menu-only"));
  for (const also of [{ ceiling: "none" }, { real: "yes_consent" }] as Record<string, string>[]) {
    expect(() => menu.answer("length", "30s", also), JSON.stringify(also)).toThrow("Only a person can choose that answer.");
    expect(() => menu.answer("plays", "phone", also)).toThrow(QuestionEngineError);
  }
  expect(menu.writes).toEqual([]);
  expect(menu.record.get("length")).toBeNull();
  expect(menu.record.get("ceiling")).toBeNull();
  /* The person's own direct answer sets them; read words may still say no one is real. */
  expect(stateOf(menu.answer("ceiling", "none"), "ceiling")).toBe("known");
  expect(stateOf(menu.answer("real", "yes_consent"), "real")).toBe("known");
  expect(stateOf(menu.answer("length", "30s", { real: "no_one" }), "real")).toBe("known");
  /* Only what the person said answers the spend limit: a house default, a document or an assumption leaves it open. */
  for (const source of ["default", "document", "assumed", "earlier_step"] as const) {
    const engine = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ...fixture("synthetic-d11-deck").read, real: { value: "no_one", source: "said" }, ceiling: { value: "none", source } }));
    expect(stateOf(engine, "ceiling"), source).toBe("open");
    expect(engine.next()?.key, source).toBe("ceiling");
  }
  expect(stateOf(questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ceiling: { value: "none", source: "said" } })), "ceiling")).toBe("known");
});

test("Decide for me (answers 3 and 6): every open row at this step closed, floor and above, each 'I assumed … · Change'; the spend limit never written", () => {
  const picks = { "q:subject": "a ceramic mug", "q:message": "it keeps tea hot", "q:audience": "office workers", "q:tone": "calm" };
  for (const f of BRIEF_FIXTURES) {
    const start = engineFor(f);
    const wasOpen = start.rows.filter((row) => row.state === "open").map((row) => row.key);
    const decided = start.decideForMe({ kind: "ad_film", ...picks });
    /* Answer 3: nothing is left open at this step, floor or above the floor, and nothing more is asked. */
    expect(decided.open, f.id).toEqual([]);
    expect(decided.floorClosed, f.id).toBe(true);
    expect(decided.next(), f.id).toBeNull();
    /* Answer 6 and rule 14: the spend limit reads "I assumed no limit · Change", and nothing is written to it. */
    expect(decided.writes.some((w) => w.key === "ceiling"), f.id).toBe(false);
    expect(decided.record.get("ceiling")).toBeNull();
    expect(decided.rows.find((r) => r.key === "ceiling")).toEqual({
      key: "ceiling", floor: true, state: "assumed", value: "none", source: "assumed", fromStep: null, line: `${QUESTIONS.assumed} ${QUESTIONS.noLimit} · ${BUTTONS.change}`,
    });
    expect(decided.rows.find((r) => r.key === "ceiling")?.line).toBe("I assumed no limit · Change");
    for (const row of decided.rows) {
      if (row.key === "ceiling") continue;
      if (wasOpen.includes(row.key)) {
        expect([row.key, row.state, row.source]).toEqual([row.key, "assumed", "assumed"]);
        expect(row.line, `${f.id}: ${row.key}`).toMatch(/^I assumed .+ · Change$/);
      } else expect(row, `${f.id}: ${row.key} keeps its value`).toEqual(start.rows.find((r) => r.key === row.key));
    }
    expect(decided.writes.filter((w) => w.reason !== "carry").every((w) => w.reason === "decide_for_me" && w.source === "assumed")).toBe(true);
    /* The one row that is not a checklist row: "Decide for me" was pressed at the Brief. No figure, no cap, no limit. */
    expect(decided.writes.filter((w) => !FLOOR_KEYS.includes(w.key) && !ABOVE_KEYS.includes(w.key) && w.reason !== "carry")).toEqual([
      { workspaceId: WS_A, productionId: `prod_${f.id}`, key: decidedKey("brief"), value: "yes", source: "assumed", reason: "decide_for_me" },
    ]);
  }

  /* With no pick, a floor row takes its lit default (H ★), and length's default follows the kind decided just before it. */
  const nothing = engineFor(fixture("nothing"));
  const lit = nothing.decideForMe({ kind: "social", ...picks });
  const value = (key: string) => lit.rows.find((row) => row.key === key)?.value;
  expect(FLOOR_KEYS.map(value)).toEqual(["social", "15s", "wide", "hindi", "no_one", "nothing", "none"]);
  expect(lit.record.get("ceiling"), "the spend limit's \"none\" is shown, never written").toBeNull();
  /* Answer 8: a carried answer's source is "earlier step" with the step's name, whoever answered the row it came from. */
  expect(lit.writes.find((w) => w.key === "source")).toMatchObject({ value: "made", source: "earlier_step", reason: "carry", from: "material", fromStep: "brief" });
  /* Atomik's pick wins over the default where it is allowed. */
  expect(nothing.decideForMe({ kind: "ad_film", length: "60s", plays: "phone", ...picks }).rows.filter((r) => ["length", "plays"].includes(r.key)).map((r) => r.value)).toEqual(["60s", "phone"]);

  /* Rows a person alone answers (rule 11): Atomik never sets a spend limit, nor says consent is on file. */
  for (const ceiling of ["none", "production", "cap_500", "800"]) expect(() => nothing.decideForMe({ kind: "ad_film", ceiling, ...picks })).toThrow("Only a person can choose that answer.");
  expect(() => nothing.decideForMe({ kind: "ad_film", real: "yes_consent", ...picks })).toThrow(QuestionEngineError);
  /* …but a person can, and Atomik's lit pick on the card is never a person-only one. */
  expect(engineFor(fixture("menu-only")).answer("ceiling", "none").rows.find((r) => r.key === "ceiling")).toMatchObject({ state: "known", value: "none" });
  /* No figure is a choice: not a sample pill, not the field's words. */
  for (const figure of ["cap_200", "cap_500", "500"]) expect(() => engineFor(fixture("menu-only")).answer("ceiling", figure)).toThrow(QuestionEngineError);
  const ceilingCard = engineFor(fixture("synthetic-d11-deck")).answer("real", "no_one").next({ ceiling: "none" });
  expect(ceilingCard).toMatchObject({ key: "ceiling", field: false, fieldLabel: null });
  expect(ceilingCard?.pills).toEqual([{ id: "none", label: QUESTIONS.ceilingNone, lit: true }, { id: "production", label: QUESTIONS.ceilingOther, lit: false }]);

  /* A row with no default needs a pick: kind has no ★, an above-floor row never has one. */
  expect(() => nothing.decideForMe(picks)).toThrow(/kind/);
  expect(() => nothing.decideForMe({ kind: "ad_film" })).toThrow(/q:subject/);
  /* A pick for a row the record already holds is ignored: the person's value stands. */
  const deck = engineFor(fixture("synthetic-d11-deck"));
  expect(deck.decideForMe({ language: "english", ...picks }).rows.find((r) => r.key === "language")).toMatchObject({ value: "hindi", state: "known" });
  expect(() => deck.decideForMe({ nonsense: "x" })).toThrow(QuestionEngineError);
});

test("answers are checked, and an error never echoes the value", () => {
  const menu = engineFor(fixture("menu-only"));
  const secret = "the-sentinel-value-0042";
  for (const attempt of [() => menu.answer("plays", secret), () => menu.answer("not_a_row", secret), () => menu.answer("real", secret), () => menu.answer("plays", "")]) {
    let message = "";
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(QuestionEngineError);
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
  }
  /* The field takes words where the row has one ("Other"). */
  expect(menu.answer("language", "Tamil").rows.find((r) => r.key === "language")).toMatchObject({ state: "known", value: "Tamil" });
  expect(() => menu.answer("plays", "x".repeat(2001))).toThrow(QuestionEngineError);
  expect(() => menu.answer("length", "30s", { length: "60s" })).toThrow(QuestionEngineError);
});

test("deterministic: the same brief and the same answers give the same marks, order, questions and writes, twice", () => {
  const run = () =>
    BRIEF_FIXTURES.map((f) => {
      const start = engineFor(f);
      const { asked, end } = interview(start);
      const decided = start.decideForMe({ kind: "ad_film", "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" });
      return JSON.stringify({ rows: start.rows, open: start.open, next: start.next(), asked, end: end.rows, writes: end.writes, decided: decided.writes });
    });
  const first = run();
  expect(run()).toEqual(first);
  expect(new Set(first).size).toBe(BRIEF_FIXTURES.length);
});

test("tenant isolation: two workspaces' engines share nothing, and a row from another workspace is refused", () => {
  const a = engineFor(fixture("menu-only"), WS_A);
  const b = engineFor(fixture("menu-only"), WS_B);
  const bBefore = JSON.stringify(b.rows);
  const aAfter = a.answer("length", "60s").answer("material", "nothing").decideForMe({ "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" });
  expect(JSON.stringify(b.rows)).toBe(bBefore);
  expect(b.open).toContain("length");
  expect(aAfter.writes.length).toBeGreaterThan(0);
  expect(aAfter.writes.every((w) => w.workspaceId === WS_A && w.productionId === "prod_menu-only")).toBe(true);
  expect(aAfter.record.workspaceId).toBe(WS_A);
  /* B's engine, built after A's answers, still sees only B's record. */
  expect(stateOf(engineFor(fixture("menu-only"), WS_B), "length")).toBe("open");

  /* A view that leaks a row from another workspace is refused, never marked. */
  const leaky: RecordView = {
    workspaceId: WS_A,
    productionId: "prod_leak",
    get: (key) => (key === "language" ? { workspaceId: WS_B, value: "hindi", source: "said" } : null),
  };
  expect(() => questionEngine(AD_FILM_BRIEF, leaky)).toThrow("That row is not in this workspace.");
  /* No workspace, no engine; a source the record does not know is refused too. */
  expect(() => questionEngine(AD_FILM_BRIEF, inMemoryRecord("", "p", {}))).toThrow(QuestionEngineError);
  const oddSource = { workspaceId: WS_A, productionId: "p", get: () => ({ workspaceId: WS_A, value: "x", source: "guessed" }) } as unknown as RecordView;
  expect(() => questionEngine(AD_FILM_BRIEF, oddSource)).toThrow(QuestionEngineError);

  /* The platform's checklist is shared by every workspace, so no engine may change it. */
  expect(Object.isFrozen(AD_FILM_BRIEF.floor[0])).toBe(true);
  expect(() => {
    (AD_FILM_BRIEF.floor[0] as { rank: number }).rank = 99;
  }).toThrow(TypeError);
});

/* ---- The owner's answers, 24 October 2026 (14:55 IST, item 16) ---- */

const ELEMENTS_CONSENT: Checklist = {
  filmType: "ad_film",
  step: "elements",
  /* H, Elements › consent, as drafted (its checklist is a later step PR): a person ticks it, Atomik never does (rule 11). */
  floor: [{
    key: "consent", floor: true, step: "elements", rank: 1, question: "real", shape: "pick_one", field: false, money: true, personOnly: true,
    pills: { pills: [{ id: "yes" }, { id: "not_yet" }, { id: "not_real" }], lit: null }, prefill: CONSENT_FROM_BRIEF,
    answeredBy: ["brief_real", "library_consent"], sets: ["consent_tick"],
  }],
  aboveFloor: [],
};

test("answer 1, the order: by what changes the result or the price most, deterministic, the tie-break written down", () => {
  /* Every floor rank is used once on a checklist, so floor rows never tie; above the floor, the checklist's order decides. */
  const ranks = AD_FILM_BRIEF.floor.map((row) => row.rank);
  expect(new Set(ranks).size).toBe(ranks.length);
  expect(engineFor(fixture("nothing")).open.slice(FLOOR_KEYS.length)).toEqual(ABOVE_KEYS);
  /* The tie-break, on its own: two rows of the same rank are asked in the checklist's order, whichever way round they are listed. */
  const plays = AD_FILM_BRIEF.floor.find((r) => r.key === "plays")!;
  const language = AD_FILM_BRIEF.floor.find((r) => r.key === "language")!;
  const tied = (floor: FloorRow[]) => questionEngine({ filmType: "synthetic", step: "synthetic", floor, aboveFloor: [] }, inMemoryRecord(WS_A, "p", {})).open;
  expect(tied([{ ...plays, rank: 1 }, { ...language, rank: 1 }])).toEqual(["plays", "language"]);
  expect(tied([{ ...language, rank: 1 }, { ...plays, rank: 1 }])).toEqual(["language", "plays"]);
  /* Rank beats the checklist's order. */
  expect(tied([{ ...plays, rank: 2 }, { ...language, rank: 1 }])).toEqual(["language", "plays"]);
  /* The same inputs give the same order: the record's key order, the picks' order and the `also` words' order change nothing. */
  const read = fixture("synthetic-d11-voice-note").read;
  const reversed = Object.fromEntries(Object.entries(read).reverse());
  const one = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read));
  const two = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", reversed));
  expect(two.open).toEqual(one.open);
  expect(two.next()).toEqual(one.next());
  const picks = { kind: "ad_film", "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" };
  const picksReversed = Object.fromEntries(Object.entries(picks).reverse());
  expect(two.decideForMe(picksReversed).writes).toEqual(one.decideForMe(picks).writes);
  const menu = engineFor(fixture("menu-only"));
  expect(menu.answer("plays", "phone", { language: "english", length: "15s" }).writes).toEqual(menu.answer("plays", "phone", { length: "15s", language: "english" }).writes);
});

test("answer 2, D11: three synthetic briefs, each marked synthetic in its id and its data", () => {
  const d11 = BRIEF_FIXTURES.filter((f) => ["deck", "chat", "voice_note"].includes(f.shape));
  expect(d11.map((f) => f.shape)).toEqual(["deck", "chat", "voice_note"]);
  for (const f of d11) {
    expect(f.id, f.id).toMatch(/^synthetic-d11-/);
    expect(f.synthetic, f.id).toBe(true);
  }
});

test("answer 4: the Brief's \"real\" pre-fills Elements' consent; the engine never records a tick", () => {
  const brief = (real: string, source: "said" | "assumed" = "said") => inMemoryRecord(WS_A, "p", { kind: { value: "ad_film", source: "said" }, real: { value: real, source } });
  const lit = (real: string) => questionEngine(ELEMENTS_CONSENT, brief(real)).next()?.pills.find((pill) => pill.lit)?.id ?? null;
  /* Pre-filled: the person's Brief answer lights the consent pill for that person. */
  expect(lit("yes_consent")).toBe("yes");
  expect(lit("yes_not_yet")).toBe("not_yet");
  expect(lit("no_one")).toBeNull();
  expect(lit("product_only")).toBeNull();
  /* Never a tick: the row stays open (a person ticks it, with who, when and an optional file), and nothing is written. */
  const atElements = questionEngine(ELEMENTS_CONSENT, brief("yes_consent"));
  expect(atElements.rows[0]).toMatchObject({ key: "consent", state: "open", value: null, line: null });
  expect(atElements.writes).toEqual([]);
  expect(atElements.record.get("consent")).toBeNull();
  /* "Decide for me" leaves it open and writes no tick; a pick for it is refused; words the caller read never tick it. */
  const decided = atElements.decideForMe({});
  expect(decided.open).toEqual(["consent"]);
  expect(decided.writes.some((w) => w.key === "consent")).toBe(false);
  expect(decided.next()?.pills.find((pill) => pill.lit)?.id).toBe("yes");
  expect(() => atElements.decideForMe({ consent: "yes" })).toThrow("Only a person can choose that answer.");
  /* At the Brief, no answer to "real", nor "Decide for me", writes anything for consent. */
  for (const real of ["yes_consent", "yes_not_yet", "no_one", "product_only"]) {
    expect(engineFor(fixture("menu-only")).answer("real", real).writes.map((w) => w.key)).toEqual(["real"]);
  }
  expect(engineFor(fixture("nothing")).decideForMe({ kind: "ad_film", "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" }).writes.some((w) => w.key === "consent")).toBe(false);
  /* Only the person's own direct answer sets it. */
  expect(atElements.answer("consent", "yes").rows[0]).toMatchObject({ state: "known", value: "yes", source: "said" });
});

test("answer 5: the spend limit's platform default is No limit, a house default is proposed and never written, a workspace default never applies", () => {
  const ceiling = AD_FILM_BRIEF.floor.find((r) => r.key === "ceiling")!;
  /* Never a platform default other than No limit: the lit pill and what "Decide for me" shows are "none"; the only other pill is
     Other, a reference to the production's own cap that holds no figure (answer 4). */
  expect("by" in ceiling.pills).toBe(false);
  expect(ceiling.pills).toEqual({ pills: [{ id: "none", copy: "ceilingNone", inLine: "noLimit" }, { id: "production", copy: "ceilingOther" }], lit: "none" });
  expect(ceiling.decidedShows).toBe("none");
  expect(ceiling.proposedBy).toEqual(["house_default"]);
  expect(ceiling.answeredBy).not.toContain("house_default");
  /* A house default (three answers the same way) is proposed: lit on the card for the person to tap. It answers nothing. */
  const house = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ...fixture("synthetic-d11-deck").read, real: { value: "no_one", source: "said" }, ceiling: { value: "none", source: "default" } }));
  expect(house.rows.find((r) => r.key === "ceiling")).toMatchObject({ state: "open", line: null });
  expect(house.next()).toMatchObject({ key: "ceiling", pills: [{ id: "none", lit: true }, { id: "production", lit: false }] });
  expect(house.writes).toEqual([]);
  /* "Decide for me" over it writes no limit either. */
  expect(house.decideForMe({ "q:tone": "t" }).writes.some((w) => w.key === "ceiling")).toBe(false);

  /* The proposal mechanism on its own, on a person-only row with two pills (not a spend limit): a house default it lists in
     `proposedBy` lights its pill; one it does not list, and a workspace default, never do. */
  const two: FloorRow = { ...ceiling, key: "stop", pills: { pills: [{ id: "a" }, { id: "b" }], lit: "a" } };
  const card = (rows: Record<string, { value: string; source: "default" }>, row: FloorRow, defaults?: Record<string, string>) =>
    questionEngine({ filmType: "synthetic", step: "synthetic", floor: [row], aboveFloor: [] }, inMemoryRecord(WS_A, "p", rows), defaults ? { workspaceId: WS_A, values: defaults } : undefined)
      .next()?.pills.find((pill) => pill.lit)?.id;
  expect(card({ stop: { value: "b", source: "default" } }, two)).toBe("b");
  expect(card({ stop: { value: "b", source: "default" } }, { ...two, proposedBy: [] })).toBe("a");
  expect(card({}, two, { stop: "b" })).toBe("a");
  /* A workspace default for the spend limit is ignored, and "Decide for me" still writes nothing to it. */
  const wsDefault = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", fixture("menu-only").read), { workspaceId: WS_A, values: { ceiling: "none" } });
  expect(wsDefault.decideForMe({ "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" }).writes.some((w) => w.key === "ceiling")).toBe(false);
});

test("answer 6: after Decide for me the spend limit reads \"I assumed no limit · Change\" and is not asked again, with nothing written", () => {
  const decided = engineFor(fixture("synthetic-d11-deck")).decideForMe({ "q:tone": "warm" });
  expect(decided.writes.find((w) => w.key === "ceiling")).toBeUndefined();
  expect(decided.record.get("ceiling")).toBeNull();
  /* A later session over the record (the next turn, or the Elements step coming back to the Brief) reads it the same way. */
  const later = questionEngine(AD_FILM_BRIEF, decided.record);
  expect(later.rows.find((r) => r.key === "ceiling")).toMatchObject({ state: "assumed", value: "none", line: "I assumed no limit · Change" });
  expect(later.open).toEqual([]);
  expect(later.next()).toBeNull();
  /* Pressing it again writes nothing new for the step. */
  expect(later.decideForMe({}).writes).toEqual([]);
  /* Change: the person's own answer still sets it, and then it is theirs. */
  const changed = later.answer("ceiling", "none");
  expect(changed.rows.find((r) => r.key === "ceiling")).toMatchObject({ state: "known", value: "none", source: "said", line: "from you · Change" });
  /* Without "Decide for me", the spend limit is still asked. */
  expect(engineFor(fixture("synthetic-d11-deck")).answer("real", "no_one").next()?.key).toBe("ceiling");
});

test("answer 7: Hindi ★ is the platform default; the workspace default overrides it; the house default overrides both", () => {
  const menuRead = fixture("menu-only").read;
  const at = (defaults?: Record<string, string>, rows: Record<string, { value: string; source: "said" | "default" }> = {}) =>
    questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ...menuRead, length: { value: "30s", source: "said" }, plays: { value: "wide", source: "said" }, ...rows }), defaults ? { workspaceId: WS_A, values: defaults } : undefined);
  const litLanguage = (engine: QuestionEngine) => {
    const q = engine.next();
    expect(q?.key).toBe("language");
    return q?.pills.find((pill) => pill.lit)?.id;
  };
  const above = { "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" };
  const decidedLanguage = (engine: QuestionEngine) => engine.decideForMe(above).rows.find((r) => r.key === "language");
  /* Platform: Hindi. */
  expect(litLanguage(at())).toBe("hindi");
  expect(decidedLanguage(at())).toMatchObject({ value: "hindi", state: "assumed", line: "I assumed Hindi · Change" });
  /* Workspace over platform: lit, and what "Decide for me" takes; it answers nothing. */
  expect(litLanguage(at({ language: "english" }))).toBe("english");
  expect(stateOf(at({ language: "english" }), "language")).toBe("open");
  expect(decidedLanguage(at({ language: "english" }))).toMatchObject({ value: "english", state: "assumed", line: "I assumed English · Change" });
  /* House over workspace: a house default answers the row (H), so it is not asked, whatever the workspace default. */
  const house = at({ language: "english" }, { language: { value: "both", source: "default" } });
  expect(house.rows.find((r) => r.key === "language")).toMatchObject({ state: "assumed", value: "both", source: "default", line: "I assumed Both · Change" });
  expect(house.next()?.key).toBe("real");
  expect(decidedLanguage(house)).toMatchObject({ value: "both", source: "default" });
  /* Atomik's own pick still comes first where it is allowed (H: "Atomik's pick already lit"). */
  expect(at({ language: "english" }).next({ language: "both" })?.pills.find((pill) => pill.lit)?.id).toBe("both");
  /* A workspace default that is no pill (the field's words) lights nothing new: Hindi stays lit. */
  expect(litLanguage(at({ language: "Tamil" }))).toBe("hindi");
  /* A workspace default lights a person's own choice, but "Decide for me" never takes it (rule 11). */
  const real = at({ real: "yes_consent" }, { language: { value: "hindi", source: "said" } });
  expect(real.next()?.pills.find((pill) => pill.lit)?.id).toBe("yes_consent");
  expect(real.decideForMe(above).rows.find((r) => r.key === "real")?.value).toBe("no_one");
  /* Rule 2: another workspace's defaults are refused. */
  expect(() => questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", menuRead), { workspaceId: WS_B, values: { language: "english" } })).toThrow("That row is not in this workspace.");
});

test("answer 8: a carried answer's source is \"earlier step\", with the step's name", () => {
  const above = { "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" };
  const elements: Checklist = {
    filmType: "ad_film",
    step: "elements",
    floor: [{
      key: "source", floor: true, step: "elements", rank: 1, question: "material", shape: "upload", field: false, money: true,
      pills: { pills: [{ id: "photos" }, { id: "made" }], lit: "made" }, answeredBy: ["brief_material", "drop"], sets: ["training_or_sheet"],
    }],
    aboveFloor: [],
  };
  /* Whether the person said the Brief's answer or "Decide for me" assumed it, the carry is "earlier step · Brief", and at Elements it
     reads as a guess until a person confirms it (owner, 25 Oct 2026, answer 3). */
  for (const [brief, carried] of [[engineFor(fixture("menu-only")).answer("material", "media"), "photos"], [engineFor(fixture("menu-only")).decideForMe(above), "made"]] as const) {
    const carry = brief.writes.find((w) => w.reason === "carry");
    expect(carry).toMatchObject({ key: "source", source: "earlier_step", from: "material", fromStep: "brief" });
    const row = questionEngine(elements, brief.record).rows[0];
    expect(row).toMatchObject({ state: "known", value: carried, source: "earlier_step", fromStep: "brief", line: `I assumed ${carried} · Change` });
  }
  /* The step's name comes from the copy table. */
  expect(QUESTIONS.fromThe).toBe("from the");
});

/* ---- The owner's answers, 25 October 2026 (01:05 IST, answer 3: follow-ups to the core) ---- */

test("answer 3 (b): any member sets the spend limit; lifting a cap already set is an owner's or an admin's; Atomik never sets it", () => {
  const ceiling = AD_FILM_BRIEF.floor.find((r) => r.key === "ceiling")!;
  expect(ceiling.raises).toEqual(["none"]);
  const read = { ...fixture("synthetic-d11-deck").read, real: { value: "no_one", source: "said" as const } };
  const at = (caps?: { production: boolean; workspace: boolean }) =>
    questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read), undefined, caps ? { workspaceId: WS_A, productionId: "p", ...caps } : undefined);
  const ceilingOf = (engine: QuestionEngine) => engine.rows.find((r) => r.key === "ceiling");

  /* No cap set: any member answers it, as an owner or admin does; and without a role, as before. */
  for (const role of ["member", "admin", "owner"] as const) {
    expect(ceilingOf(at({ production: false, workspace: false }).answer("ceiling", "none", {}, { role })), role).toMatchObject({ state: "known", value: "none", source: "said" });
  }
  expect(ceilingOf(at().answer("ceiling", "none"))).toMatchObject({ state: "known", source: "said" });

  /* A cap set on the production, or a monthly limit on the workspace: No limit would lift it, so a member is refused, and an
     answer with no role is refused too. Nothing is written, and the error names the row, never the value. */
  for (const caps of [{ production: true, workspace: false }, { production: false, workspace: true }, { production: true, workspace: true }]) {
    const engine = at(caps);
    for (const by of [{ role: "member" as const }, undefined]) {
      let message = "";
      try {
        engine.answer("ceiling", "none", {}, by);
      } catch (error) {
        expect(error).toBeInstanceOf(QuestionEngineError);
        message = (error as Error).message;
      }
      expect(message, JSON.stringify({ caps, by })).toBe("Only an owner or admin can raise the spend limit.");
      expect(message).not.toContain("none");
    }
    expect(engine.writes).toEqual([]);
    expect(engine.record.get("ceiling")).toBeNull();
    expect(engine.next()?.key).toBe("ceiling");
    /* An owner or an admin lifts it: the person's own answer, source "said". */
    for (const role of ["owner", "admin"] as const) {
      const lifted = engine.answer("ceiling", "none", {}, { role });
      expect(ceilingOf(lifted), role).toMatchObject({ state: "known", value: "none", source: "said" });
      expect(lifted.writes).toEqual([{ workspaceId: WS_A, productionId: "p", key: "ceiling", value: "none", source: "said", reason: "answer" }]);
    }
    /* Only the spend limit is held to it: a member still answers every other row. */
    expect(stateOf(engine.answer("q:tone", "calm", {}, { role: "member" }), "q:tone")).toBe("known");

    /* Atomik and words the caller read are refused as before, whatever role the person has (rule 11, rule 14). */
    expect(() => engine.decideForMe({ ceiling: "none", "q:tone": "t" })).toThrow("Only a person can choose that answer.");
    expect(() => engine.answer("q:tone", "calm", { ceiling: "none" }, { role: "admin" })).toThrow("Only a person can choose that answer.");
    expect(engine.decideForMe({ "q:tone": "t" }).writes.some((w) => w.key === "ceiling")).toBe(false);
  }

  /* A role this workspace does not have is not an owner or an admin. */
  expect(() => at({ production: true, workspace: false }).answer("ceiling", "none", {}, { role: "super" } as unknown as { role: "member" })).toThrow(QuestionEngineError);
  /* Rule 2: another workspace's caps are refused, never read; so is a cap that is not a yes or a no. */
  expect(() => questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read), undefined, { workspaceId: WS_B, productionId: "p", production: true, workspace: false })).toThrow("That row is not in this workspace.");
  expect(() => questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read), undefined, { workspaceId: WS_A, productionId: "p", production: 1, workspace: false } as unknown as { workspaceId: string; productionId: string; production: boolean; workspace: boolean })).toThrow(QuestionEngineError);
  /* Another production's caps in the same workspace are refused too: "no cap here" is this production's, never another's. */
  expect(() => questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read), undefined, { workspaceId: WS_A, productionId: "p_other", production: false, workspace: false })).toThrow("That row is not in this workspace.");
  expect(() => questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read), undefined, { workspaceId: WS_A, production: false, workspace: false } as unknown as { workspaceId: string; productionId: string; production: boolean; workspace: boolean })).toThrow(QuestionEngineError);
});

test("answer 3 (a): a guess reads \"I assumed … · Change\" until a person confirms it; their answer reads \"from you\"; only a file's answer reads \"from the brief\", with its page", () => {
  const above = { "q:subject": "s", "q:message": "m", "q:audience": "a", "q:tone": "t" };
  const elements: Checklist = {
    filmType: "ad_film",
    step: "elements",
    floor: [{
      key: "source", floor: true, step: "elements", rank: 1, question: "material", shape: "upload", field: false, money: true,
      pills: { pills: [{ id: "photos" }, { id: "made" }], lit: "made" }, answeredBy: ["brief_material", "drop"], sets: ["training_or_sheet"],
    }],
    aboveFloor: [],
  };
  const sourceOf = (engine: QuestionEngine) => engine.rows.find((r) => r.key === "source");
  /* Carried from a person's own Brief answer: still a guess at Elements. Confirmed by the person there: theirs. */
  const atElements = questionEngine(elements, engineFor(fixture("menu-only")).answer("material", "nothing").record);
  expect(sourceOf(atElements)).toMatchObject({ value: "made", source: "earlier_step", line: "I assumed made · Change" });
  expect(sourceOf(atElements.answer("source", "made"))).toMatchObject({ value: "made", source: "said", line: "from you · Change" });
  expect(sourceOf(atElements.answer("source", "photos"))).toMatchObject({ value: "photos", source: "said", line: "from you · Change" });
  /* Decide for me's picks read as guesses; a person's answer at the Brief reads "from you". */
  const decided = engineFor(fixture("menu-only")).decideForMe(above);
  for (const row of decided.rows.filter((r) => r.source === "assumed")) expect(row.line, row.key).toMatch(/^I assumed .+ · Change$/);
  expect(engineFor(fixture("menu-only")).answer("material", "nothing").rows.find((r) => r.key === "material")?.line).toBe("from you · Change");
  /* A row a file answered reads "from the brief", at any step, and carries the file's page for the chip; nothing else carries one. */
  const filed = (page?: number) => questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { language: { value: "english", source: "document", ...(page === undefined ? {} : { page }) } }));
  expect(filed(3).rows.find((r) => r.key === "language")).toMatchObject({ state: "known", source: "document", line: "from the brief · Change", page: 3 });
  expect(filed().rows.find((r) => r.key === "language")).toMatchObject({ line: "from the brief · Change" });
  expect(filed().rows.find((r) => r.key === "language")).not.toHaveProperty("page");
  expect(sourceOf(questionEngine(elements, inMemoryRecord(WS_A, "p", { source: { value: "photos", source: "document", page: 2 } })))).toMatchObject({ line: "from the brief · Change", page: 2 });
  const saidWithPage = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { language: { value: "english", source: "said", page: 4 } }));
  expect(saidWithPage.rows.find((r) => r.key === "language")).toMatchObject({ line: "from you · Change" });
  expect(saidWithPage.rows.find((r) => r.key === "language")).not.toHaveProperty("page");
  /* A page that is not a whole page number is refused like any row the record could not have written, never echoed. */
  for (const page of [0, -1, 1.5, Number.NaN]) expect(() => filed(page), String(page)).toThrow("That row is not in this workspace.");
  /* The words are the copy table's. */
  expect(QUESTIONS.fromYou).toBe("from you");
  expect(QUESTIONS.assumed).toBe("I assumed");
});

test("answer 4: Other records a reference to the production's own cap, never a figure; only a person picks it", () => {
  const read = { ...fixture("synthetic-d11-deck").read, real: { value: "no_one", source: "said" as const } };
  const at = (caps?: { production: boolean; workspace: boolean }) =>
    questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", read), undefined, caps ? { workspaceId: WS_A, productionId: "p", ...caps } : undefined);

  /* A person's Other is written as "production" ({"cap":"production"}), whoever they are: its figure was judged and set as the
     production's cap before the row is answered (lib/caps.ts setCapFromBrief), so the engine never sees one. */
  for (const caps of [undefined, { production: false, workspace: false }, { production: true, workspace: true }]) {
    for (const role of ["member", "admin", "owner"] as const) {
      const engine = at(caps).answer("ceiling", "production", {}, { role });
      expect(engine.rows.find((r) => r.key === "ceiling"), JSON.stringify({ caps, role })).toMatchObject({ state: "known", value: "production", source: "said", line: "from you · Change" });
      expect(engine.writes.filter((w) => w.key === "ceiling").map((w) => w.value)).toEqual(["production"]);
    }
  }
  /* Never Atomik's, never words read for another row, never a figure in its place. */
  expect(() => at().decideForMe({ ceiling: "production", "q:tone": "t" })).toThrow("Only a person can choose that answer.");
  expect(() => at().answer("q:tone", "calm", { ceiling: "production" })).toThrow(QuestionEngineError);
  for (const figure of ["production:500", "500", "cap_500", " production"]) expect(() => at().answer("ceiling", figure)).toThrow(QuestionEngineError);
});
