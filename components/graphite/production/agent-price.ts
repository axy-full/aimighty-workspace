import type { DevelopmentQuote } from "@/lib/workbench/development-types";

type Price = Pick<DevelopmentQuote, "estimateCredits" | "estimateUsd">;
const NO_CREDITS = "up to 0 credits";

/**
 * An agent quote's words with the price put right. Every stage writes its
 * price as "up to N credits". A model on the workspace's own key bills its
 * dollars, not credits, so that quote names the dollar ceiling instead of
 * "up to 0 credits". `line` marks the quote line, which also carries the
 * dollar ceiling beside a credit price when the quote has one.
 */
export function pricedAgentText(text: string, quote: Price, line = false): string {
  if (quote.estimateUsd == null) return text;
  const usd = `$${quote.estimateUsd.toFixed(4)}`;
  if (quote.estimateCredits === 0) {
    if (text.includes(NO_CREDITS)) return text.split(NO_CREDITS).join(`up to ${usd} on your key`);
    return line ? `${text} · ${usd} on your key` : text;
  }
  return line ? `${text} · ${usd} ceiling` : text;
}
