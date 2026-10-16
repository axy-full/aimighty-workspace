/*
 * The quick answers of a board step in Agent mode ("chips"), defined once, on the server (v25 plan, PR 8).
 *
 * Atomik asks two quick questions per step. They are fixed chips drawn from the step's settings, so they cost nothing and call no model; the screen draws whatever
 * `GET team-canvas?agent=1&steps=1` returns. Each chip has its API `key` and the `setupKey` it is kept under in the draft (`boardSetup.agent[step][setupKey]`,
 * lib/v12/board/board-data.ts), so a person's answers carry from one plan to the next and this table is the one place to rename either.
 *
 * Shots: Quality (Draft or Final) and Length. Takes is not a chip: a plan renders one take per shot, and another take of a shot is a fix, drawn under the plan's
 * approval (two at most per shot, lib/workbench/plan-approval.ts).
 *
 * Pure: no database, no engine, nothing priced here.
 */

export type ChipOption = { value: string | number; label: string };
export type Chip = { key: string; setupKey: string; label: string; options: readonly ChipOption[]; default: string | number };
export type ChipAnswers = { quality: "draft" | "final"; length: number };

export const SHOTS_STEP = "shots";

export const STEP_CHIPS: Record<string, readonly Chip[]> = {
  [SHOTS_STEP]: [
    { key: "quality", setupKey: "quality", label: "Quality", default: "draft", options: [{ value: "draft", label: "Draft" }, { value: "final", label: "Final" }] },
    { key: "length", setupKey: "length", label: "Length", default: 5, options: [3, 5, 8, 10].map((s) => ({ value: s, label: `${s} s` })) },
  ],
};

/** The steps that have a chips plan. */
export const chipSteps = (): string[] => Object.keys(STEP_CHIPS);
export const chipsOf = (step: string): readonly Chip[] | null => (Object.hasOwn(STEP_CHIPS, step) ? STEP_CHIPS[step] : null);

/** What `GET ...&steps=1` answers: each step's chips, in order, with their defaults. */
export const chipsView = () => Object.fromEntries(chipSteps().map((step) => [step, STEP_CHIPS[step].map((c) => ({ key: c.key, setupKey: c.setupKey, label: c.label, default: c.default, options: c.options }))]));

const allowed = (chip: Chip, value: unknown): value is string | number => chip.options.some((o) => o.value === value);

/**
 * The answers a plan is made with: what the person sent now, else what the draft keeps for this step in Agent mode, else the chip's default. An answer sent that is
 * not one of the chip's options is refused in words; one kept that no longer is one is ignored.
 */
export function resolveAnswers(step: string, sent: unknown, kept: unknown): ChipAnswers | { error: string } {
  const chips = chipsOf(step);
  if (!chips) return { error: "Atomik has no quick questions for that step yet." };
  const given = sent && typeof sent === "object" && !Array.isArray(sent) ? (sent as Record<string, unknown>) : {};
  const saved = kept && typeof kept === "object" && !Array.isArray(kept) ? (kept as Record<string, unknown>) : {};
  for (const key of Object.keys(given)) if (!chips.some((c) => c.key === key)) return { error: `"${key}" is not a question of this step.` };
  const out: Record<string, string | number> = {};
  for (const chip of chips) {
    if (chip.key in given) {
      if (!allowed(chip, given[chip.key])) return { error: `Pick one of the ${chip.label.toLowerCase()} choices.` };
      out[chip.key] = given[chip.key] as string | number;
    } else out[chip.key] = allowed(chip, saved[chip.setupKey]) ? (saved[chip.setupKey] as string | number) : chip.default;
  }
  return out as unknown as ChipAnswers;
}
