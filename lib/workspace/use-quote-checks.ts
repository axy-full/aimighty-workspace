'use client';
import { useCallback, useEffect, useRef, useState } from "react";
import { checkQuote, type QuoteCheck } from "./generate-submit";

/** A beat after a body appears (a setting being clicked through), then a few questions at a time. */
const SETTLE_MS = 300;
const AT_ONCE = 3;

/**
 * The quote route's verdict (checkQuote) on each body a page may send, for a
 * page that prices its own runs (the rate-table Rig canvas): asked once per
 * distinct body, a beat after it appears, a few at a time, and kept while the
 * page is open. Asking is free; nothing is reserved or sent.
 *
 * `verdict(body)` is what is known now, undefined until the answer is in.
 * `ask(body)` is the verdict at the moment of a press: the one in hand, the
 * question already out, or a fresh question when there is none or the last
 * one got no answer.
 */
export function useQuoteChecks(scope: string | null | undefined, bodies: Record<string, unknown>[]) {
  const [known, setKnown] = useState<Record<string, QuoteCheck>>({});
  const settled = useRef(new Map<string, QuoteCheck>());
  const asking = useRef(new Map<string, Promise<QuoteCheck>>());
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  /* Keyed by workspace scope and body together: a verdict never crosses a workspace. */
  const keyOf = useCallback((body: Record<string, unknown>) => `${scope ?? ""}\n${JSON.stringify(body)}`, [scope]);

  const start = useCallback((key: string, body: Record<string, unknown>): Promise<QuoteCheck> => {
    const out = asking.current.get(key);
    if (out) return out;
    if (!scope) return Promise.resolve("failed");
    const promise = checkQuote(scope, body).then((verdict) => {
      asking.current.delete(key);
      settled.current.set(key, verdict);
      if (live.current) setKnown((was) => (was[key] === verdict ? was : { ...was, [key]: verdict }));
      return verdict;
    });
    asking.current.set(key, promise);
    return promise;
  }, [scope]);

  const wanted = [...new Set(bodies.map(keyOf))].sort().join("\u0000");
  useEffect(() => {
    if (!scope || !wanted) return;
    let stopped = false;
    const timer = setTimeout(() => {
      const queue = [...new Map(bodies.map((body) => [keyOf(body), body] as const)).entries()];
      let out = 0;
      const next = () => {
        while (!stopped && out < AT_ONCE && queue.length) {
          const [key, body] = queue.shift()!;
          if (settled.current.has(key) || asking.current.has(key)) continue;
          out++;
          void start(key, body).finally(() => { out--; next(); });
        }
      };
      next();
    }, SETTLE_MS);
    return () => { stopped = true; clearTimeout(timer); };
    // `wanted` names exactly the bodies asked about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, wanted, keyOf, start]);

  const verdict = useCallback((body: Record<string, unknown>): QuoteCheck | undefined => known[keyOf(body)], [known, keyOf]);
  const ask = useCallback((body: Record<string, unknown>): Promise<QuoteCheck> => {
    const key = keyOf(body);
    const hit = settled.current.get(key);
    if (hit && hit !== "failed") return Promise.resolve(hit);
    return start(key, body);
  }, [keyOf, start]);
  return { verdict, ask };
}
