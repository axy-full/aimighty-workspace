import { creditUsd } from "../creditTerms";

/*
 * What a Board run may spend (plan §8): only inside the limit a person approved for it, and every render only on a
 * person's approval of its quote, given as the render's own tap or as the plan's one approval (rule 14).
 *
 * There is no Auto (owner, 20 Oct 2026: "Auto goes: every job is approved on its quote"). Nothing here lets a render
 * run without a person: the no-tap ceiling Auto used (200 cr at US$0.10) and the owner's seam for it are gone, and so
 * is the per-render ask a plan made over that figure.
 * A run stored with mode "auto" reads as Ask (lib/workbench/rig-agent-plan.ts runModeOf).
 */

/**
 * The run limit the ask form suggests, as a price: US$20 of credits, so 200 cr at a credit's US$0.10. A suggestion only:
 * the person types the limit they approve, and nothing is ever let through or stopped at this figure.
 */
export const SUGGESTED_RUN_LIMIT_USD = 20;

/** The suggestion in credits at a price of a credit, in whole tenths (rounded down). */
export function suggestedRunLimitCredits(perCredit: number): number {
  if (!(Number.isFinite(perCredit) && perCredit > 0)) return 0;
  return Math.floor((SUGGESTED_RUN_LIMIT_USD / perCredit) * 10 + 1e-9) / 10;
}

/** The run limit the card suggests now (the person may change it before asking). */
export async function suggestedRunLimit(): Promise<number> {
  return suggestedRunLimitCredits(creditUsd());
}
