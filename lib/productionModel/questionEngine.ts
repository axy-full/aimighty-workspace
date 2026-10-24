import { BUTTONS, QUESTIONS, STEPS } from "../copy";
import type {
  Checklist, ChecklistRow, FloorRow, MarkedRow, Pill, Picks, PillSet, Question, RecordValue, RecordView, RecordWrite, RowSource, RowState,
  WorkspaceDefaults,
} from "./questionTypes";

/**
 * The question engine's deterministic core (Amendment, 22 October 2026 (iii), G "Questions", H; SOW R2; PR plan L5).
 *
 *   "The question engine reads the step's checklist (D1), marks each row known / assumed / open from the record, orders the open
 *    rows by what changes the result or the price most, and asks the first; after each answer it re-marks (an answer often closes
 *    two rows) and asks the next. Deterministic and tested on mocked briefs (R2). 'Decide for me' closes every open row with the
 *    agent's pick and shows them as 'I assumed … · Change'."
 *
 * Pure: no model, no database, no clock, no randomness, no price. The same checklist and record give the same marks, order,
 * question and writes, every time. Atomik's picks arrive as input (`decideForMe(picks)`); a person's answer arrives as input
 * (`answer`). The engine never writes the record: it returns the rows it would write (`writes`), and the record's writer
 * (film-record-schema, M2) commits them. Nothing here is wired to a button, a route or a registry tool.
 *
 * The marks (R2; film-record-schema A.2 `source`):
 *   - known:   the person said it, a document says it, or an earlier step carried it   ("from the brief · Change");
 *   - assumed: a house default (D8) or Atomik's pick ("Decide for me")                  ("I assumed … · Change");
 *   - open:    nothing in the record answers it.
 *
 * The order (G and H: "orders the open rows by what changes the result or the price most"; the owner, 24 Oct 2026, answer 1:
 * as H says, deterministic, the tie-break written down):
 *   1. floor rows before above-floor rows (H: a floor row is one with money attached, "must be known before money moves";
 *      above it, Atomik asks in its own words and nothing there is priced);
 *   2. a row is never asked while a row it reads is open (`dependsOn`: length's pills are by kind, so kind comes first);
 *   3. then by rank, 1 first: each floor row's rank is what it changes in the result or the price, read from H's "Sets" and
 *      "Why floor" columns (lib/productionModel/checklists.ts); every floor rank on a checklist is used once;
 *   4. the tie-break: the checklist's own order (H's table order for the floor; G's ASKS order above it). Above-floor rows have
 *      no rank, so they always fall to it.
 * The order reads only the checklist and which rows are open: never the record's key order, the picks' or the `also` words'
 * order, a clock or a random number. The same inputs give the same order.
 *
 * The lit pill (★, H: "Atomik's pick already lit as the default"), first that is one of the row's pills now:
 *   Atomik's pick, where Atomik may pick it; then what an earlier row pre-fills (`prefill`: the Brief's "real" lights Elements'
 *   consent, answer 4); then the house default (a row the workspace answered the same way three times, in the record with source
 *   `default`: it answers an ordinary row, so here it only ever lights a person-only row that lists it in `proposedBy`, the spend
 *   limit, answer 5); then the workspace's own default (`WorkspaceDefaults`, answer 7; never on a person-only row); then the
 *   platform's (the checklist's ★: Hindi for language, No limit for the spend limit). "Decide for me" takes the same chain, less
 *   what Atomik may not pick, where Atomik gives no pick. House over workspace over platform (answer 7): the spec orders the
 *   workspace over the platform (SOW §2.3, Setup: platform → workspace → project → shot) and is silent on house against
 *   workspace, so the owner's order stands.
 *
 * "Decide for me" (G; owner, 24 Oct 2026, answers 3 and 6) closes every open row at this step, floor and above the floor, each then
 * reading "I assumed … · Change". A person-only row is never written: the spend limit reads "I assumed no limit · Change"
 * (`decidedShows`) and is not asked again, from one record row that says "Decide for me" was pressed at this step
 * (`decidedKey(step)`), which holds no figure, no cap and no limit. Nothing is set for the cap, which is what no limit means.
 *
 * Tenancy (rule 2): an engine is bound to its record's workspace and production. Every write carries both; a row the view
 * returns from another workspace is refused, never marked.
 */

export class QuestionEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionEngineError";
  }
}

/* Errors never echo a value (film-record-schema A.0): they name the row, at most. */
const NOT_HERE = "That row is not in this workspace.";
const NOT_ON_LIST = "That row is not on this step's checklist.";
const NOT_A_CHOICE = "That answer is not one of this question's choices.";
const PERSON_ONLY = "Only a person can choose that answer.";

/** The longest value a row holds (film-record-schema A.2: value ≤ 2,000 chars). */
export const MAX_VALUE = 2000;
/** An above-floor row's key (film-record-schema A.2: `q:<slug>`). */
const ABOVE_KEY = /^q:[a-z0-9_]{1,40}$/;

const STATE_OF: Readonly<Record<RowSource, RowState>> = {
  said: "known",
  document: "known",
  earlier_step: "known",
  default: "assumed",
  assumed: "assumed",
};
const isSource = (value: unknown): value is RowSource => typeof value === "string" && Object.hasOwn(STATE_OF, value);

/**
 * The record row that says "Decide for me" was pressed at a step (value "yes", source `assumed`). It is not a checklist row and
 * never a question: it only lets a person-only row read its `decidedShows` without that row ever being written.
 */
export const decidedKey = (step: string) => `decided:${step}`;

/**
 * A record view over plain rows: what fixtures, and the engine's own session, read. The record's store (M2) will satisfy the
 * same interface from `film_record_rows`.
 */
export function inMemoryRecord(
  workspaceId: string,
  productionId: string,
  rows: Readonly<Record<string, { value: string; source: RowSource; carriedFrom?: string; fromStep?: string }>>,
): RecordView {
  const held = new Map(
    Object.entries(rows).map(([key, row]) => [
      key,
      Object.freeze({
        workspaceId, value: row.value, source: row.source,
        ...(row.carriedFrom ? { carriedFrom: row.carriedFrom } : {}), ...(row.fromStep ? { fromStep: row.fromStep } : {}),
      }),
    ]),
  );
  return Object.freeze({ workspaceId, productionId, get: (key: string) => held.get(key) ?? null });
}

/** The base record with this session's writes on top; the latest write to a key wins, and a null write reopens the row. */
function withWrites(base: RecordView, writes: readonly RecordWrite[]): RecordView {
  const latest = new Map<string, RecordValue | null>();
  for (const write of writes) {
    latest.set(
      write.key,
      write.value === null || write.source === null
        ? null
        : {
          workspaceId: write.workspaceId, value: write.value, source: write.source,
          ...(write.reason === "carry" && write.from ? { carriedFrom: write.from } : {}),
          ...(write.reason === "carry" && write.fromStep ? { fromStep: write.fromStep } : {}),
        },
    );
  }
  return Object.freeze({ workspaceId: base.workspaceId, productionId: base.productionId, get: (key: string) => (latest.has(key) ? latest.get(key)! : base.get(key)) });
}

/** Every pill a row can show, whatever the row it reads holds. */
const everyPillOf = (row: FloorRow): Pill[] => ("by" in row.pills ? Object.values(row.pills.sets) : [row.pills]).flatMap((set) => set.pills);
const everyPill = (row: FloorRow): string[] => everyPillOf(row).map((pill) => pill.id);

export interface QuestionEngine {
  readonly workspaceId: string;
  readonly productionId: string;
  /** Every row of the checklist, floor first, each marked. */
  readonly rows: readonly MarkedRow[];
  /** The open rows' keys, in asking order (see "The order"). */
  readonly open: readonly string[];
  /** True when no floor row is open: from here only Atomik's above-floor questions remain. */
  readonly floorClosed: boolean;
  /** The next one question: the first open floor row nothing it reads is waiting on, with Atomik's pick lit; null when the floor is closed. */
  next(picks?: Picks): Question | null;
  /**
   * A person's answer to one row (source `said`), then re-marked. `also` holds other rows the same answer stated (the field's
   * words, read by the caller, can answer two rows at once). An answer that H says answers another row carries to it.
   */
  answer(key: string, value: string, also?: Readonly<Record<string, string>>): QuestionEngine;
  /**
   * "Decide for me": every open row at this step closed with Atomik's pick (source `assumed`), floor and above the floor (answer
   * 3). A floor row without a pick takes its lit default (see "The lit pill"); an above-floor row has none, so it needs a pick. A
   * row with `agentPicks` takes only what Atomik may assume. A person-only row is never written and a pick for it is refused: the
   * spend limit reads "I assumed no limit · Change" and is not asked again (answer 6); one without `decidedShows` (consent) stays
   * open. Rows that are already known or assumed keep their value.
   */
  decideForMe(picks: Picks): QuestionEngine;
  /** Whether Atomik may ask an above-floor question about `key`: never a floor row, never a row the record holds (H). */
  mayAsk(key: string): boolean;
  /** The rows this session wrote, in order, for the record's writer. */
  readonly writes: readonly RecordWrite[];
  /** The record as this session leaves it: the base view with `writes` on top. The next step's engine reads it. */
  readonly record: RecordView;
}

/** An engine over one step's checklist and one production's record, with the workspace's own defaults where it has any. */
export function questionEngine(checklist: Checklist, record: RecordView, defaults?: WorkspaceDefaults): QuestionEngine {
  if (!record || typeof record.workspaceId !== "string" || !record.workspaceId || typeof record.productionId !== "string" || !record.productionId) {
    throw new QuestionEngineError(NOT_HERE);
  }
  /* Rule 2: another workspace's defaults are refused, never read. */
  if (defaults !== undefined && (!defaults || defaults.workspaceId !== record.workspaceId || !defaults.values || typeof defaults.values !== "object")) {
    throw new QuestionEngineError(NOT_HERE);
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults?.values ?? {})) if (typeof value === "string") values[key] = value;
  return build(checklist, record, [], Object.freeze(values));
}

function pillsOf(row: FloorRow, read: (key: string) => RecordValue | null): PillSet {
  if (!("by" in row.pills)) return row.pills;
  const on = read(row.pills.by)?.value;
  return (on !== undefined && Object.hasOwn(row.pills.sets, on) ? row.pills.sets[on] : null) ?? { pills: [], lit: null };
}

function build(checklist: Checklist, base: RecordView, writes: readonly RecordWrite[], workspaceDefaults: Readonly<Record<string, string>>): QuestionEngine {
  const view = withWrites(base, writes);
  const { workspaceId, productionId } = base;
  const all: readonly ChecklistRow[] = [...checklist.floor, ...checklist.aboveFloor];
  const position = new Map(all.map((row, index) => [row.key, index]));
  const rowOf = (key: string) => all.find((row) => row.key === key) ?? null;

  /** A reader over a view that refuses a row from another workspace, or one the record could not have written (rule 2). */
  const readerOf = (over: RecordView) => (key: string): RecordValue | null => {
    const value = over.get(key);
    if (value === null || value === undefined) return null;
    if (value.workspaceId !== workspaceId) throw new QuestionEngineError(NOT_HERE);
    if (!isSource(value.source) || typeof value.value !== "string") throw new QuestionEngineError(NOT_HERE);
    return value;
  };
  const read = readerOf(view);

  /* A person-only row counts as answered only when the person said it (rule 11; film-record-schema question 7). */
  const answered = (row: ChecklistRow): RecordValue | null => {
    const value = read(row.key);
    return value && row.floor && row.personOnly && value.source !== "said" ? null : value;
  };

  /** How a value reads inside "I assumed … · Change": the pill's words, or the value itself (the field's words, Atomik's words). */
  const labelOf = (row: ChecklistRow, value: string) => {
    if (!row.floor) return value;
    const pill = pillsOf(row, read).pills.find((p) => p.id === value) ?? everyPillOf(row).find((p) => p.id === value);
    return pill?.inLine ? QUESTIONS[pill.inLine] : pill?.copy ? QUESTIONS[pill.copy] : value;
  };
  const stepName = (step: string) => (Object.hasOwn(STEPS, step) ? STEPS[step as keyof typeof STEPS].toLowerCase() : null);
  /** R2 and H: an assumed row reads "I assumed … · Change"; a known one "from the brief · Change", a carried one naming its step. */
  const lineOf = (row: ChecklistRow, state: RowState, value: string | null, source: RowSource | null, fromStep: string | null) => {
    if (state === "open" || value === null) return null;
    if (state === "assumed") return `${QUESTIONS.assumed} ${labelOf(row, value)} · ${BUTTONS.change}`;
    const name = source === "earlier_step" ? (fromStep ? stepName(fromStep) : null) : stepName(checklist.step);
    return name ? `${QUESTIONS.fromThe} ${name} · ${BUTTONS.change}` : null;
  };

  /* "Decide for me" was pressed at this step: a person-only row with `decidedShows` reads it, and nothing is written to it. */
  const decided = read(decidedKey(checklist.step)) !== null;

  const rows: MarkedRow[] = all.map((row) => {
    const value = answered(row);
    if (!value && decided && row.floor && row.personOnly && row.decidedShows !== undefined) {
      return { key: row.key, floor: true, state: "assumed", value: row.decidedShows, source: "assumed", fromStep: null, line: lineOf(row, "assumed", row.decidedShows, "assumed", null) };
    }
    const state: RowState = value ? STATE_OF[value.source] : "open";
    const fromStep = value?.source === "earlier_step" ? value.fromStep ?? null : null;
    return { key: row.key, floor: row.floor, state, value: value?.value ?? null, source: value?.source ?? null, fromStep, line: lineOf(row, state, value?.value ?? null, value?.source ?? null, fromStep) };
  });
  const isOpen = new Set(rows.filter((row) => row.state === "open").map((row) => row.key));

  /* "The order", rules 1, 3 and 4; rule 2 is applied below, by holding a row back until what it reads is closed. */
  const rankOf = (row: ChecklistRow) => (row.floor ? row.rank : Number.MAX_SAFE_INTEGER);
  const sorted = all
    .filter((row) => isOpen.has(row.key))
    .sort((a, b) => Number(b.floor) - Number(a.floor) || rankOf(a) - rankOf(b) || position.get(a.key)! - position.get(b.key)!);
  const ordered: ChecklistRow[] = [];
  const pending = [...sorted];
  while (pending.length) {
    const index = pending.findIndex((row) => !row.floor || !(row.dependsOn ?? []).some((key) => pending.some((other) => other.key === key)));
    /* A cycle in dependsOn would hold every row back; the checklist has none, and the test holds it to that. Fall back to rank. */
    ordered.push(...pending.splice(index === -1 ? 0 : index, 1));
  }
  const open = ordered.map((row) => row.key);
  const firstFloor = (ordered.find((row) => row.floor && !(row.dependsOn ?? []).some((key) => isOpen.has(key))) ?? null) as FloorRow | null;

  /**
   * The lit pill's candidates, most binding first (see "The lit pill"), each one of the row's pills now. `agent` keeps only what
   * Atomik may pick: what "Decide for me" takes where Atomik gives no pick.
   */
  const defaultsOf = (row: FloorRow, readNow: (key: string) => RecordValue | null, agent: boolean): string[] => {
    const set = pillsOf(row, readNow);
    const candidates: string[] = [];
    if (row.prefill) {
      const earlier = readNow(row.prefill.from)?.value;
      if (earlier !== undefined && Object.hasOwn(row.prefill.values, earlier)) candidates.push(row.prefill.values[earlier]);
    }
    const held = readNow(row.key);
    if (held && held.source === "default" && (!row.personOnly || (row.proposedBy ?? []).includes("house_default"))) candidates.push(held.value);
    if (!row.personOnly && Object.hasOwn(workspaceDefaults, row.key)) candidates.push(workspaceDefaults[row.key]);
    if (set.lit !== null) candidates.push(set.lit);
    return candidates.filter(
      (id) => set.pills.some((pill) => pill.id === id) && (!agent || (!row.personOnly && (!row.agentPicks || row.agentPicks.includes(id)))),
    );
  };

  /**
   * Whether a value is one this row takes from this answerer. Throws, naming nothing, when it is not. `person` is the person's
   * own direct answer; `read` is words the caller read for another row (`also`); `agent` is Atomik's pick. Only a person's own
   * direct answer sets a person-only row or a value outside `agentPicks` (rule 11, rule 14).
   */
  const check = (row: ChecklistRow, value: string, by: "person" | "read" | "agent", readNow: (key: string) => RecordValue | null) => {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE) throw new QuestionEngineError(NOT_A_CHOICE);
    if (!row.floor) return;
    if (by !== "person" && row.personOnly) throw new QuestionEngineError(PERSON_ONLY);
    const isPill = pillsOf(row, readNow).pills.some((pill) => pill.id === value);
    if (!isPill && !row.field) throw new QuestionEngineError(NOT_A_CHOICE);
    if (by !== "person" && row.agentPicks && !row.agentPicks.includes(value)) throw new QuestionEngineError(PERSON_ONLY);
  };

  /** Whether a row's held value still stands once the row it reads has changed: one of its pills now, or the field's own words. */
  const stillValid = (row: FloorRow, value: string, readNow: (key: string) => RecordValue | null) =>
    pillsOf(row, readNow).pills.some((pill) => pill.id === value) || (row.field && !everyPill(row).includes(value));

  /**
   * Writes one row, then:
   *  - what it carries (H "Answered by"): a carried row is written where nothing answers it, or where this same row carried it
   *    before (a changed answer carries again; one that carries nothing reopens it). A row a person answered is never touched;
   *  - when its value changed, every row that reads it (`dependsOn`) reopens unless the person said it and it still stands.
   */
  const write = (out: RecordWrite[], row: ChecklistRow, value: string, source: RowSource, reason: RecordWrite["reason"]) => {
    const now = () => withWrites(base, [...writes, ...out]);
    const previous = now().get(row.key)?.value ?? null;
    out.push({ workspaceId, productionId, key: row.key, value, source, reason });
    if (!row.floor) return;
    if (row.carries) {
      const carried = Object.hasOwn(row.carries, value) ? row.carries[value] : [];
      /* A carried answer's source is "earlier step", with the step's name (owner, 24 Oct 2026, answer 8), whoever answered it. */
      const carrySource: RowSource = "earlier_step";
      for (const target of [...new Set(Object.values(row.carries).flat().map((carry) => carry.key))]) {
        const held = now().get(target);
        const ours = held?.carriedFrom === row.key;
        if (held && !ours) continue;
        const carry = carried.find((c) => c.key === target);
        if (carry) {
          if (!(ours && held!.value === carry.value && held!.source === carrySource && held!.fromStep === row.step)) {
            out.push({ workspaceId, productionId, key: target, value: carry.value, source: carrySource, reason: "carry", from: row.key, fromStep: row.step });
          }
        } else if (ours) {
          out.push({ workspaceId, productionId, key: target, value: null, source: null, reason: "carry", from: row.key, fromStep: row.step });
        }
      }
    }
    if (previous === null || previous === value) return;
    for (const dependant of checklist.floor.filter((r) => (r.dependsOn ?? []).includes(row.key))) {
      const view = now();
      const held = view.get(dependant.key);
      if (!held || (held.source === "said" && stillValid(dependant, held.value, (k) => view.get(k)))) continue;
      out.push({ workspaceId, productionId, key: dependant.key, value: null, source: null, reason: "change", from: row.key });
    }
  };

  const engine: QuestionEngine = {
    workspaceId,
    productionId,
    rows,
    open,
    floorClosed: !rows.some((row) => row.floor && row.state === "open"),
    writes,
    record: view,

    next(picks) {
      if (!firstFloor) return null;
      const set = pillsOf(firstFloor, read);
      const pick = picks && Object.hasOwn(picks, firstFloor.key) ? picks[firstFloor.key] : undefined;
      const pickable = (id: string) =>
        !firstFloor.personOnly && set.pills.some((pill) => pill.id === id) && (!firstFloor.agentPicks || firstFloor.agentPicks.includes(id));
      const lit = pick !== undefined && pickable(pick) ? pick : defaultsOf(firstFloor, read, false)[0] ?? null;
      return {
        key: firstFloor.key,
        text: QUESTIONS[firstFloor.question],
        shape: firstFloor.shape,
        pills: set.pills.map((pill) => ({ id: pill.id, label: pill.copy ? QUESTIONS[pill.copy] : null, lit: pill.id === lit })),
        field: firstFloor.field,
        fieldLabel: firstFloor.field ? QUESTIONS.other : null,
      };
    },

    answer(key, value, also = {}) {
      const stated = [[key, value] as const, ...Object.entries(also)];
      const keys = stated.map(([k]) => k);
      if (keys.some((k) => !rowOf(k)) || new Set(keys).size !== keys.length) throw new QuestionEngineError(NOT_ON_LIST);
      /* In checklist order, so kind is written before the length whose pills it sets. */
      stated.sort(([a], [b]) => position.get(a)! - position.get(b)!);
      const out: RecordWrite[] = [];
      for (const [k, v] of stated) {
        const row = rowOf(k)!;
        const now = withWrites(base, [...writes, ...out]);
        /* Only the row asked is the person's own direct answer; the others are words the caller read. */
        check(row, v, k === key ? "person" : "read", (key) => now.get(key));
        write(out, row, v, "said", now.get(k) ? "change" : "answer");
      }
      return build(checklist, base, [...writes, ...out], workspaceDefaults);
    },

    decideForMe(picks) {
      for (const key of Object.keys(picks)) {
        const row = rowOf(key);
        if (!row) throw new QuestionEngineError(NOT_ON_LIST);
        if (row.floor && row.personOnly) throw new QuestionEngineError(PERSON_ONLY);
      }
      const out: RecordWrite[] = [];
      /* "Decide for me" was pressed at this step (answer 6): the one row that lets the spend limit read "I assumed no limit" with
         nothing written to it. It holds no figure, no cap and no limit. */
      const marker = decidedKey(checklist.step);
      if (read(marker) === null) out.push({ workspaceId, productionId, key: marker, value: "yes", source: "assumed", reason: "decide_for_me" });
      /* Row by row in asking order, re-reading after each, so a decided kind sets the length's pills before length is decided.
         A person-only row is passed over: it is never written. */
      for (;;) {
        const step = build(checklist, base, [...writes, ...out], workspaceDefaults);
        const key = step.open.find((k) => {
          const row = rowOf(k)!;
          return !(row.floor && row.personOnly);
        });
        if (key === undefined) break;
        const row = rowOf(key)!;
        const now = readerOf(step.record);
        const pick = Object.hasOwn(picks, key) ? picks[key] : row.floor ? defaultsOf(row, now, true)[0] ?? null : null;
        if (pick === null || pick === undefined) throw new QuestionEngineError(`"Decide for me" needs a pick for ${key}.`);
        check(row, pick, "agent", now);
        write(out, row, pick, "assumed", "decide_for_me");
      }
      return build(checklist, base, [...writes, ...out], workspaceDefaults);
    },

    mayAsk(key) {
      if (typeof key !== "string" || !ABOVE_KEY.test(key)) return false;
      return read(key) === null;
    },
  };
  return Object.freeze(engine);
}
