"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

/** One quote to read. `transcription` is only meaningful to the reader that knows the transcription route. */
export type QuoteRequest = { body: Record<string, unknown>; transcription?: boolean };
/** `approximate`: the server quoted it from published rates; the charge may settle above it (lib/runLimit.ts jobBand). */
type Quote = { key: string; credits?: number; /** The same in the engines' dollars, when the route answered in them (the house pays at cost). */ usd?: number; approximate?: true; error?: string };
/** How one request is priced: a side-effect-free POST that reserves nothing. */
export type QuoteReader = (request: QuoteRequest, scope: string, signal: AbortSignal) => Promise<{ estimatedCredits: number; approximate?: boolean; price?: number; unit?: string }>;

/**
 * The quote-reading hook behind useStageQuotes (every stage's price reads) and useGenerateQuotes (the Rig's): the reader says
 * which route a request is priced on, so a caller that only prices generations does not reach the transcription route.
 * Only side-effect-free quotes run here. Paid requests stay in the stage's explicit action.
 */
export function useQuoteReads(scope: string, requests: Record<string, QuoteRequest>, read: QuoteReader) {
  const serialized = JSON.stringify(requests);
  const inputs = useMemo(() => JSON.parse(serialized) as Record<string, QuoteRequest>, [serialized]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [retry, setRetry] = useState(0);
  const keyFor = useCallback((request: QuoteRequest) => JSON.stringify([scope, request]), [scope]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        // Serial reads avoid a request burst on a full storyboard. Unchanged frames keep their quote.
        for (const [id, request] of Object.entries(inputs)) {
          const key = keyFor(request);
          if (quotes[id]?.key === key) continue;
          try {
            const reply = await read(request, scope, controller.signal);
            if (controller.signal.aborted) return;
            if (!Number.isFinite(reply.estimatedCredits) || reply.estimatedCredits < 0) throw new Error("The price could not be read. Try again.");
            setQuotes((all) => ({ ...all, [id]: { key, credits: reply.estimatedCredits, ...(reply.unit === "usd" && Number.isFinite(reply.price) ? { usd: reply.price } : {}), ...(reply.approximate ? { approximate: true as const } : {}) } }));
          } catch (cause) {
            if (controller.signal.aborted) return;
            setQuotes((all) => ({ ...all, [id]: { key, error: cause instanceof Error ? cause.message : "The price could not be read. Try again." } }));
          }
        }
      })();
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
    // Quote results must not restart the debounce or abort another frame's read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, keyFor, read, scope, retry]);

  const current: Record<string, Quote | undefined> = {};
  for (const [id, request] of Object.entries(inputs)) {
    if (quotes[id]?.key === keyFor(request)) current[id] = quotes[id];
  }
  return {
    quotes: current,
    tryAgain: (id: string) => {
      setQuotes((all) => { const next = { ...all }; delete next[id]; return next; });
      setRetry((n) => n + 1);
    },
    reprice: (id: string, credits: number) => {
      const request = inputs[id];
      if (request) {
        const key = keyFor(request);
        setQuotes((all) => all[id] && all[id].key !== key ? all : { ...all, [id]: { key, credits } });
      }
    },
  };
}
