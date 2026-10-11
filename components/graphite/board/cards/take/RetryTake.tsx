"use client";
import type { MouseEvent } from "react";
import { usePriceTitle } from "@/components/graphite/Price";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { exact, priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import type { LibraryEntry } from "@/lib/workspace/library";
import { retryQuoteBody } from "@/lib/workspace/retry-request";

/**
 * A failed take's Retry with its price (design Gaps B: "Retry · 43 cr"): the server's quote for the request Retry makes
 * again (lib/workspace/retry-request.ts; POST /api/generate/quote, free and repeatable). Pressing it hands the take's
 * recipe to Make (`onRetry`, today's Recreate), where the same request is priced again and a person presses Make: this
 * button sends nothing itself. While the quote is out it reads plain "Retry"; a quote that fails or is only a ceiling
 * shows no figure here, and Make says it.
 */
export function RetryTake({ entry, scope, onRetry, className }: { entry: LibraryEntry; scope: string; onRetry: () => void; className: string }) {
  const g = entry.asset.origin === "generation" ? entry.asset.value : null;
  const body = g ? retryQuoteBody(g) : null;
  const quotes = useStageQuotes(scope, body ? { retry: { body } } : {});
  const quote = quotes.quotes.retry;
  const price = quote && quote.credits != null && !quote.approximate ? exact(quote.credits) : null;
  const words = priceWords(price);
  const title = usePriceTitle(price);
  return (
    <button type="button" className={`${className} nodrag nopan`} title={title ?? undefined} {...(price ? spendAttrsOf(price) : {})}
      onDoubleClick={(e) => e.stopPropagation()} onClick={(e: MouseEvent) => { e.stopPropagation(); onRetry(); }} data-testid="take-retry">
      {words ? `Retry · ${words}` : "Retry"}
    </button>
  );
}
