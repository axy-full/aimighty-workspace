"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONNECTED_GENERATION_ENDPOINT, connectedQuoteRequest, connectedRecoverable, connectedStatusRequest, connectedSubmitRequest, parseConnectedJob, type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";
import type { ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * One connected-account job from a Business composer (FINAL_SPEC §2), on the
 * existing catalogue-generation route: quote → the exact price on the
 * button → submit with that price → poll to completion. Nothing here prices
 * anything; a moved price refuses at the server and comes back as an error.
 *
 * A submitted job is remembered per project and composer (`slot`), so a
 * page switch or a reload picks its polling up again: the account bills it
 * either way, and Particl settles it only on a status read.
 */
export type ConnectedJobState =
  | { phase: "idle" }
  | { phase: "quoting" }
  | { phase: "quoted"; job: ConnectedJob }
  | { phase: "submitting"; job: ConnectedJob }
  | { phase: "running"; job: ConnectedJob }
  | { phase: "done"; job: ConnectedJob }
  | { phase: "failed"; job: ConnectedJob | null; error: string };

const POLL_MS = 4000;
/** A failed quote is read again after this long (the route allows six a minute), or at once from Price again. */
export const QUOTE_RETRY_MS = 30_000;
const FAILED = "The connected account reported this job as failed. Failed renders are not billed.";

export const connectedJobKey = (slot: string, draftId: string) => `particl:connected-job:${slot}:${draftId}`;
function recall(key: string | null): string | null {
  try { return key ? localStorage.getItem(key) : null; } catch { return null; }
}
function remember(key: string | null, id: string | null) {
  try { if (key) { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } } catch { /* the job still settles on the server; this page just cannot resume it */ }
}
/** Where a status read leaves the composer. */
export function settledState(job: ConnectedJob): ConnectedJobState {
  if (job.status === "completed") return { phase: "done", job };
  if (job.status === "failed") return { phase: "failed", job, error: FAILED };
  if (connectedRecoverable(job)) return { phase: "running", job };
  return { phase: "done", job };
}

/** A price never replaces a job in flight (one submitted, or one resumed after a page switch or a reload). */
export function quoteLands(now: ConnectedJobState, next: ConnectedJobState): ConnectedJobState {
  return now.phase === "submitting" || now.phase === "running" ? now : next;
}

export function useConnectedJob(draftId: string | null, slot = "business") {
  const scoped = useScopedFetch();
  const [state, setState] = useState<ConnectedJobState>({ phase: "idle" });
  const [quotedFor, setQuotedFor] = useState<string | null>(null);
  const live = useRef(state);
  useEffect(() => { live.current = state; });
  const key = draftId ? connectedJobKey(slot, draftId) : null;

  const call = useCallback(async (body: unknown) => {
    const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as { job?: unknown; error?: string; code?: string } | null;
    if (!response.ok || !json?.job) throw Object.assign(new Error(json?.error ?? "The connected account could not complete this request."), { status: response.status });
    return parseConnectedJob(json.job, draftId!);
  }, [scoped, draftId]);

  /* A job submitted from this composer before a page switch or a reload: read once, then polled below until it settles. */
  useEffect(() => {
    const id = recall(key);
    if (!id || !draftId) return;
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const job = await call(connectedStatusRequest(draftId, id));
        if (stop) return;
        if (job.status === "quoted") { remember(key, null); return; }
        if (!connectedRecoverable(job)) remember(key, null);
        setState(settledState(job));
      } catch (error) {
        if (stop) return;
        const status = Number((error as { status?: number }).status);
        /* A job the server does not know is forgotten; a missed read is tried again. */
        if (status === 400 || status === 404) remember(key, null);
        else timer = setTimeout(() => void read(), POLL_MS);
      }
    };
    timer = setTimeout(() => void read(), 0);
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [key, draftId, call]);

  /** A read-only quote for exactly this input; the key says which input it prices. A job resumed meanwhile keeps the composer. */
  const quote = useCallback(async (input: ConsumerGenerationInput, inputKey: string) => {
    if (!draftId) return;
    setState((now) => quoteLands(now, { phase: "quoting" }));
    try {
      const job = await call(connectedQuoteRequest(draftId, input));
      setState((now) => quoteLands(now, { phase: "quoted", job })); setQuotedFor(inputKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The price could not be read.";
      setState((now) => quoteLands(now, { phase: "failed", job: null, error: message })); setQuotedFor(inputKey);
    }
  }, [call, draftId]);

  /* A failed quote is not final: the same input is priced again after a while (or at once, from Price again). */
  useEffect(() => {
    if (state.phase !== "failed" || state.job) return;
    const timer = setTimeout(() => setQuotedFor(null), QUOTE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [state]);

  /* Poll a submitted job until the account settles it. */
  useEffect(() => {
    if (state.phase !== "running" || !draftId) return;
    let stop = false;
    const tick = async () => {
      try {
        const job = await call(connectedStatusRequest(draftId, state.job.id));
        if (stop) return;
        if (!connectedRecoverable(job)) remember(key, null);
        setState(settledState(job));
      } catch { /* a missed poll is retried on the next tick */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [state, call, draftId, key]);

  /** Approve exactly the quoted price and submit. The job is remembered first, so even a lost reply is resumed. */
  const submit = useCallback(async () => {
    const now = live.current;
    if (now.phase !== "quoted" || !draftId) return;
    setState({ phase: "submitting", job: now.job });
    remember(key, now.job.id);
    try {
      const job = await call(connectedSubmitRequest(draftId, now.job));
      if (!connectedRecoverable(job)) remember(key, null);
      setState(settledState(job));
    } catch (error) {
      const status = Number((error as { status?: number }).status);
      if (status >= 400 && status < 500) remember(key, null);
      setState({ phase: "failed", job: now.job, error: error instanceof Error ? error.message : "The job could not be submitted." });
    }
  }, [call, draftId, key]);

  /** Price the same input again: after a failed quote, a failed job, or a finished take (for another one). */
  const requote = useCallback(() => { setQuotedFor(null); setState({ phase: "idle" }); }, []);
  const reset = useCallback(() => { setState({ phase: "idle" }); setQuotedFor(null); }, []);
  return { state, quotedFor, quote, submit, requote, reset };
}
