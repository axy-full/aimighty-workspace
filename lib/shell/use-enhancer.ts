"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";
import { ENHANCE_CLIENT_MS, ENHANCE_FAILED, EnhanceRuns } from "./enhance-press";
import { isRawPrompt, type EnhanceMode, type EnhancerProvider } from "./enhancer";

/**
 * The Enhance button's life (README › Prompt enhancer), against
 * POST /api/prompt/enhance. The button always wears the live price: a quote
 * is read (free, read-only) once the words settle, pressing the button
 * approves exactly that figure, and the run carries it back as `maxCredits`
 * so a price that moved refuses instead of charging more. Nothing here knows
 * a price of its own.
 *
 * Enhance runs only when a person presses it: nothing here is ever started by a Make press, and nothing waits on it.
 * The rewrite streams back word by word (`onWords`); the first words are waited for ENHANCE_CLIENT_MS at most, and a
 * press can be stopped (`cancel`) until it is done. A run that fails says ENHANCE_FAILED; the screen restores the typed words.
 */
export type EnhancerInput = {
  prompt: string; mode: EnhanceMode; model: string | null; anchored: boolean; editing: boolean;
  /** The sample's line in the sample workspace: Enhance is off there (nothing quoted, nothing sent, Auto stays off). */
  off?: string | null;
};

export type EnhancerHost = {
  /** The quoted price, or null while it is unknown. */
  credits: number | null;
  /** The house workspace alone (which pays in dollars at cost): the same quote in the text model's own dollars, an estimate the real cost cannot pass. Null for everyone else, and while unknown. */
  usd: number | null;
  /** Why Enhance cannot run right now, said on the control. */
  blocked: string | null;
  /** The enhancer was asked for a price and could not give one (not "still pricing"): why. */
  unavailable: string | null;
  busy: boolean;
  /** Where a press is: waiting for the first words, or receiving them. */
  phase: "idle" | "waiting" | "streaming";
  /** Stops a press that is on its way: nothing is charged, and `run` answers null with no error. */
  cancel: () => void;
  enhanced: string | null;
  provider: EnhancerProvider | null;
  /** What the last enhancement was approved at. */
  charged: number | null;
  error: string | null;
  enhance: () => void;
  /** The same press, awaited: the enhanced words, or null when nothing came back (the error is then on `error`; none when cancelled). `onWords` is told the rewrite so far. */
  run: (onWords?: (soFar: string) => void) => Promise<string | null>;
  dismiss: () => void;
};

const QUOTE_DELAY_MS = 600;
const bodyOf = (input: EnhancerInput) => ({ prompt: input.prompt.trim(), mode: input.mode, ...(input.model ? { model: input.model } : {}), anchored: input.anchored, editing: input.editing });

export function useEnhancer(input: EnhancerInput): EnhancerHost {
  const scoped = useScopedFetch();
  const [quote, setQuote] = useState<{ key: string; credits: number | null; usd: number | null; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"waiting" | "streaming" | null>(null);
  const [result, setResult] = useState<{ prompt: string; provider: EnhancerProvider; charged: number | null; body: string } | null>(null);
  /* A failure is the line for the words it was pressed on: new words are a new press, with no stale complaint. */
  const [failure, setFailure] = useState<{ body: string; line: string } | null>(null);

  /* The house workspace pays in dollars at cost: its enhancement is priced in the text model's own dollars, and a quote without them is no quote. */
  const inDollars = useSession().rates.unit === "usd";
  const words = input.prompt.trim();
  const raw = isRawPrompt(input.prompt);
  const key = JSON.stringify(bodyOf(input));
  const off = input.off ?? null;
  const quotable = Boolean(words) && !raw && !off && !busy;

  /* The quote follows the words, debounced; a stale answer is dropped by key. A quote that was not answered in time (or never arrived) is asked once more:
     the button is dead until it has a price, and a slow first answer should not leave it so. */
  useEffect(() => {
    if (!quotable) return;
    let live = true;
    let attempt: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const ask = async (again: boolean) => {
      const patience = (attempt = new AbortController());
      const giveUp = setTimeout(() => patience.abort(), ENHANCE_CLIENT_MS);
      try {
        const response = await scoped("/api/prompt/enhance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(key), quoteOnly: true }), signal: patience.signal });
        const json = await response.json().catch(() => null) as { estimateCredits?: number; estimateUsd?: number; error?: string } | null;
        if (!live) return;
        const usd = typeof json?.estimateUsd === "number" && Number.isFinite(json.estimateUsd) && json.estimateUsd >= 0 ? json.estimateUsd : null;
        setQuote(response.ok && typeof json?.estimateCredits === "number" && (!inDollars || usd != null)
          ? { key, credits: json.estimateCredits, usd: inDollars ? usd : null, reason: null }
          : { key, credits: null, usd: null, reason: json?.error ?? "The enhancer cannot be priced right now." });
      } catch (caught) {
        if (!live) return;
        if (again) { retry = setTimeout(() => void ask(false), 1_000); return; }
        setQuote({ key, credits: null, usd: null, reason: patience.signal.aborted ? "The enhancer cannot be priced right now." : caught instanceof Error ? caught.message : "The enhancer cannot be priced right now." });
      } finally {
        clearTimeout(giveUp);
      }
    };
    const timer = setTimeout(() => void ask(true), QUOTE_DELAY_MS);
    return () => { live = false; clearTimeout(timer); if (retry) clearTimeout(retry); attempt?.abort(); };
  }, [key, quotable, scoped, inDollars]);

  const current = quote && quote.key === key ? quote : null;
  const credits = quotable ? current?.credits ?? null : null;
  const usd = quotable ? current?.usd ?? null : null;
  const blocked = off ? off
    : !words ? "Write a few words first."
    : raw ? "raw: is sent as written."
    : current?.reason ? current.reason
    : credits == null ? "Pricing…"
    : null;

  /* The press is sent under a key held for this exact press (lib/shell/enhance-press.ts):
     pressed again after a lost reply, it collects the saved answer instead of paying twice. */
  const session = useSession();
  const scope = session.signedIn ? session.requestScope ?? null : null;
  const live = useRef({ key, credits, scope });
  /* While a press is on its way the box fills with its words: the press is still for the words it was made from. */
  const pressing = useRef<{ scope: string | null; body: string } | null>(null);
  useEffect(() => { live.current = pressing.current ? { key: pressing.current.body, credits, scope: pressing.current.scope } : { key, credits, scope }; });

  /* A press while the same press is on its way shares its answer; a press for other words is its own, and an
     answer that arrives after the words were replaced is dropped (EnhanceRuns), never applied over them. */
  const runs = useRef<EnhanceRuns | null>(null);
  const wish = useRef<AbortController | null>(null);
  const cancel = useCallback(() => wish.current?.abort(), []);
  const enhance = useCallback(async (onWords?: (soFar: string) => void): Promise<string | null> => {
    const approved = live.current;
    if (approved.credits == null || off || pressing.current) return null;
    const credits = approved.credits;
    const presses = (runs.current ??= new EnhanceRuns());
    pressing.current = { scope: approved.scope, body: approved.key };
    const controller = (wish.current = new AbortController());
    setBusy(true);
    setPhase("waiting");
    setFailure(null);
    try {
      presses.attach({ signal: controller.signal, onWords: (soFar) => { setPhase("streaming"); onWords?.(soFar); } });
      const pressed = await presses.run(scoped, { scope: approved.scope, body: approved.key, credits }, () => ({ scope: live.current.scope, body: live.current.key }));
      if ("stale" in pressed) return null;
      if (!pressed.ok) { if (!pressed.cancelled) setFailure({ body: approved.key, line: pressed.error }); return null; }
      setResult({ prompt: pressed.prompt, provider: pressed.provider, charged: credits, body: approved.key });
      return pressed.prompt;
    } catch {
      setFailure({ body: approved.key, line: ENHANCE_FAILED });
      return null;
    } finally {
      presses.attach({});
      pressing.current = null;
      wish.current = null;
      setPhase(null);
      setBusy(presses.busy);
    }
  }, [scoped, off]);

  const dismiss = useCallback(() => { setResult(null); setFailure(null); }, []);
  /* An enhancement is offered only for the words it was written from: replaced words never take it. */
  const shown = result && result.body === key ? result : null;

  return {
    credits, usd, blocked, unavailable: quotable ? current?.reason ?? null : null, busy, error: failure && failure.body === key ? failure.line : null,
    enhanced: shown?.prompt ?? null, provider: shown?.provider ?? null, charged: shown?.charged ?? null,
    phase: phase ?? "idle", cancel, enhance: () => void enhance(), run: enhance, dismiss,
  };
}
