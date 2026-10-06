"use client";
import { useEffect, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import type { AdmissionQuote } from "@/lib/admissionTypes";
import { usePaidAction } from "@/lib/usePaidAction";
import type { SpendPrice } from "@/lib/spend";
import type { LibraryEntry } from "@/lib/workspace/library";
import { editQuoteBody } from "../board/inspector/inspector-model";

/**
 * Change with words on the phone (design/particl-graphite, Phone frames D): the existing Seedance Edit route and
 * its quote, asked the way Make's own Edit panel asks (components/make/SeedanceEdit.tsx): a free quote first
 * (POST /api/generate/quote), then one paid request that carries that quote's fingerprint and ceiling, claimed
 * before it is sent (lib/usePaidAction.ts) so a lost reply is recovered and never sent twice. The price on the
 * button is the server's figure for these very words; nothing here prices anything.
 */

export type FixQuote =
  | { state: "none" }
  | { state: "reading" }
  | { state: "ready"; quote: AdmissionQuote; body: Record<string, unknown> }
  | { state: "error"; reason: string };

const QUOTE_FAULT = "The price could not be read. Try again.";

/** The free quote for `body` (null: nothing to ask). Re-asked a moment after the words stop changing. */
export function useFixQuote(scope: string, body: Record<string, unknown> | null): FixQuote {
  const key = body ? JSON.stringify(body) : null;
  const [answer, setAnswer] = useState<{ key: string; result: FixQuote } | null>(null);
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

/** The body Seedance Edit's quote and send both use, for this take and these words (null: not a clip). */
export function fixBody(entry: LibraryEntry | null, productionId: string | null | undefined, words: string): Record<string, unknown> | null {
  if (!entry || entry.asset.origin !== "generation") return null;
  return editQuoteBody({ genId: entry.asset.value.id, media: entry.media === "video" ? "video" : entry.media === "image" ? "image" : null, entry } as Parameters<typeof editQuoteBody>[0], productionId, words);
}

/** How many fixes this shot already has (every version after the first), and which one the next is. */
export const FIXES_PLANNED = 2;
export function fixLine(versions: number): string {
  const next = Math.max(1, versions);
  return next <= FIXES_PLANNED ? `fix ${next} of ${FIXES_PLANNED}` : `fix ${next}`;
}

/** The one paid send: the same claim Make's Seedance Edit panel keeps for this project, so a saved request is recovered by either. */
export function useFixSend(projectId: string) {
  const paid = usePaidAction(`gen:seedance-2.5-edit:${projectId}`);
  const saved = paid.pending ? (JSON.parse(paid.pending.body) as Record<string, unknown>) : null;
  const send = async (ready: Extract<FixQuote, { state: "ready" }> | null, context: Record<string, unknown>) => {
    const request = saved ?? (ready ? { ...ready.body, maxCredits: ready.quote.estimatedCredits, quoteFingerprint: ready.quote.fingerprint } : null);
    if (!request) throw new Error(QUOTE_FAULT);
    const result = await paid.run<{ id: string }>("/api/generate", request, { context });
    if (!result.data.id) throw new Error("Check Activity for the saved edit request.");
    return result.data.id;
  };
  return { pending: paid.pending, error: paid.error, saved, send };
}
