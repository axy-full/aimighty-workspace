import { QUESTIONS } from "../copy";
import type {
  Checklist, ChecklistRow, FloorRow, MarkedRow, Picks, PillSet, Question, RecordValue, RecordView, RecordWrite, RowSource, RowState,
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
 * The order (G: "by what changes the result or the price most"; the spec gives no formula, so this is the lead's rule, listed
 * as an owner question):
 *   1. floor rows before above-floor rows (H: the floor is fixed and asked; above it, Atomik asks in its own words);
 *   2. a row is never asked while a row it reads is open (`dependsOn`: length's pills are by kind);
 *   3. then by rank, 1 first: each floor row's rank is read from H's "Sets" and "Why floor" columns (lib/productionModel/checklists.ts);
 *   4. then the checklist's own order.
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
 * A record view over plain rows: what fixtures, and the engine's own session, read. The record's store (M2) will satisfy the
 * same interface from `film_record_rows`.
 */
export function inMemoryRecord(
  workspaceId: string,
  productionId: string,
  rows: Readonly<Record<string, { value: string; source: RowSource }>>,
): RecordView {
  const held = new Map(Object.entries(rows).map(([key, row]) => [key, Object.freeze({ workspaceId, value: row.value, source: row.source })]));
  return Object.freeze({ workspaceId, productionId, get: (key: string) => held.get(key) ?? null });
}

/** The base record with this session's writes on top; the latest write to a key wins. */
function withWrites(base: RecordView, writes: readonly RecordWrite[]): RecordView {
  const latest = new Map<string, RecordValue>();
  for (const write of writes) latest.set(write.key, { workspaceId: write.workspaceId, value: write.value, source: write.source });
  return Object.freeze({ workspaceId: base.workspaceId, productionId: base.productionId, get: (key: string) => latest.get(key) ?? base.get(key) });
}

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
   * "Decide for me": every open row closed with Atomik's pick (source `assumed`). A floor row without a pick takes its lit
   * default (H: ★); an above-floor row has none, so it needs a pick. A row a person alone answers takes only what Atomik may
   * assume (`agentPicks`). Rows that are already known or assumed keep their value.
   */
  decideForMe(picks: Picks): QuestionEngine;
  /** Whether Atomik may ask an above-floor question about `key`: never a floor row, never a row the record holds (H). */
  mayAsk(key: string): boolean;
  /** The rows this session wrote, in order, for the record's writer. */
  readonly writes: readonly RecordWrite[];
  /** The record as this session leaves it: the base view with `writes` on top. The next step's engine reads it. */
  readonly record: RecordView;
}

/** An engine over one step's checklist and one production's record. */
export function questionEngine(checklist: Checklist, record: RecordView): QuestionEngine {
  if (!record || typeof record.workspaceId !== "string" || !record.workspaceId || typeof record.productionId !== "string" || !record.productionId) {
    throw new QuestionEngineError(NOT_HERE);
  }
  return build(checklist, record, []);
}

function pillsOf(row: FloorRow, read: (key: string) => RecordValue | null): PillSet {
  if (!("by" in row.pills)) return row.pills;
  const on = read(row.pills.by)?.value;
  return (on !== undefined && Object.hasOwn(row.pills.sets, on) ? row.pills.sets[on] : null) ?? { pills: [], lit: null };
}

function build(checklist: Checklist, base: RecordView, writes: readonly RecordWrite[]): QuestionEngine {
  const view = withWrites(base, writes);
  const { workspaceId, productionId } = base;
  const all: readonly ChecklistRow[] = [...checklist.floor, ...checklist.aboveFloor];
  const position = new Map(all.map((row, index) => [row.key, index]));
  const rowOf = (key: string) => all.find((row) => row.key === key) ?? null;

  const read = (key: string): RecordValue | null => {
    const value = view.get(key);
    if (value === null || value === undefined) return null;
    if (value.workspaceId !== workspaceId) throw new QuestionEngineError(NOT_HERE);
    if (!isSource(value.source) || typeof value.value !== "string") throw new QuestionEngineError(NOT_HERE);
    return value;
  };

  const rows: MarkedRow[] = all.map((row) => {
    const value = read(row.key);
    return { key: row.key, floor: row.floor, state: value ? STATE_OF[value.source] : "open", value: value?.value ?? null, source: value?.source ?? null };
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

  /** Whether a value is one this row takes from this answerer. Throws, naming nothing, when it is not. */
  const check = (row: ChecklistRow, value: string, by: "person" | "agent", readNow: (key: string) => RecordValue | null) => {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE) throw new QuestionEngineError(NOT_A_CHOICE);
    if (!row.floor) return;
    const isPill = pillsOf(row, readNow).pills.some((pill) => pill.id === value);
    if (!isPill && !row.field) throw new QuestionEngineError(NOT_A_CHOICE);
    if (by === "agent" && row.agentPicks && !row.agentPicks.includes(value)) throw new QuestionEngineError(PERSON_ONLY);
  };

  /** Writes one row and what it carries (H "Answered by"), each carried row only where nothing answers it yet. */
  const write = (out: RecordWrite[], row: ChecklistRow, value: string, source: RowSource, reason: RecordWrite["reason"]) => {
    out.push({ workspaceId, productionId, key: row.key, value, source, reason });
    if (!row.floor || !row.carries || !Object.hasOwn(row.carries, value)) return;
    const now = withWrites(base, [...writes, ...out]);
    for (const carry of row.carries[value]) {
      if (now.get(carry.key)) continue;
      out.push({ workspaceId, productionId, key: carry.key, value: carry.value, source: source === "said" ? "earlier_step" : "assumed", reason: "carry", from: row.key });
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
      const pickable = (id: string) => set.pills.some((pill) => pill.id === id) && (!firstFloor.agentPicks || firstFloor.agentPicks.includes(id));
      const lit = pick !== undefined && pickable(pick) ? pick : set.lit;
      return {
        key: firstFloor.key,
        text: QUESTIONS[firstFloor.question],
        shape: firstFloor.shape,
        pills: set.pills.map((pill) => ({ id: pill.id, label: pill.copy ? QUESTIONS[pill.copy] : null, credits: pill.credits ?? null, lit: pill.id === lit })),
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
        check(row, v, "person", (key) => now.get(key));
        write(out, row, v, "said", now.get(k) ? "change" : "answer");
      }
      return build(checklist, base, [...writes, ...out]);
    },

    decideForMe(picks) {
      for (const key of Object.keys(picks)) if (!rowOf(key)) throw new QuestionEngineError(NOT_ON_LIST);
      const out: RecordWrite[] = [];
      /* Row by row in asking order, re-reading after each, so a decided kind sets the length's pills before length is decided. */
      for (;;) {
        const step = build(checklist, base, [...writes, ...out]);
        const key = step.open[0];
        if (key === undefined) break;
        const row = rowOf(key)!;
        const now = step.record;
        const pick = Object.hasOwn(picks, key) ? picks[key] : row.floor ? pillsOf(row, (k) => now.get(k)).lit : null;
        if (pick === null || pick === undefined) throw new QuestionEngineError(`"Decide for me" needs a pick for ${key}.`);
        check(row, pick, "agent", (k) => now.get(k));
        write(out, row, pick, "assumed", "decide_for_me");
      }
      return build(checklist, base, [...writes, ...out]);
    },

    mayAsk(key) {
      if (typeof key !== "string" || !ABOVE_KEY.test(key)) return false;
      return read(key) === null;
    },
  };
  return Object.freeze(engine);
}
