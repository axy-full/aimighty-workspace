/**
 * What a control that spends takes from the quote it shows (CLAUDE.md rule 14). Pure: no React.
 *  - `approvedFigure`: the figure a person's press approves, the quote's own, in the unit it is shown in (credits; the house workspace's
 *    dollars), never worked out from another figure, so a price the person did not see is never approved.
 *  - `spendAttrsOfQuote`: the control's spend marker (lib/spend.ts): the quote's own figure once it has one, else unpriced and disabled.
 */
import { spendAttrsOf } from "@/lib/spend";
import type { Quote } from "./quote";

export function approvedFigure(quote: Quote): number | null {
  if (quote.state !== "ready") return null;
  const price = quote.price;
  if (price.unit === "usd") return Number.isFinite(price.usd) ? price.usd : null;
  return price.value.kind === "free" ? 0 : Number.isFinite(price.value.credits) ? price.value.credits : null;
}

export function spendAttrsOfQuote(quote: Quote, words: (quote: Quote) => string) {
  if (quote.state === "ready") {
    const price = quote.price;
    /* A credit workspace's figure marks the control as its own price; the house pays in dollars, so it carries the words <Price> shows. */
    return price.unit === "cr" ? spendAttrsOf(price.value) : { "data-spend": "priced" as const, "data-spend-price": words(quote) };
  }
  return { "data-spend": "unpriced" as const };
}
