/**
 * A run, in the words the run view says out loud (brief 3, surface 1a).
 *
 * The state vocabulary is the design's second rule and it is short on
 * purpose: `queued → running → done`, plus `needs you` when a stage stops and
 * `locked` for something pinned. Nothing else. A stage that failed is not
 * "error" or "broken", it is a stage that needs a person, which is both truer
 * and the only framing that leads anywhere.
 *
 * The fourth rule is the one this file exists to hold: **a failure never
 * restarts a run.** Everything that has finished stays finished, everything
 * downstream holds, and the stage that stopped offers priced ways out in
 * place. So the reason and the fixes live with the stage, and "continue"
 * means continue, not begin again.
 *
 * Pure. The rows are read in lib/runs.ts and the money is the quote engine's.
 */

export const STAGE_STATES = ["queued", "running", "done", "needs_you", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const RUN_STATES = ["running", "paused", "done"] as const;
export type RunState = (typeof RUN_STATES)[number];

export function isStageState(v: unknown): v is StageState {
  return typeof v === "string" && (STAGE_STATES as readonly string[]).includes(v);
}

/** The word on the card. Two of these are the design's, not English's. */
export const STATE_WORD: Record<StageState, string> = {
  queued: "Queued", running: "Running", done: "Done", needs_you: "Needs you", skipped: "Skipped",
};

/* ── A way out of a stopped stage ───────────────────────────────────────
   Each fix says what it does, what it costs, and what it leaves behind. The
   consequence is not decoration: choosing between "no re-render" and "one
   shot runs again" is the whole decision, and a price without it is a
   number with no question attached. */

export type FixKind = "settings" | "rerender" | "skip";

export type Fix = {
  id: string;
  label: string;
  /** What taking this leaves you with, in one line. */
  note: string;
  kind: FixKind;
  /** Whole credits. Zero is a real answer and the commonest one. */
  credits: number;
};

export type Failure = {
  /** Which unit stopped — a shot code, usually. */
  unit: string;
  /** The real reason, in the studio's own words, not the vendor's. */
  reason: string;
  fixes: Fix[];
};

export type StageView = {
  id: string;
  num: number;
  name: string;
  /** "12 shots · Seedance 2.5" — what it does and what it does it with. */
  sub: string;
  state: StageState;
  /** Whole credits: the estimate, and what has gone so far. */
  credits: number;
  spent: number;
  doneUnits: number;
  totalUnits: number;
  /** Whether the stage has made anything yet: the well is a picture or a dash. */
  hasOutput: boolean;
  failure: Failure | null;
  fixedWith: string | null;
};

export type RunView = {
  id: string;
  num: number;
  projectId: string | null;
  projectName: string;
  /** running | paused | done. Whether a stage needs somebody is its own fact. */
  state: RunState;
  /** True when any stage is waiting on a person. Does not hide a paused run. */
  needsYou: boolean;
  startedAt: number;
  stages: StageView[];
  spent: number;
  estimate: number;
  done: number;
  total: number;
};

/* ── What the header says ───────────────────────────────────────────── */

/** Whole per cent of the estimate spent, capped so a bar never runs off. */
export function spentPct(spent: number, estimate: number): number {
  if (!(estimate > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((spent / estimate) * 100)));
}

/**
 * The line to the right of "4 of 8 stages complete".
 *
 * A stage that needs somebody is the only thing worth saying when there is
 * one, because it is the only thing anybody can act on.
 */
export function remainingLine(stages: StageView[]): string {
  const needs = stages.filter((s) => s.state === "needs_you").length;
  if (needs) return `${needs} stage${needs === 1 ? "" : "s"} needs you`;
  const running = stages.filter((s) => s.state === "running").length;
  if (running) return `${running} stage${running === 1 ? "" : "s"} running`;
  const queued = stages.filter((s) => s.state === "queued").length;
  if (queued) return `${queued} stage${queued === 1 ? "" : "s"} queued`;
  return "nothing left to run";
}

/**
 * The sentence under the cost card when something has stopped.
 *
 * It is there to answer the question a producer actually has, which is not
 * "what broke" but "have I lost the rest of it". The answer is no, and
 * saying so is the difference between a stopped run and a panic.
 */
export function holdingLine(stages: StageView[]): string {
  const needs = stages.filter((s) => s.state === "needs_you").length;
  if (!needs) return "";
  return needs === 1
    ? "One stage needs you. The rest of the run is holding, not lost."
    : `${needs} stages need you. The rest of the run is holding, not lost.`;
}

/** Every stage waiting on a person, in run order. There can be more than one. */
export const stoppedStages = (stages: StageView[]): StageView[] =>
  stages.filter((s) => s.state === "needs_you");

/** The first of them, for the sentence that counts them. */
export const stoppedStage = (stages: StageView[]): StageView | null =>
  stoppedStages(stages)[0] ?? null;

/**
 * What a person has chosen, and where.
 *
 * A stage AND a fix, never a fix on its own. Two stages can stop at once —
 * holdingLine says "2 stages need you" precisely because that happens — and
 * the design's own fix ids are generic words like `rerender` and `skip`, so
 * they collide across stages by construction. A bare id resolved against
 * whichever stage stopped first is how a tap on one card comes to price, and
 * then spend, on another.
 */
export type Choice = { stageId: string; fixId: string };

export function chosenFix(stages: StageView[], choice: Choice | null): { stage: StageView; fix: Fix } | null {
  if (!choice) return null;
  const stage = stages.find((s) => s.id === choice.stageId && s.state === "needs_you");
  const fix = stage?.failure?.fixes.find((f) => f.id === choice.fixId);
  return stage && fix ? { stage, fix } : null;
}

/* ── What the bottom bar says ───────────────────────────────────────── */

export type Primary = { label: string; credits: number; enabled: boolean };

/**
 * The button at the bottom.
 *
 * With a stage stopped it fixes and continues at the price of the fix chosen,
 * and it is not pressable until one is: the design's first rule is that a
 * price is quoted before the button enables, and "whatever you would have
 * picked" is not a price.
 *
 * With nothing stopped it reports the run rather than offering to approve it.
 * The reference puts "Approve run · 118 cr" here, and approving is the
 * runner's to implement — until it exists, an enabled priced button that does
 * nothing when pressed is a worse lie than a disabled one that says what is
 * happening.
 */
export function primaryFor(run: RunView, chosen: Fix | null): Primary {
  if (stoppedStage(run.stages)) {
    return { label: "Fix and continue", credits: chosen?.credits ?? 0, enabled: chosen !== null };
  }
  if (run.state === "done") return { label: "Run finished", credits: run.spent, enabled: false };
  if (run.state === "paused") return { label: "Run paused", credits: run.estimate, enabled: false };
  return { label: "Running", credits: run.estimate, enabled: false };
}

/** "3 of 12 shots · 62%", or nothing when a stage counts no units. */
export function progressLine(s: StageView): string {
  if (!(s.totalUnits > 0)) return "";
  const pct = Math.max(0, Math.min(100, Math.round((s.doneUnits / s.totalUnits) * 100)));
  return `${s.doneUnits} of ${s.totalUnits} · ${pct}%`;
}

export function progressPct(s: StageView): number {
  if (!(s.totalUnits > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((s.doneUnits / s.totalUnits) * 100)));
}

/**
 * What a running stage has cost so far against what it will.
 *
 * The design writes this as `54 / 87 cr`, and only while it is running: a
 * finished stage has one number and a queued one has an estimate, and
 * showing a fraction for either would invent a precision neither has.
 */
export function costLabel(s: StageView, credits: (n: number) => string): string {
  if (s.state === "running" && s.spent > 0 && s.spent < s.credits) {
    return `${s.spent} / ${credits(s.credits)}`;
  }
  if (s.state === "done" || s.state === "skipped") return credits(s.spent);
  return credits(s.credits);
}

/* ── Reading a failure off a row ────────────────────────────────────── */

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * A stored failure, read defensively.
 *
 * Anything that cannot be read as a failure with at least one way out is no
 * failure at all: a stage that says it needs a person, and then offers
 * nothing to do about it, is worse than one that simply says it stopped.
 */
export function cleanFailure(v: unknown): Failure | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const reason = str(o.reason, 400);
  if (!reason) return null;

  const seen = new Set<string>();
  const fixes: Fix[] = [];
  for (const raw of Array.isArray(o.fixes) ? o.fixes : []) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const id = str(f.id, 40);
    const label = str(f.label, 80);
    if (!id || !label || seen.has(id)) continue;
    const kind = f.kind === "rerender" || f.kind === "skip" ? f.kind : "settings";
    const credits = Math.max(0, Math.round(Number(f.credits) || 0));
    seen.add(id);
    fixes.push({ id, label, note: str(f.note, 160), kind, credits });
    if (fixes.length >= 4) break;
  }
  if (!fixes.length) return null;
  return { unit: str(o.unit, 40), reason, fixes };
}

export const fixById = (failure: Failure | null, id: string | null): Fix | null =>
  (failure && id ? failure.fixes.find((f) => f.id === id) ?? null : null);
