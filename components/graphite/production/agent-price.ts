import type { DevelopmentJob, DevelopmentQuote } from "@/lib/workbench/development-types";

type Price = Pick<DevelopmentQuote, "estimateCredits" | "estimateUsd">;
type Run = Pick<DevelopmentJob, "status" | "credits" | "costUsd" | "estimateCredits" | "estimateUsd" | "ownKey">;

const credits = (n: number) => { const whole = Math.max(0, Math.round(n)); return `${whole.toLocaleString("en-US")} ${whole === 1 ? "credit" : "credits"}`; };

/** Only retail quotes issued by the server may be shown to customers. */
export function agentPrice(quote: Price, inCredits: boolean): string {
  if (!inCredits || (quote.estimateCredits === 0 && quote.estimateUsd != null)) return "Quote unavailable";
  return credits(quote.estimateCredits);
}

export function agentReserved(run: Run, inCredits: boolean): string {
  if (run.ownKey === true) return "External account · historical";
  if (!inCredits) return "Quote unavailable";
  return `reserved up to ${credits(run.estimateCredits)}`;
}

export function agentCharged(run: Run, _inCredits: boolean): string | null {
  if (run.ownKey === true) return "External account · historical";
  if (run.status === "failed" && run.credits === 0) return "not billed";
  return run.credits == null ? null : credits(run.credits);
}
