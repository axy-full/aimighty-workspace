"use client";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { useQuoteReads, type QuoteReader } from "./use-quote-reads";

/** Prices a generation request, quote-only (nothing reserved). */
const readGenerateQuote: QuoteReader = (request, scope, signal) => studioRequest<{ estimatedCredits: number; approximate?: boolean; price?: number; unit?: string }>("/api/generate/quote", {
  method: "POST", signal,
  headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
  body: JSON.stringify(request.body),
});

/** useStageQuotes for a caller that only prices generations (the Rig's "what a change will cost"): it never touches the transcription route. */
export function useGenerateQuotes(scope: string, requests: Record<string, { body: Record<string, unknown> }>) {
  return useQuoteReads(scope, requests, readGenerateQuote);
}
