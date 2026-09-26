import type { RateTable } from "./rateTable";
import { takeCost } from "./breakdownCost";

/**
 * One take of a planned shot, and of a list of them, in the unit this
 * workspace pays in — the rate table's, never the vendor's dollars.
 *
 * Credits are billed whole, per take, rounded up (lib/creditTerms.ts), so a
 * credit total is the sum of each take already rounded: rounding once at the
 * end would quote ten 28.2-credit shots at 282 when they bill 290. Dollars are
 * left unrounded until they are printed.
 */
type Planned = { planned: number | null; engine?: string | null; kind?: string | null };

export const wholeCredits = (n: number): number => (n > 0 ? Math.max(1, Math.ceil(n - 1e-9)) : 0);

export function takeEstimate(rates: RateTable, shot: Planned): number {
  if (shot.kind === "type") return 0;
  const n = takeCost(rates, shot.planned, shot.engine);
  return rates.unit === "cr" ? wholeCredits(n) : n;
}

export function listEstimate(rates: RateTable, shots: Planned[]): number {
  return shots.reduce((sum, shot) => sum + takeEstimate(rates, shot), 0);
}

/** What a shot list's CSV calls its money columns, so a credit figure is never filed under `_usd`. */
export function moneyColumns(rates: RateTable): { estimate: string; spent: string } {
  return rates.unit === "cr"
    ? { estimate: "estimate_credits", spent: "spent_credits" }
    : { estimate: "estimate_usd", spent: "spent_usd" };
}
