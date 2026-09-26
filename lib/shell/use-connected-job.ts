"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONNECTED_GENERATION_ENDPOINT, CONNECTED_PREFLIGHT_CODES, connectedQuoteRequest, connectedRecoverable, connectedStatusRequest, connectedSubmitRequest, parseConnectedJob, type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";
import type { ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { autoRetryMs, quoteUsableUntil } from "./business";
import { releaseConnectedJob, watchConnectedJob } from "./connected-collector";

/**
 * One connected-account job from a Business composer (FINAL_SPEC §2), on the
 * existing catalogue-generation route: quote → the exact price on the
 * button → submit with that price → poll to completion. Nothing here prices
 * anything; a moved price refuses at the server and comes back as an error.
 *
 * The price on the button is always for what is on screen: `submit(key)`
 * refuses a quote taken for another composition, and a quote too close to
 * expiry is taken again when the user comes back to the page or presses
 * Generate — never on a timer while the page sits idle (every quote is a call
 * to the account and imports the references again). A failed quote is asked
 * again on its own only when the failure passes by itself, a few times; any
 * other failure waits for Try again. A finished take re-arms Generate with
 * one fresh quote. Leaving mid-render hands the job to the shell's collector,
 * which keeps reading it until it lands in Takes.
 */
export type ConnectedJobState =
  | { phase: "idle" }
  | { phase: "quoting" }
  | { phase: "quoted"; job: ConnectedJob }
  | { phase: "submitting"; job: ConnectedJob }
  | { phase: "running"; job: ConnectedJob }
  | { phase: "done"; job: ConnectedJob }
  | {
    phase: "failed"; job: ConnectedJob | null; error: string;
    /** The submit may have reached the account: this composition is not re-armed on its own. */ uncertain?: true;
    /** A failed quote that passes on its own is asked again after this long; without it, only Try again asks. */ retryInMs?: number;
  };

const POLL_MS = 4000;
/** How long a finished take or a refused submit stays on screen before a fresh quote re-arms Generate. */
export const SETTLED_HOLD_MS = 5000;
const FAILED_COPY = "The connected account reported this job as failed. Failed renders are not billed.";

class ConnectedCallError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status: number) { super(message); }
}
/** What a failed call says about itself: its HTTP status (null when the network failed) and the account's code. */
const failureOf = (error: unknown): { status: number | null; code?: string } =>
  error instanceof ConnectedCallError ? { status: error.status, code: error.code } : error instanceof TypeError ? { status: null } : { status: 0 };

export function useConnectedJob(draftId: string | null) {
  const scoped = useScopedFetch();
  const [state, setRaw] = useState<ConnectedJobState>({ phase: "idle" });
  const [quotedFor, setQuotedRaw] = useState<string | null>(null);
  /* The last take that landed: its note stays on screen while a fresh quote re-arms Generate, until the next submit. */
  const [landed, setLanded] = useState<ConnectedJob | null>(null);
  /* Written with the state, so a submit and an unmount always see the newest phase and quote key. */
  const live = useRef(state);
  const quotedRef = useRef(quotedFor);
  const setState = useCallback((next: ConnectedJobState) => {
    live.current = next;
    setRaw(next);
    if (next.phase === "done") setLanded(next.job);
    else if (next.phase === "submitting" || next.phase === "idle") setLanded(null);
  }, []);
  const setQuotedFor = useCallback((key: string | null) => { quotedRef.current = key; setQuotedRaw(key); }, []);
  /* Failed quotes in a row for one composition, and when the current quote stops being usable (this device's clock). */
  const quoteFailures = useRef(0);
  const failedKey = useRef<string | null>(null);
  const usableUntil = useRef(0);

  const call = useCallback(async (body: unknown) => {
    const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as { job?: unknown; error?: string; code?: string } | null;
    if (!response.ok || !json?.job) throw new ConnectedCallError(json?.error ?? "The connected account could not complete this request.", json?.code, response.status);
    return parseConnectedJob(json.job, draftId!);
  }, [scoped, draftId]);

  /** A read-only quote for exactly this input; the key says which input it prices. */
  const quote = useCallback(async (input: ConsumerGenerationInput, key: string) => {
    if (!draftId) return;
    setState({ phase: "quoting" });
    if (key !== failedKey.current) quoteFailures.current = 0;
    try {
      const job = await call(connectedQuoteRequest(draftId, input));
      quoteFailures.current = 0; failedKey.current = null;
      usableUntil.current = quoteUsableUntil(job, Date.now());
      setState({ phase: "quoted", job }); setQuotedFor(key);
    } catch (error) {
      quoteFailures.current += 1; failedKey.current = key;
      const retryInMs = autoRetryMs(failureOf(error), quoteFailures.current);
      setState({ phase: "failed", job: null, error: error instanceof Error ? error.message : "The price could not be read.", ...(retryInMs === null ? {} : { retryInMs }) });
      setQuotedFor(key);
    }
  }, [call, draftId, setState, setQuotedFor]);

  /* The view re-quotes whenever quotedFor no longer names what is on screen. A failed quote that passes on its
     own is asked again after its wait; a refused submit or a finished take re-arms once, a moment later. */
  const phase = state.phase;
  const settledJob = state.phase === "failed" || state.phase === "done" ? state.job : null;
  const uncertain = state.phase === "failed" && state.uncertain === true;
  const retryInMs = state.phase === "failed" ? state.retryInMs : undefined;
  useEffect(() => {
    if ((phase !== "failed" && phase !== "done") || uncertain) return;
    const wait = phase === "failed" && !settledJob ? retryInMs : SETTLED_HOLD_MS;
    if (wait === undefined) return;
    const timer = setTimeout(() => setQuotedFor(null), wait);
    return () => clearTimeout(timer);
  }, [phase, settledJob, uncertain, retryInMs, setQuotedFor]);

  /* A quote too close to expiry is taken again when the user comes back to the page (and on Generate, in submit);
     an idle or hidden page asks the account nothing. */
  useEffect(() => {
    if (phase !== "quoted") return;
    const back = () => {
      if (document.visibilityState === "visible" && live.current.phase === "quoted" && Date.now() >= usableUntil.current) setQuotedFor(null);
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [phase, setQuotedFor]);

  /* Poll a submitted job until the account settles it. */
  useEffect(() => {
    if (state.phase !== "running" || !draftId) return;
    let stop = false;
    const tick = async () => {
      try {
        const job = await call(connectedStatusRequest(draftId, state.job.id));
        if (stop) return;
        if (job.status === "completed") setState({ phase: "done", job });
        else if (job.status === "failed") setState({ phase: "failed", job, error: FAILED_COPY });
        else if (connectedRecoverable(job)) setState({ phase: "running", job });
        else setState({ phase: "done", job });
      } catch { /* a missed poll is retried on the next tick */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [state, call, draftId, setState]);

  /* While this view polls its job the shell's collector leaves it be; unmounting mid-render hands it over. */
  const runningJob = state.phase === "running" || state.phase === "submitting" ? state.job : null;
  const runningId = runningJob?.id ?? null;
  useEffect(() => {
    if (!runningId || !draftId) return;
    watchConnectedJob(runningId);
    return () => {
      /* Settled here (done, failed): only unwatched. Still in flight (unmounting mid-render): followed by the collector. */
      const now = live.current;
      const job = now.phase !== "idle" && now.phase !== "quoting" && now.job?.id === runningId ? now.job : null;
      releaseConnectedJob(draftId, now.phase === "submitting" || !job ? { id: runningId, status: "dispatching" } : job);
    };
  }, [runningId, draftId]);

  /** Approve exactly the quoted price and submit — only if that price is for `key`, what is on screen now. */
  const submit = useCallback(async (key?: string) => {
    const now = live.current;
    if (now.phase !== "quoted" || !draftId) return;
    if (key !== undefined && quotedRef.current !== key) return;
    /* Too close to expiry: price it again; the user approves the fresh price with the next press. */
    if (Date.now() >= usableUntil.current) { setQuotedFor(null); return; }
    setState({ phase: "submitting", job: now.job });
    try {
      const job = await call(connectedSubmitRequest(draftId, now.job));
      setState(job.status === "completed" ? { phase: "done", job } : job.status === "failed" ? { phase: "failed", job, error: FAILED_COPY } : { phase: "running", job });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The job could not be submitted.";
      /* Refused before it reached the account: nothing ran, and a fresh quote follows. */
      if (error instanceof ConnectedCallError && error.code && CONNECTED_PREFLIGHT_CODES.has(error.code)) {
        setState({ phase: "failed", job: now.job, error: message });
        return;
      }
      /* It may have reached the account: read the saved job rather than guess (never re-send it). */
      try {
        const job = await call(connectedStatusRequest(draftId, now.job.id));
        if (connectedRecoverable(job)) setState({ phase: "running", job });
        else if (job.status === "completed") setState({ phase: "done", job });
        else setState({ phase: "failed", job, error: job.status === "failed" ? FAILED_COPY : message });
      } catch {
        /* Unknown either way: the job stays with the collector, and this composition is not re-armed. */
        setState({ phase: "failed", job: null, error: `${message} Check Takes before generating again.`, uncertain: true });
        releaseConnectedJob(draftId, { id: now.job.id, status: "uncertain" });
      }
    }
  }, [call, draftId, setState, setQuotedFor]);

  const reset = useCallback(() => { setState({ phase: "idle" }); setQuotedFor(null); }, [setState, setQuotedFor]);
  /** Try again after a failure nothing re-arms on its own: the view prices what is on screen afresh. */
  const retry = useCallback(() => { quoteFailures.current = 0; setQuotedFor(null); }, [setQuotedFor]);
  const canRetry = state.phase === "failed" && (state.uncertain === true || (state.job === null && state.retryInMs === undefined));
  return { state, quotedFor, landed, quote, submit, reset, retry, canRetry };
}
