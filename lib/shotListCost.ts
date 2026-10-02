import type { RateTable } from "./rateTable";
import { takeCost } from "./breakdownCost";
import { ceilDeci, fromDeci, toDeci } from "./creditTerms";

/**
 * One take of a planned shot, and of a list of them, in the unit this
 * workspace pays in — the rate table's, never the vendor's dollars.
 *
 * Credits are billed in tenths, per take, rounded up (lib/creditTerms.ts), so a
 * credit total is the sum of each take already rounded: rounding once at the
 * end would quote ten 28.25-credit shots at 282.5 when they bill 283. Dollars
 * are left unrounded until they are printed.
 */
type Planned = { planned: number | null; engine?: string | null; kind?: string | null };

/** One take's charge: tenths of a credit, rounded up, never less than one tenth. */
export const chargedCredits = (n: number): number => (n > 0 ? fromDeci(Math.max(1, ceilDeci(n))) : 0);

export function takeEstimate(rates: RateTable, shot: Planned): number {
  if (shot.kind === "type") return 0;
  const n = takeCost(rates, shot.planned, shot.engine);
  return rates.unit === "cr" ? chargedCredits(n) : n;
}

export function listEstimate(rates: RateTable, shots: Planned[]): number {
  if (rates.unit !== "cr") return shots.reduce((sum, shot) => sum + takeEstimate(rates, shot), 0);
  // In whole tenths, so ten 0.3 cr takes are 3, not 2.9999999999999996.
  return fromDeci(shots.reduce((sum, shot) => sum + toDeci(takeEstimate(rates, shot)), 0));
}

/** What a shot list's CSV calls its money columns, so a credit figure is never filed under `_usd`. */
export function moneyColumns(rates: RateTable): { estimate: string; spent: string } {
  return rates.unit === "cr"
    ? { estimate: "estimate_credits", spent: "spent_credits" }
    : { estimate: "estimate_usd", spent: "spent_usd" };
}
