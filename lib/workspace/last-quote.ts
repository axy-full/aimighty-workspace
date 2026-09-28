import { useSyncExternalStore } from "react";
import { ceilDeci, fromDeci } from "../creditTerms";

/**
 * The last price a Generate button showed in this workspace's credits — the
 * figure the header's credits pill measures the balance against (amber when
 * the balance is below it). It is written only where a quote already landed
 * (the Gen composer's live price, the fresh quote a Generate takes before it
 * sends), per request scope, and never asked for here: reading it quotes
 * nothing and costs nothing. A connected account's quote is in that
 * account's credits, not this workspace's, and is never recorded. Kept for
 * the page's life only.
 */
export type LastQuote = { credits: number; at: number };

const quotes = new Map<string, LastQuote>();
const listeners = new Set<() => void>();

export function rememberWorkspaceQuote(scope: string | null | undefined, credits: number | null | undefined): void {
  if (!scope || typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return;
  // To the tenth it was quoted at, rounded up: a price never reads lower than it is.
  const whole = fromDeci(ceilDeci(credits));
  if (quotes.get(scope)?.credits === whole) return;
  quotes.set(scope, { credits: whole, at: Date.now() });
  for (const listener of listeners) listener();
}

export function lastWorkspaceQuote(scope: string | null | undefined): LastQuote | null {
  return scope ? quotes.get(scope) ?? null : null;
}

/** The balance cannot pay for what was last quoted. Unknown either way is not low. */
export function lowBalance(balance: number | null | undefined, quote: Pick<LastQuote, "credits"> | null): boolean {
  return typeof balance === "number" && Number.isFinite(balance) && quote != null && quote.credits > 0 && balance < quote.credits;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLastQuote(scope: string | null | undefined): LastQuote | null {
  return useSyncExternalStore(subscribe, () => lastWorkspaceQuote(scope), () => null);
}
