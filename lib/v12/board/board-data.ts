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
 * The mode is kept per person per board: the draft is shared by everyone on the board, so it holds one mode for each person's
 * id and a person's choice never changes what a colleague sees. Each mode has its own setup: Agent's answers to the two quick
 * questions of a step and Director's settings column do not overwrite each other. A card's own overrides sit on top of the
 * step's setup, in whichever mode is open.
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
export const PERSON_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const STEP_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const CARD_ID = /^[A-Za-z0-9_:.-]{1,100}$/;
export const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

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
  const mode = person && modes && Object.prototype.hasOwnProperty.call(modes, person) ? modes[person] : undefined;
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
export const stepSetup = (setup: BoardSetup | null | undefined, mode: BoardMode, step: string): Setup => ({ ...(setup?.[mode]?.[step] ?? {}) });

const changed = <T extends Setup>(from: T, key: string, value: unknown): T | null => {
  if (!SETTING_KEY.test(key)) return null;
  const next: Setup = { ...from };
  if (value === null || value === undefined) delete next[key];
  else {
    const clean = cleanValue(value);
    if (clean === null) return null;
    if (!(key in next) && Object.keys(next).length >= BOARD_DATA_LIMITS.settings) return null;
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
  const next = changed(steps[step] ?? {}, key, value);
  if (!next) return current;
  if (!(step in steps) && Object.keys(steps).length >= BOARD_DATA_LIMITS.steps) return current;
  const { [step]: _was, ...others } = steps;
  const stepsNext = Object.keys(next).length ? { ...others, [step]: next } : others;
  const { [mode]: _mode, ...otherModes } = current;
  return Object.keys(stepsNext).length ? { ...otherModes, [mode]: stepsNext } : otherModes;
}

/* ── Overrides, per card ──────────────────────────────────────────────────────────────────────────── */

/** A card's own settings (a copy). */
export const cardOverrides = (overrides: CardOverrides | null | undefined, card: string): Setup => ({ ...(overrides?.[card] ?? {}) });

/** The overrides after one setting of one card: a value sets it, `null` clears it. Refusals leave them as they were. */
export function withCardOverride(overrides: CardOverrides | null | undefined, card: string, key: string, value: unknown): CardOverrides {
  const current = overrides ?? {};
  if (!CARD_ID.test(card)) return current;
  const next = changed(current[card] ?? {}, key, value);
  if (!next) return current;
  if (!(card in current) && Object.keys(current).length >= BOARD_DATA_LIMITS.cards) return current;
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
