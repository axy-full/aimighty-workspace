"use client";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { creditRate } from "@/lib/shell/price-words";
import { IDLE, LOADING, QUOTE_FAULT, quoteFromResponse, quoteRequest, type MoneyTerms, type Quote, type QuoteSource } from "./quote";

/**
 * The live price of one action, from its quote route (lib/v12/quote.ts › QuoteSource), for `<Price quote={…} />`.
 *
 * Asked a moment after the source stops changing (as today's useBodyQuote and useAtomikQuote do), through the session's
 * scoped fetch, so an answer for another workspace or account is refused by the server. Only the answer to the current
 * source is shown: while a newer one is asked, the state is "loading", never the old figure. Null source: "idle".
 */
export function useQuote(source: QuoteSource | null, { debounceMs = 400 }: { debounceMs?: number } = {}): Quote {
  const session = useSession();
  const fetcher = useScopedFetch();
  const terms = useMemo<MoneyTerms>(() => ({
    paysInDollars: session.rates.unit === "usd",
    creditUsd: creditRate(session.rates.creditUsd),
  }), [session.rates.unit, session.rates.creditUsd]);
  const key = source ? JSON.stringify(source) : null;
  const [answer, setAnswer] = useState<{ key: string; quote: Quote } | null>(null);

  useEffect(() => {
    if (!key) return;
    const asked = JSON.parse(key) as QuoteSource;
    const { url, init } = quoteRequest(asked);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetcher(url, { ...init, signal: controller.signal })
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          if (!controller.signal.aborted) setAnswer({ key, quote: quoteFromResponse(asked, response.ok, body, terms) });
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setAnswer({ key, quote: { state: "error", message: cause instanceof Error && cause.message ? cause.message : QUOTE_FAULT } });
        });
    }, debounceMs);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, fetcher, terms, debounceMs]);

  if (!key) return IDLE;
  return answer?.key === key ? answer.quote : LOADING;
}
