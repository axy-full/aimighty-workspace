/**
 * When the new header shows the low-credit chip (docs/redesign-plan.md, decision 6).
 *
 *  - Low when the balance is below 20% of the plan's included credits for the cycle.
 *  - On a plan that includes no credits (Invite, lib/plans.ts), the base is the workspace's welcome grant.
 *  - Never for a workspace that does not pay in credits (the house workspace, lib/credits.ts creditsApply).
 *  - Never when the base is unknown or zero: no warning rather than a guessed one.
 *
 * The share is the owner's rule, not a credit figure. The figures come from the server: the balance from the ledger, the
 * base from lib/v12/lowCredit.server.ts on the session (`session.credits.planIncludedCredits` / `welcomeGrant`).
 *
 * Pure: no React, no fetch.
 */

/** The owner's rule, as a whole percentage of the base. */
export const LOW_CREDIT_PERCENT = 20;

export type LowCreditInput = {
  balance: number | null | undefined;
  /** The current cycle's included credits; 0 on a plan that includes none. */
  planIncludedCredits: number | null | undefined;
  /** The workspace's one-time welcome grant: the base when the plan includes no credits. */
  welcomeGrant: number | null | undefined;
  paysInCredits: boolean;
};

export type LowCredit = {
  low: boolean;
  /** The balance as a percentage of the base (0–100+, one decimal), or null when there is no base. */
  remainingPct: number | null;
  /** The balance under which the chip shows (20% of the base), or null when there is no base. */
  threshold: number | null;
  /** What the 20% is of: the plan's included credits, or the welcome grant. Null when neither is known. */
  base: number | null;
};

const NOT_LOW: LowCredit = Object.freeze({ low: false, remainingPct: null, threshold: null, base: null });
const count = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function lowCredit({ balance, planIncludedCredits, welcomeGrant, paysInCredits }: LowCreditInput): LowCredit {
  if (!paysInCredits) return NOT_LOW;
  const base = count(planIncludedCredits) && planIncludedCredits > 0 ? planIncludedCredits
    : count(welcomeGrant) && welcomeGrant > 0 ? welcomeGrant : null;
  if (base === null) return NOT_LOW;
  const threshold = (base * LOW_CREDIT_PERCENT) / 100;
  if (!count(balance)) return { low: false, remainingPct: null, threshold, base };
  /* Compared in whole percentages, so exactly 20% is not low. Credits count in tenths at the finest
     (lib/runLimit.ts), so a gap under a millionth is floating point, never a real shortfall. */
  const low = base * LOW_CREDIT_PERCENT - balance * 100 > 1e-6;
  const remainingPct = Math.round((Math.max(0, balance) / base) * 1000) / 10;
  return { low, remainingPct, threshold, base };
}
