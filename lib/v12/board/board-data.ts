/**
 * What a v25 board keeps in its draft beside its stages (docs/plans/v25-build-plan.md, PR 4): the mode each person works the
 * board in, the setup of each step, and the settings of single cards that differ from their step's.
 *
 * Additive and optional draft JSON like `boardStages` and `boardRounds` (lib/workbench/studio-schema.ts): saved and merged with
 * the rest of the draft, no table, nothing to migrate. Pure: no React, no server.
 *
 * `boardMode` is how a board is worked, Agent or Director. It is not Atomik's Ask and Auto, which is a spending setting
 * (lib/atomik.ts; rule 14) and stays in Spending rules; nothing here reads or writes it.
 *
 * The mode is kept by person id, so one person's choice never changes another's. What the draft can hold today is narrower:
 * a draft is private to its author, and teammates view a shared board read-only, so only the author's own mode can be saved
 * here. A viewer's mode is not kept (it reads as Agent) until the UI PR keeps it somewhere else. Each mode has its own setup:
 * Agent's answers to the two quick questions of a step and Director's settings column do not overwrite each other. A card's
 * own overrides sit on top of the step's setup, in whichever mode is open.
 */

export type BoardMode = "agent" | "director";
export const BOARD_MODES: readonly BoardMode[] = ["agent", "director"];
/** A person who has not chosen starts in Agent: the way with nothing to set up first (rule 13). */
export const DEFAULT_BOARD_MODE: BoardMode = "agent";

/** One setting's value: a choice, a number or a switch. */
export type SettingValue = string | number | boolean;
/** The settings of one step or one card, by setting key. */
export type Setup = Record<string, SettingValue>;

/** Each person's mode, by person id. */
export type BoardModes = Record<string, BoardMode>;
/** Each mode's step setups, by step id. */
export type BoardSetup = Partial<Record<BoardMode, Record<string, Setup>>>;
/** Each card's overrides, by card id. */
export type CardOverrides = Record<string, Setup>;

/** What the draft's schema takes (lib/workbench/studio-schema.ts › boardMode, boardSetup, boardOverrides). */
export const BOARD_DATA_LIMITS = { people: 200, steps: 40, cards: 400, settings: 40, text: 200 } as const;
/**
 * Names every object has without being given them (Object.prototype's own names) and `prototype`. No id or key may be one:
 * a lookup by such a name would find what every object inherits, not what was saved, and could slip past the limits.
 */
export const INHERITED_NAMES: readonly string[] = [
  "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "constructor", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf", "prototype",
];
/** A lookahead that refuses an id or key that is exactly one of INHERITED_NAMES; put it right after `^` in a pattern. */
export const notInherited = `(?!(?:${INHERITED_NAMES.join("|")})$)`;
export const PERSON_ID = new RegExp(`^${notInherited}[A-Za-z0-9_-]{1,100}$`);
export const STEP_ID = new RegExp(`^${notInherited}[A-Za-z0-9_-]{1,80}$`);
export const CARD_ID = new RegExp(`^${notInherited}[A-Za-z0-9_:.-]{1,100}$`);
export const SETTING_KEY = new RegExp(`^${notInherited}[A-Za-z][A-Za-z0-9_-]{0,39}$`);

export const isBoardMode = (value: unknown): value is BoardMode => value === "agent" || value === "director";

/** A value as the draft keeps it, or null when it is not one (text is cut to the limit; a number must be finite). */
export function cleanValue(value: unknown): SettingValue | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") { const text = value.trim().slice(0, BOARD_DATA_LIMITS.text); return text || null; }
  return null;
}

/* ── Mode, per person ─────────────────────────────────────────────────────────────────────────────── */

/** The mode a person works this board in. */
export const modeOf = (modes: BoardModes | null | undefined, person: string | null | undefined): BoardMode => {
  const mode = person && modes && Object.hasOwn(modes, person) ? modes[person] : undefined;
  return isBoardMode(mode) ? mode : DEFAULT_BOARD_MODE;
};

/**
 * The modes after one person's choice. Only that person's entry changes. At the most `people` are kept: past it the one set
 * longest ago is let go (it reads as the default again), so a long-lived board never fills its draft. An id or mode the draft
 * would refuse leaves the modes as they were.
 */
export function withMode(modes: BoardModes | null | undefined, person: string, mode: BoardMode): BoardModes {
  const current = modes ?? {};
  if (!PERSON_ID.test(person) || !isBoardMode(mode)) return current;
  const { [person]: _was, ...rest } = current;
  const kept = Object.entries(rest).slice(-(BOARD_DATA_LIMITS.people - 1));
  return Object.fromEntries([...kept, [person, mode]]);
}

/* ── Setup, per step and per mode ─────────────────────────────────────────────────────────────────── */

/** A step's setup in a mode (a copy). */
export const stepSetup = (setup: BoardSetup | null | undefined, mode: BoardMode, step: string): Setup => {
  const steps = setup && isBoardMode(mode) && Object.hasOwn(setup, mode) ? setup[mode] : undefined;
  return { ...(steps && Object.hasOwn(steps, step) ? steps[step] : {}) };
};

const changed = <T extends Setup>(from: T, key: string, value: unknown): T | null => {
  if (!SETTING_KEY.test(key)) return null;
  const next: Setup = { ...from };
  if (value === null || value === undefined) delete next[key];
  else {
    const clean = cleanValue(value);
    if (clean === null) return null;
    if (!Object.hasOwn(next, key) && Object.keys(next).length >= BOARD_DATA_LIMITS.settings) return null;
    next[key] = clean;
  }
  return next as T;
};

/**
 * The setup after one setting of one step in one mode: a value sets it, `null` clears it (the step falls back to its default).
 * A key, step or value the draft would refuse, or a setting past the limits, leaves the setup as it was.
 */
export function withStepSetting(setup: BoardSetup | null | undefined, mode: BoardMode, step: string, key: string, value: unknown): BoardSetup {
  const current = setup ?? {};
  if (!isBoardMode(mode) || !STEP_ID.test(step)) return current;
  const steps = current[mode] ?? {};
  const next = changed(Object.hasOwn(steps, step) ? steps[step] : {}, key, value);
  if (!next) return current;
  if (!Object.hasOwn(steps, step) && Object.keys(steps).length >= BOARD_DATA_LIMITS.steps) return current;
  const { [step]: _was, ...others } = steps;
  const stepsNext = Object.keys(next).length ? { ...others, [step]: next } : others;
  const { [mode]: _mode, ...otherModes } = current;
  return Object.keys(stepsNext).length ? { ...otherModes, [mode]: stepsNext } : otherModes;
}

/* ── Overrides, per card ──────────────────────────────────────────────────────────────────────────── */

/** A card's own settings (a copy). */
export const cardOverrides = (overrides: CardOverrides | null | undefined, card: string): Setup => ({ ...(overrides && Object.hasOwn(overrides, card) ? overrides[card] : {}) });

/** The overrides after one setting of one card: a value sets it, `null` clears it. Refusals leave them as they were. */
export function withCardOverride(overrides: CardOverrides | null | undefined, card: string, key: string, value: unknown): CardOverrides {
  const current = overrides ?? {};
  if (!CARD_ID.test(card)) return current;
  const next = changed(Object.hasOwn(current, card) ? current[card] : {}, key, value);
  if (!next) return current;
  if (!Object.hasOwn(current, card) && Object.keys(current).length >= BOARD_DATA_LIMITS.cards) return current;
  const { [card]: _was, ...others } = current;
  return Object.keys(next).length ? { ...others, [card]: next } : others;
}

/** Every override of a card gone (back to its step's setup). */
export function withoutCardOverrides(overrides: CardOverrides | null | undefined, card: string): CardOverrides {
  const { [card]: _was, ...others } = overrides ?? {};
  return others;
}

/** What a card runs with: its step's setup in the open mode, then the card's own overrides on top. */
export function effectiveSetup(draft: { boardSetup?: BoardSetup; boardOverrides?: CardOverrides }, args: { mode: BoardMode; step: string; card?: string | null }): Setup {
  return { ...stepSetup(draft.boardSetup, args.mode, args.step), ...(args.card ? cardOverrides(draft.boardOverrides, args.card) : {}) };
}

/** Which of a card's settings are its own, not its step's: the keys the card overrides to a different value. */
export function overriddenKeys(draft: { boardSetup?: BoardSetup; boardOverrides?: CardOverrides }, args: { mode: BoardMode; step: string; card: string }): string[] {
  const step = stepSetup(draft.boardSetup, args.mode, args.step);
  return Object.entries(cardOverrides(draft.boardOverrides, args.card)).filter(([key, value]) => step[key] !== value).map(([key]) => key);
}
