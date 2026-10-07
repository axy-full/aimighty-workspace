"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { isRawPrompt, type EnhanceMode, type EnhancerProvider } from "./enhancer";

/**
 * The Enhance button's life (README › Prompt enhancer), against
 * POST /api/prompt/enhance. The button always wears the live price: a quote
 * is read (free, read-only) once the words settle, pressing the button
 * approves exactly that figure, and the run carries it back as `maxCredits`
 * so a price that moved refuses instead of charging more. Nothing here knows
 * a price of its own.
 */
export type EnhancerInput = {
  prompt: string; mode: EnhanceMode; model: string | null; anchored: boolean; editing: boolean;
  /** The sample's line in the sample workspace: Enhance is off there (nothing quoted, nothing sent, Auto stays off). */
  off?: string | null;
};

export type EnhancerHost = {
  auto: boolean;
  setAuto: (value: boolean) => void;
  /** The quoted price, or null while it is unknown. */
  credits: number | null;
  /** Why Enhance cannot run right now, said on the control. */
  blocked: string | null;
  busy: boolean;
  enhanced: string | null;
  provider: EnhancerProvider | null;
  /** What the last enhancement was approved at. */
  charged: number | null;
  error: string | null;
  enhance: () => void;
  /** The same press, awaited: the enhanced words, or null when nothing came back (the error is then on `error`). Auto's press uses it. */
  run: () => Promise<string | null>;
  dismiss: () => void;
};

const QUOTE_DELAY_MS = 600;
const bodyOf = (input: EnhancerInput) => ({ prompt: input.prompt.trim(), mode: input.mode, ...(input.model ? { model: input.model } : {}), anchored: input.anchored, editing: input.editing });

export function useEnhancer(input: EnhancerInput): EnhancerHost {
  const scoped = useScopedFetch();
  const [auto, setAuto] = useState(false);
  const [quote, setQuote] = useState<{ key: string; credits: number | null; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ prompt: string; provider: EnhancerProvider; charged: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const words = input.prompt.trim();
  const raw = isRawPrompt(input.prompt);
  const key = JSON.stringify(bodyOf(input));
  const off = input.off ?? null;
  const quotable = Boolean(words) && !raw && !off;

  /* The quote follows the words, debounced; a stale answer is dropped by key. */
  useEffect(() => {
    if (!quotable) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const response = await scoped("/api/prompt/enhance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(key), quoteOnly: true }) });
        const json = await response.json().catch(() => null) as { estimateCredits?: number; error?: string } | null;
        if (!live) return;
        setQuote(response.ok && typeof json?.estimateCredits === "number"
          ? { key, credits: json.estimateCredits, reason: null }
          : { key, credits: null, reason: json?.error ?? "The enhancer cannot be priced right now." });
      } catch (caught) {
        if (live) setQuote({ key, credits: null, reason: caught instanceof Error ? caught.message : "The enhancer cannot be priced right now." });
      }
    }, QUOTE_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [key, quotable, scoped]);

  const current = quote && quote.key === key ? quote : null;
  const credits = quotable ? current?.credits ?? null : null;
  const blocked = off ? off
    : !words ? "Write a few words first."
    : raw ? "raw: is sent as written."
    : current?.reason ? current.reason
    : credits == null ? "Pricing…"
    : null;

  const live = useRef({ key, credits });
  useEffect(() => { live.current = { key, credits }; });

  const enhance = useCallback(async (): Promise<string | null> => {
    const approved = live.current;
    if (approved.credits == null || off) return null;
    setBusy(true);
    setError(null);
    try {
      const response = await scoped("/api/prompt/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `enhance-${crypto.randomUUID()}` },
        body: JSON.stringify({ ...JSON.parse(approved.key), maxCredits: approved.credits }),
      });
      const json = await response.json().catch(() => null) as { prompt?: string; provider?: EnhancerProvider; error?: string } | null;
      if (!response.ok || !json?.prompt || !json.provider) throw new Error(json?.error ?? "The enhancer did not answer. Your prompt is unchanged.");
      setResult({ prompt: json.prompt, provider: json.provider, charged: approved.credits });
      return json.prompt;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The enhancer did not answer. Your prompt is unchanged.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [scoped, off]);

  const dismiss = useCallback(() => { setResult(null); setError(null); }, []);

  return {
    auto: auto && !off, setAuto, credits, blocked, busy, error,
    enhanced: result?.prompt ?? null, provider: result?.provider ?? null, charged: result?.charged ?? null,
    enhance: () => void enhance(), run: enhance, dismiss,
  };
}
