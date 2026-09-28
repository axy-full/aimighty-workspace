import type { DevelopmentJob, DevelopmentQuote } from "@/lib/workbench/development-types";
import { creditsFigure, fromDeci, toDeci } from "@/lib/creditTerms";

type Price = Pick<DevelopmentQuote, "estimateCredits" | "estimateUsd">;
type Run = Pick<DevelopmentJob, "status" | "credits" | "costUsd" | "estimateCredits" | "estimateUsd" | "ownKey">;

const usdOf = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
/* Credits are charged in tenths (lib/creditTerms.ts): "0.4 credits", "12 credits", "1 credit". */
const credits = (n: number) => { const v = Math.max(0, fromDeci(toDeci(n))); return `${creditsFigure(v)} ${v === 1 ? "credit" : "credits"}`; };
const dollars = (n: number) => `$${n.toFixed(4)}`;
/* A run's own flag, from the server; an older reply without it reads a zero-credit estimate as the workspace's own key. */
const onKey = (run: Run) => run.ownKey ?? run.estimateCredits === 0;

/**
 * An agent quote's ceiling, in the one unit this workspace pays in — never
 * two: side by side, credits and the vendor's dollars are the margin (#372).
 *
 * - On the platform's keys: the credits the server priced it at (billCredits
 *   at creditUsd(), lib/creditTerms.ts). The browser converts nothing.
 * - A model on the workspace's own key, in a credit workspace: the server
 *   prices it at 0 credits and keeps the dollars its own account is charged,
 *   so those are named, "on your key" — never "0 credits".
 * - A workspace that pays its vendors in dollars (`inCredits` false): dollars.
 */
export function agentPrice(quote: Price, inCredits: boolean): string {
  const usd = usdOf(quote.estimateUsd);
  if (!inCredits) return usd != null ? dollars(usd) : credits(quote.estimateCredits);
  if (quote.estimateCredits > 0 || usd == null) return credits(quote.estimateCredits);
  return `${dollars(usd)} on your key`;
}

/** A run in progress: what it may cost. A credit workspace's run list carries no dollars. */
export function agentReserved(run: Run, inCredits: boolean): string {
  const usd = usdOf(run.estimateUsd);
  if (!inCredits) return usd != null ? `up to ${dollars(usd)}` : `up to ${credits(run.estimateCredits)}`;
  if (onKey(run)) return usd != null ? `up to ${dollars(usd)} on your key` : "billed on your key";
  return `reserved up to ${credits(run.estimateCredits)}`;
}

/**
 * What a finished run cost, in the same unit, or null while it settles. A
 * failed run on credits is never billed, and says so; a run on the
 * workspace's own key was paid there.
 */
export function agentCharged(run: Run, inCredits: boolean): string | null {
  if (!inCredits) { const usd = usdOf(run.costUsd); return usd == null ? null : dollars(usd); }
  if (onKey(run)) return "billed on your key";
  if (run.status === "failed" && !run.credits) return "not billed";
  return run.credits == null ? null : credits(run.credits);
}
