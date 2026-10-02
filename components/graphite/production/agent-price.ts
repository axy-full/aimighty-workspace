import type { DevelopmentJob, DevelopmentQuote } from "@/lib/workbench/development-types";
import { creditsFigure, fromDeci, toDeci } from "@/lib/creditTerms";

type Price = Pick<DevelopmentQuote, "estimateCredits" | "estimateUsd">;
type Run = Pick<DevelopmentJob, "status" | "credits" | "costUsd" | "estimateCredits" | "estimateUsd" | "ownKey">;

const usdOf = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
/* Credits are charged in tenths (lib/creditTerms.ts): "0.4 credits", "12 credits", "1 credit". */
const credits = (n: number) => { const v = Math.max(0, fromDeci(toDeci(n))); return `${creditsFigure(v)} ${v === 1 ? "credit" : "credits"}`; };
const dollars = (n: number) => `$${n.toFixed(4)}`;

/*
 * An agent's price, in the one unit the workspace pays in — never two: side
 * by side, credits and the engines' dollars are the margin (#372).
 *
 * - A credit workspace (`inCredits`): only the retail credits the server
 *   quoted. A quote that arrives with dollars and no credits is not shown.
 * - The house workspace (`inCredits` false, lib/houseWorkspace.ts): never
 *   billed in credits, it reads the engines' dollars its own quote carries;
 *   the server sends those dollars to no other workspace.
 */

/** Only retail quotes issued by the server may be shown to a credit workspace. */
export function agentPrice(quote: Price, inCredits: boolean): string {
  if (!inCredits) { const usd = usdOf(quote.estimateUsd); return usd != null ? dollars(usd) : "Quote unavailable"; }
  if (quote.estimateCredits === 0 && quote.estimateUsd != null) return "Quote unavailable";
  return credits(quote.estimateCredits);
}

/** A run in progress: what it may cost. */
export function agentReserved(run: Run, inCredits: boolean): string {
  if (!inCredits) { const usd = usdOf(run.estimateUsd); return usd != null ? `up to ${dollars(usd)}` : "Quote unavailable"; }
  if (run.ownKey === true) return "External account · historical";
  return `reserved up to ${credits(run.estimateCredits)}`;
}

/** What a finished run cost, in the same unit, or null while it settles. */
export function agentCharged(run: Run, inCredits: boolean): string | null {
  if (!inCredits) { const usd = usdOf(run.costUsd); return usd == null ? null : dollars(usd); }
  if (run.ownKey === true) return "External account · historical";
  if (run.status === "failed" && run.credits === 0) return "not billed";
  return run.credits == null ? null : credits(run.credits);
}
