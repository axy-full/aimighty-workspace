"use client";
import { useEffect, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import type { AdmissionQuote } from "@/lib/admissionTypes";
import type { SpendPrice } from "@/lib/spend";

/**
 * The free quote for one exact request body (POST /api/generate/quote: admission's own validation and the engine's
 * live estimate through Particl's credit terms; nothing is reserved), asked a moment after the body stops changing.
 * Used by the phone's Change with words and Make's Upscale: the price on their button is this figure and no other,
 * and the quote's fingerprint and ceiling ride on the one paid send (the same two fields Make's own panels send).
 */

export type BodyQuote =
  | { state: "none" }
  | { state: "reading" }
  | { state: "ready"; quote: AdmissionQuote; body: Record<string, unknown> }
  | { state: "error"; reason: string };

const QUOTE_FAULT = "The price could not be read. Try again.";

/** The free quote for `body` (null: nothing to ask). Re-asked a moment after the words stop changing. */
export function useBodyQuote(scope: string, body: Record<string, unknown> | null): BodyQuote {
  const key = body ? JSON.stringify(body) : null;
  const [answer, setAnswer] = useState<{ key: string; result: BodyQuote } | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void studioRequest<AdmissionQuote>("/api/generate/quote", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: key,
      }).then((quote) => {
        if (controller.signal.aborted) return;
        const whole = Number.isInteger(quote.estimatedCredits) && quote.estimatedCredits >= 0 && /^[a-f0-9]{64}$/.test(quote.fingerprint);
        if (!whole) { setAnswer({ key, result: { state: "error", reason: QUOTE_FAULT } }); return; }
        if (quote.unit !== "cr") { setAnswer({ key, result: { state: "error", reason: "This change is priced outside credits. Open it in Make." } }); return; }
        setAnswer({ key, result: { state: "ready", quote, body: JSON.parse(key) as Record<string, unknown> } });
      }).catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAnswer({ key, result: { state: "error", reason: cause instanceof Error && cause.message ? cause.message : QUOTE_FAULT } });
      });
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, scope]);
  if (!key) return { state: "none" };
  return answer?.key === key ? answer.result : { state: "reading" };
}

/** The server's quote as the shared price: "43 cr", or "up to 43 cr" when the charge settles on what was delivered. */
export function quotePrice(quote: AdmissionQuote | null | undefined): SpendPrice {
  if (!quote || quote.unit !== "cr") return null;
  return quote.approximate ? { upTo: quote.estimatedCredits } : { cr: quote.estimatedCredits };
}

