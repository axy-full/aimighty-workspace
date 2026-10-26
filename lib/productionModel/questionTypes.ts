import type { QUESTIONS } from "../copy";
import type { WorkspaceRole } from "../tenant";

/**
 * The question engine's shapes (Amendment, 22 October 2026 (iii), G "Questions", H and K D1; SOW R2 and D1).
 *
 * A step's checklist is two tables (K, D1): the floor rows (H: fixed, deterministic, tested) and the above-floor rows (an
 * example bank for Atomik, never a list it is limited to). The engine marks each row known / assumed / open from the record,
 * orders the open floor rows, and gives the next one question. It calls no model and bills nothing: Atomik's picks for
 * "Decide for me" arrive as input.
 *
 * Types only. The record (docs/film-record-schema.md, `film_record_rows`) does not exist yet; `RecordView` is the read-only
 * view it will satisfy, and today fixtures satisfy it.
 */

/** Where a row's value came from: the record's `source` column (film-record-schema A.2), word for word. */
export type RowSource = "said" | "document" | "earlier_step" | "default" | "assumed";

/**
 * How a row reads (R2): known = said, read from a document or carried from an earlier step; assumed = a house default or Atomik's
 * pick; open = nothing answers it yet; skipped = a conversation question the person passed over, never asked again and never
 * guessed (owner, 25 Oct 2026: "any of them skippable"). The line a closed row shows is MarkedRow's `line`: a carried row is known but still reads
 * as a guess until a person confirms it (owner, 25 Oct 2026, answer 3).
 */
export type RowState = "known" | "assumed" | "open" | "skipped";

/** D1's question shapes. */
export type QuestionShape = "pick_one" | "a_b" | "yes_no" | "tap_frame" | "upload";

/** A key into the copy table's QUESTIONS section: every word a question shows comes from lib/copy.ts (D12). */
export type QuestionCopyKey = keyof typeof QUESTIONS;

/**
 * One answer pill. `id` is the value written to the record, never a figure; `copy` is its words in the copy table; `inLine` is
 * how it reads inside "I assumed … · Change" where that differs from its label ("No limit" reads "no limit").
 */
export type Pill = { readonly id: string; readonly copy?: QuestionCopyKey; readonly inLine?: QuestionCopyKey };

/** A row's pills and the one lit by default (H: ★). At most four pills (A1); "Other" is the field, not a pill. */
export type PillSet = { readonly pills: readonly Pill[]; readonly lit: string | null };

/** Pills that depend on another row's value (H: length's pills are "by kind"). A value the map lacks gets the field only. */
export type PillsBy = { readonly by: string; readonly sets: Readonly<Record<string, PillSet>> };

/** A value an answer carries to another row (H, "Answered by": e.g. Brief › material answers Elements › source). */
export type Carry = { readonly key: string; readonly value: string };

/**
 * A value an earlier row lights on this row's question without answering it (owner, 24 Oct 2026: the Brief's "real" pre-fills
 * Elements' consent for that person; the tick itself, who, when and an optional file, is still recorded per element when it is
 * first made, by a person). The engine never writes it: it is read from the record each time the question is shown.
 */
export type Prefill = { readonly from: string; readonly values: Readonly<Record<string, string>> };

/** A floor row (H): one decision that must be known before money moves. */
export type FloorRow = {
  readonly key: string;
  readonly floor: true;
  /** The step whose checklist holds the row (a production step kind, lib/productionModel/filmTypes.ts). */
  readonly step: string;
  /** What changes the result or the price most comes first: 1 is the most. See questionEngine.ts, "The order". */
  readonly rank: number;
  readonly question: QuestionCopyKey;
  readonly shape: QuestionShape;
  readonly pills: PillSet | PillsBy;
  /** H: "a field for anything else" (the pill the owner wrote as "Other"). */
  readonly field: boolean;
  /** Rows whose value this row's question reads; it is never asked while one of them is open. */
  readonly dependsOn?: readonly string[];
  /**
   * D1's "decide-for-me allowed": the only values "Decide for me" may set. Absent: any pill, or any field value. A row a person
   * alone answers (rule 11: the spend limit; consent) lists only what Atomik may assume, never the person's own choices.
   */
  readonly agentPicks?: readonly string[];
  /**
   * A row only a person's own direct answer sets (rule 11, rule 14: the spend limit). "Decide for me" never writes it, words the
   * caller read (`answer`'s `also`) never set it, and only a value the person said counts: a house default, a document or an
   * assumption leaves it open (film-record-schema A.0 and question 7: the spend limit never becomes a default).
   */
  readonly personOnly?: true;
  /**
   * What "Decide for me" shows on a person-only row instead of writing it: "I assumed <this> · Change", never asked again in the
   * production, with nothing written (owner, 24 Oct 2026, answer 6). It must be what the row means when unset: the spend limit
   * shows "no limit", which is what no limit set already means. A person-only row without it stays open after "Decide for me".
   */
  readonly decidedShows?: string;
  /**
   * What may light a pill on a person-only row without answering it (owner, 24 Oct 2026, answer 5: the engine may propose the
   * house default for the spend limit, never write one). As ids, beside `answeredBy`.
   */
  readonly proposedBy?: readonly string[];
  /**
   * The values that lift a cap already set (owner, 25 Oct 2026, answer 3 (b): "Any member may set the ceiling at the Brief;
   * raising it above a set cap is owner or admin"). Where the production or its workspace has a cap (`CapsSet`), only an owner
   * or admin may choose one of these; anywhere else any member may. The spend limit's today: No limit.
   */
  readonly raises?: readonly string[];
  /** An earlier row whose value lights this row's pill, never answering it (see `Prefill`). */
  readonly prefill?: Prefill;
  /** H "Answered by", where the answer is another floor row: pill id → the values it carries. */
  readonly carries?: Readonly<Record<string, readonly Carry[]>>;
  /** D1: what answers it without asking (H's "Answered by" column), as ids. */
  readonly answeredBy: readonly string[];
  /** D1: what it sets downstream (H's "Sets" column), as ids. */
  readonly sets: readonly string[];
  /** D1: money attached. Every floor row has money attached (H's "Why floor"). */
  readonly money: true;
};

/**
 * An above-floor row (K, D1): an example for Atomik of what this step may make open. It has no words and no pills: Atomik asks
 * above the floor in its own words, one question at a time, from no list (H). The engine marks it, so a row the record holds
 * is never asked again (H: "no above-floor question repeats a row the record holds"). Keys are `q:<slug>` (film-record-schema A.2).
 */
export type AboveFloorRow = {
  readonly key: string;
  readonly floor: false;
  readonly step: string;
  /**
   * A question of the conversation (owner, 25 Oct 2026; SOW v2 §9 Brief): the Brief asks above the floor as a filmmaker talks about
   * the film, one question per card, in the copy table's words, with likely answers as chips, a field for the person's own words,
   * Skip and Decide for me. Absent: Atomik asks about the row in its own words, from no list.
   */
  readonly question?: QuestionCopyKey;
  /** Likely answers the row always offers, in order (a tone's words; montage or not). Atomik's own for this film come first. */
  readonly bank?: readonly Pill[];
};

export type ChecklistRow = FloorRow | AboveFloorRow;

/** One step's checklist on one rail (D1: per rail × step). */
export type Checklist = {
  readonly filmType: string;
  readonly step: string;
  readonly floor: readonly FloorRow[];
  readonly aboveFloor: readonly AboveFloorRow[];
};

/**
 * One row's live value in the record, with the workspace it belongs to (rule 2: the engine refuses another workspace's row).
 * `carriedFrom` names the row whose answer carried it here (film-record-schema A.2 `change_reason` `carry:<row>`), so a changed
 * answer there can carry again; a row a person answered has none and is never overwritten by a carry. `fromStep` names the step
 * that row sits on (owner, 24 Oct 2026, answer 8: a carried answer's source is "earlier step", with the step's name).
 */
export type RecordValue = {
  readonly workspaceId: string;
  readonly value: string;
  readonly source: RowSource;
  readonly carriedFrom?: string;
  readonly fromStep?: string;
  /** On a `document` row: the page of the file that answered it (1 first), which the row's chip shows on hover. */
  readonly page?: number;
};

/**
 * What is known: the read-only view the film record will satisfy (one live version per key, film-record-schema A.0). Bound to
 * one workspace and one production.
 */
export interface RecordView {
  readonly workspaceId: string;
  readonly productionId: string;
  /** The live value of one row, or null when nothing answers it. */
  get(key: string): RecordValue | null;
}

/**
 * Why a row was written (film-record-schema A.2 `change_reason`). `from` names the row that caused it: the row a `carry` came
 * from, or, on a `change` that reopens a row, the row it reads whose answer changed (a new kind reopens length).
 */
export type WriteReason = "answer" | "change" | "decide_for_me" | "carry" | "skip";

/** One row the engine wrote this session, for the record's writer to commit. No time: the store stamps it. */
export type RecordWrite = {
  readonly workspaceId: string;
  readonly productionId: string;
  readonly key: string;
  /** Null reopens the row: asked, not answered (film-record-schema A.2: value and source are NULL together). */
  readonly value: string | null;
  readonly source: RowSource | null;
  readonly reason: WriteReason;
  readonly from?: string;
  /** On a carry: the step of the row it came from (answer 8). */
  readonly fromStep?: string;
};

/** One row as the engine marks it. */
export type MarkedRow = {
  readonly key: string;
  readonly floor: boolean;
  readonly state: RowState;
  readonly value: string | null;
  readonly source: RowSource | null;
  /** The step a carried value came from (answer 8); null otherwise. */
  readonly fromStep: string | null;
  /**
   * How the row reads in place of a question (R2, G, H; owner, 25 Oct 2026, answer 3), from the copy table: "I assumed … · Change"
   * for a guess (a house default, Atomik's pick, or a value carried from an earlier step) until a person confirms it; "from you ·
   * Change" for a person's own answer; "from the brief · Change" for a row a file answered. Null for an open row.
   */
  readonly line: string | null;
  /** On a row a file answered, the page that answered it, for the chip's hover; absent otherwise. */
  readonly page?: number;
};

/** A pill as a question shows it: its words and whether it is the lit default. */
export type QuestionPill = { readonly id: string; readonly label: string | null; readonly lit: boolean };

/** The one question to ask next (A1: one at a time; at most four pills, plus a field). */
export type Question = {
  readonly key: string;
  readonly text: string;
  readonly shape: QuestionShape;
  readonly pills: readonly QuestionPill[];
  readonly field: boolean;
  /** The words for the field ("Other"), when the row has one. */
  readonly fieldLabel: string | null;
  /** A conversation question may be skipped (owner, 25 Oct 2026); a floor row never is. */
  readonly skip?: true;
};

/**
 * Likely answers Atomik proposes for this film, by conversation row key (the hook it read in the brief, the moments it saw):
 * supplied by the caller, never made here. Shown before the row's own bank, at most four in all, each the words it writes.
 */
export type Proposals = Readonly<Record<string, readonly string[]>>;

/** Atomik's picks for "Decide for me", by row key: supplied by the caller, never made here. */
export type Picks = Readonly<Record<string, string>>;

/**
 * A workspace's own defaults (owner, 24 Oct 2026, answer 7), by row key: they change which pill is lit (★) and what "Decide for
 * me" takes when Atomik gives no pick; they answer nothing (H: only a house default, a row the workspace answered the same way
 * three times, answers a row without asking; it arrives in the record with source `default`). Bound to one workspace (rule 2).
 * Never applied to a person-only row: a spend limit is a person's alone (rule 14).
 */
export type WorkspaceDefaults = { readonly workspaceId: string; readonly values: Readonly<Record<string, string>> };

/**
 * Which caps are already set on this production and its workspace (owner, 25 Oct 2026, answer 3 (b)): whether each is set, never
 * a figure (film-record-schema A.0: the spend limit holds a reference to the cap). `production` is the production's own cap (H's
 * "Sets: production_cap"); `workspace` is the workspace's monthly limit (H's "Answered by: workspace_monthly_limit"). The engine
 * reads no money table, so the caller passes them. Bound to one workspace (rule 2) and to this production. Not passed: no cap is set.
 */
export type CapsSet = { readonly workspaceId: string; readonly productionId: string; readonly production: boolean; readonly workspace: boolean };

/** The person answering, by their role in the workspace (lib/tenant.ts), where a row's answer depends on it (`raises`). */
export type Answerer = { readonly role: WorkspaceRole };
