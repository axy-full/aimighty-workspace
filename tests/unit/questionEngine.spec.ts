import { test, expect } from "@playwright/test";
import { QUESTIONS } from "../../lib/copy";
import { AD_FILM_BRIEF, checklistFor } from "../../lib/productionModel/checklists";
import { inMemoryRecord, questionEngine, QuestionEngineError, type QuestionEngine } from "../../lib/productionModel/questionEngine";
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
  expect(row("ceiling")).toMatchObject({ personOnly: true, field: false, pills: { pills: [{ id: "none", copy: "ceilingNone" }], lit: "none" } });
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
  const deck = fixture("d11-deck");
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
  const deck = engineFor(fixture("d11-deck"));
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
    { workspaceId: WS_A, productionId: "prod_menu-only", key: "source", value: "made", source: "earlier_step", reason: "carry", from: "material" },
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
    { workspaceId: WS_A, productionId: "prod_menu-only", key: "source", value: "photos", source: "earlier_step", reason: "carry", from: "material" },
  ]);
  expect(media.record.get("source")).toMatchObject({ value: "photos", source: "earlier_step", carriedFrom: "material" });
  /* media → script: a script carries nothing, so the carried source reopens, and the Elements step asks it. */
  const script = media.answer("material", "script");
  expect(script.writes.at(-1)).toEqual({ workspaceId: WS_A, productionId: "prod_menu-only", key: "source", value: null, source: null, reason: "carry", from: "material" });
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
    source: { value: "made", source: "earlier_step", carriedFrom: "material" },
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
    const engine = questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ...fixture("d11-deck").read, real: { value: "no_one", source: "said" }, ceiling: { value: "none", source } }));
    expect(stateOf(engine, "ceiling"), source).toBe("open");
    expect(engine.next()?.key, source).toBe("ceiling");
  }
  expect(stateOf(questionEngine(AD_FILM_BRIEF, inMemoryRecord(WS_A, "p", { ceiling: { value: "none", source: "said" } })), "ceiling")).toBe("known");
});

test("Decide for me: nothing left open but the spend limit, every other open row assumed with Atomik's pick, known rows untouched", () => {
  const picks = { "q:subject": "a ceramic mug", "q:message": "it keeps tea hot", "q:audience": "office workers", "q:tone": "calm" };
  for (const f of BRIEF_FIXTURES) {
    const start = engineFor(f);
    const wasOpen = start.rows.filter((row) => row.state === "open").map((row) => row.key);
    const decided = start.decideForMe({ kind: "ad_film", ...picks });
    /* The spend limit is never written by "Decide for me": unset, it means no limit, and only a person sets one. */
    expect(decided.open, f.id).toEqual(["ceiling"]);
    expect(decided.writes.some((w) => w.key === "ceiling"), f.id).toBe(false);
    expect(decided.record.get("ceiling")).toBeNull();
    expect(decided.next()?.key).toBe("ceiling");
    for (const row of decided.rows) {
      if (row.key === "ceiling") expect(row).toEqual(start.rows.find((r) => r.key === "ceiling"));
      else if (wasOpen.includes(row.key)) expect([row.key, row.state, row.source]).toEqual([row.key, "assumed", "assumed"]);
      else expect(row, `${f.id}: ${row.key} keeps its value`).toEqual(start.rows.find((r) => r.key === row.key));
    }
    expect(decided.writes.filter((w) => w.reason !== "carry").every((w) => w.reason === "decide_for_me" && w.source === "assumed")).toBe(true);
  }

  /* With no pick, a floor row takes its lit default (H ★), and length's default follows the kind decided just before it. */
  const nothing = engineFor(fixture("nothing"));
  const lit = nothing.decideForMe({ kind: "social", ...picks });
  const value = (key: string) => lit.rows.find((row) => row.key === key)?.value;
  expect(FLOOR_KEYS.map(value)).toEqual(["social", "15s", "wide", "hindi", "no_one", "nothing", null]);
  /* What Atomik assumed carries as assumed, so it reads "I assumed … · Change" downstream too. */
  expect(lit.writes.find((w) => w.key === "source")).toMatchObject({ value: "made", source: "assumed", reason: "carry", from: "material" });
  /* Atomik's pick wins over the default where it is allowed. */
  expect(nothing.decideForMe({ kind: "ad_film", length: "60s", plays: "phone", ...picks }).rows.filter((r) => ["length", "plays"].includes(r.key)).map((r) => r.value)).toEqual(["60s", "phone"]);

  /* Rows a person alone answers (rule 11): Atomik never sets a spend limit, nor says consent is on file. */
  for (const ceiling of ["none", "cap_500", "800"]) expect(() => nothing.decideForMe({ kind: "ad_film", ceiling, ...picks })).toThrow("Only a person can choose that answer.");
  expect(() => nothing.decideForMe({ kind: "ad_film", real: "yes_consent", ...picks })).toThrow(QuestionEngineError);
  /* …but a person can, and Atomik's lit pick on the card is never a person-only one. */
  expect(engineFor(fixture("menu-only")).answer("ceiling", "none").rows.find((r) => r.key === "ceiling")).toMatchObject({ state: "known", value: "none" });
  /* No figure is a choice: not a sample pill, not the field's words. */
  for (const figure of ["cap_200", "cap_500", "500"]) expect(() => engineFor(fixture("menu-only")).answer("ceiling", figure)).toThrow(QuestionEngineError);
  const ceilingCard = engineFor(fixture("d11-deck")).answer("real", "no_one").next({ ceiling: "none" });
  expect(ceilingCard).toMatchObject({ key: "ceiling", field: false, fieldLabel: null });
  expect(ceilingCard?.pills).toEqual([{ id: "none", label: QUESTIONS.ceilingNone, lit: true }]);

  /* A row with no default needs a pick: kind has no ★, an above-floor row never has one. */
  expect(() => nothing.decideForMe(picks)).toThrow(/kind/);
  expect(() => nothing.decideForMe({ kind: "ad_film" })).toThrow(/q:subject/);
  /* A pick for a row the record already holds is ignored: the person's value stands. */
  const deck = engineFor(fixture("d11-deck"));
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
