"use client";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { useQuoteReads, type QuoteReader, type QuoteRequest } from "./use-quote-reads";

/** Prices a request on its own route: a transcription on the transcription route (quote-only), anything else as a generation. */
const readQuote: QuoteReader = (request, scope, signal) => studioRequest<{ estimatedCredits: number; approximate?: boolean; price?: number; unit?: string }>(request.transcription ? "/api/audio/transcribe" : "/api/generate/quote", {
  method: "POST", signal,
  headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
  body: JSON.stringify(request.transcription ? { ...request.body, quoteOnly: true } : request.body),
});

/** Only side-effect-free quotes run here. Paid requests stay in the stage's explicit action. */
export function useStageQuotes(scope: string, requests: Record<string, QuoteRequest>) {
  return useQuoteReads(scope, requests, readQuote);
}
