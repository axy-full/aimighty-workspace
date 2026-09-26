"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONNECTED_GENERATION_ENDPOINT, connectedFailureText, connectedQuoteRequest, connectedRecoverable, connectedStatusRequest, connectedSubmitRequest, parseConnectedJob, type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";
import type { ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { refreshProjectLibrary } from "@/lib/workspace/library";

/**
 * One connected-account job from a Business composer (FINAL_SPEC §2), on the
 * existing catalogue-generation route: quote → the exact price on the
 * button → submit with that price → poll to completion. Nothing here prices
 * anything; a moved price refuses at the server and comes back as an error.
 *
 * A submitted job is remembered per project and composer (`slot`), so a
 * page switch or a reload picks its polling up again: the account bills it
 * either way, and Particl settles it only on a status read. While that read
 * is out the composer is `resuming` and prices nothing, so no newer job can
 * be submitted underneath it; and an id is only ever cleared by its own job.
 *
 * A completed job is filed to the project by the server; the project's
 * Library is re-read once (`scope` is the workspace scope) so Takes and the
 * Library show it without a reload, and the job stays on hand (`finished`)
 * while the composer prices its next run.
 */
export type ConnectedJobState =
  | { phase: "idle" }
  | { phase: "resuming" }
  | { phase: "quoting" }
  | { phase: "quoted"; job: ConnectedJob }
  | { phase: "submitting"; job: ConnectedJob }
  | { phase: "running"; job: ConnectedJob }
  | { phase: "done"; job: ConnectedJob }
  | { phase: "failed"; job: ConnectedJob | null; error: string };

const POLL_MS = 4000;
/** A failed quote is read again after this long (the route allows six a minute), or at once from Price again. */
export const QUOTE_RETRY_MS = 30_000;
/** Missed resume reads before the composer is handed back (the id stays remembered); the waits between them back off from POLL_MS to a minute. */
export const RESUME_TRIES = 8;
const NOT_SENT = "The job did not reach the connected account, so nothing was billed.";
const UNCHECKED = "The last take could not be checked. It is checked again when this page next opens.";

export const connectedJobKey = (slot: string, draftId: string) => `particl:connected-job:${slot}:${draftId}`;
type JobStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function store(): JobStore | null {
  try { return localStorage; } catch { return null; }
}
function recall(key: string | null): string | null {
  try { return key ? store()?.getItem(key) ?? null : null; } catch { return null; }
}
function remember(key: string | null, id: string) {
  try { if (key) store()?.setItem(key, id); } catch { /* the job still settles on the server; this page just cannot resume it */ }
}
/** Forget a job only while it is still the remembered one: an older job settling never clears a newer submit. */
export function forgetJob(storage: JobStore | null, key: string | null, id: string) {
  try { if (storage && key && storage.getItem(key) === id) storage.removeItem(key); } catch { /* nothing to forget */ }
}

/** Where a status read leaves the composer. A job still `quoted` was never sent (a lost submit reply the account did not take). */
export function settledState(job: ConnectedJob): ConnectedJobState {
  if (job.status === "completed") return { phase: "done", job };
  /* The account's own reason when it gave one (lib/higgsfield-consumer/generation-client). */
  if (job.status === "failed") return { phase: "failed", job, error: connectedFailureText(job) };
  if (job.status === "quoted") return { phase: "failed", job, error: NOT_SENT };
  if (connectedRecoverable(job)) return { phase: "running", job };
  return { phase: "done", job };
}

/** Nothing is priced or submitted while a job is being resumed, submitted or rendered. */
export const composerBusy = (phase: ConnectedJobState["phase"]) => phase === "resuming" || phase === "submitting" || phase === "running";

/** A price never replaces a job in flight (one submitted, or one being resumed after a page switch or a reload). */
export function quoteLands(now: ConnectedJobState, next: ConnectedJobState): ConnectedJobState {
  return composerBusy(now.phase) ? now : next;
}

/** A resumed job lands only on the composer still waiting for it. */
export function resumeLands(now: ConnectedJobState, next: ConnectedJobState): ConnectedJobState {
  return now.phase === "resuming" ? next : now;
}

/**
 * After a missed resume read (`tries` so far): forget a job the server does
 * not know, stop where this person may not read it (the id is kept for its
 * owner), or wait this many ms and read again. A job is never forgotten for
 * an outage.
 */
export function resumeRetry(status: number, tries: number): "forget" | "stop" | number {
  if (status === 400 || status === 404) return "forget";
  if (status === 401 || status === 403 || tries >= RESUME_TRIES) return "stop";
  return Math.min(POLL_MS * 2 ** Math.max(0, tries - 1), 60_000);
}

/** A 4xx submit was refused before anything was sent; anything else (a 5xx, a lost reply) may have reached the account. */
export const submitRefused = (status: number) => status >= 400 && status < 500;

export function useConnectedJob(draftId: string | null, slot = "business", scope?: string) {
  const scoped = useScopedFetch();
  const [state, setState] = useState<ConnectedJobState>({ phase: "idle" });
  const [quotedFor, setQuotedFor] = useState<string | null>(null);
  /* The last completed job, however it settled (submit, poll or resume): kept beside the composer until reset. */
  const [finished, setFinished] = useState<ConnectedJob | null>(null);
  if (state.phase === "done" && state.job.status === "completed" && state.job !== finished) setFinished(state.job);
  const live = useRef(state);
  useEffect(() => { live.current = state; });
  /** The remembered job this composer is reading back, if any; cleared the moment anything else takes the composer. */
  const resuming = useRef<string | null>(null);
  const key = draftId ? connectedJobKey(slot, draftId) : null;

  const call = useCallback(async (body: unknown) => {
    const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as { job?: unknown; error?: string; code?: string } | null;
    if (!response.ok || !json?.job) throw Object.assign(new Error(json?.error ?? "The connected account could not complete this request."), { status: response.status });
    return parseConnectedJob(json.job, draftId!);
  }, [scoped, draftId]);

  /* A job submitted from this composer before a page switch or a reload: read back (the composer prices
     nothing meanwhile), then polled below until it settles. */
  useEffect(() => {
    const id = recall(key);
    if (!id || !draftId) return;
    let stop = false, tries = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const mine = () => !stop && resuming.current === id;
    const release = (error: string | null) => {
      resuming.current = null;
      setState((now) => (now.phase === "resuming" ? (error ? { phase: "failed", job: null, error } : { phase: "idle" }) : now));
      setQuotedFor(null);
    };
    const read = async () => {
      try {
        const job = await call(connectedStatusRequest(draftId, id));
        if (!mine()) return;
        if (job.status === "quoted") { forgetJob(store(), key, id); release(null); return; }
        resuming.current = null;
        if (!connectedRecoverable(job)) forgetJob(store(), key, id);
        setState((now) => resumeLands(now, settledState(job)));
      } catch (error) {
        if (!mine()) return;
        const next = resumeRetry(Number((error as { status?: number }).status), ++tries);
        if (next === "forget") { forgetJob(store(), key, id); release(null); }
        else if (next === "stop") release(UNCHECKED);
        else timer = setTimeout(() => void read(), next);
      }
    };
    timer = setTimeout(() => {
      resuming.current = id;
      setState((now) => (composerBusy(now.phase) ? now : { phase: "resuming" }));
      void read();
    }, 0);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      if (resuming.current === id) { resuming.current = null; setState((now) => (now.phase === "resuming" ? { phase: "idle" } : now)); }
    };
  }, [key, draftId, call]);

  /** A read-only quote for exactly this input; the key says which input it prices. Nothing is priced while a job is in flight. */
  const quote = useCallback(async (input: ConsumerGenerationInput, inputKey: string) => {
    if (!draftId || composerBusy(live.current.phase)) return;
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
    const id = state.job.id;
    let stop = false;
    const tick = async () => {
      try {
        const job = await call(connectedStatusRequest(draftId, id));
        if (stop) return;
        if (!connectedRecoverable(job)) forgetJob(store(), key, id);
        setState((now) => (now.phase === "running" && now.job.id === id ? settledState(job) : now));
      } catch { /* a missed poll is retried on the next tick */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [state, call, draftId, key]);

  /** Approve exactly the quoted price and submit. The job is remembered first, so even a lost reply is resumed. */
  const submit = useCallback(async () => {
    const now = live.current;
    if (now.phase !== "quoted" || !draftId) return;
    const id = now.job.id;
    resuming.current = null;
    setState({ phase: "submitting", job: now.job });
    remember(key, id);
    const mine = (s: ConnectedJobState) => s.phase === "submitting" && s.job.id === id;
    try {
      const job = await call(connectedSubmitRequest(draftId, now.job));
      if (!connectedRecoverable(job)) forgetJob(store(), key, id);
      setState((s) => (mine(s) ? settledState(job) : s));
    } catch (error) {
      const status = Number((error as { status?: number }).status);
      if (submitRefused(status)) {
        forgetJob(store(), key, id);
        setState((s) => (mine(s) ? { phase: "failed", job: now.job, error: error instanceof Error ? error.message : "The job could not be submitted." } : s));
      } else {
        /* The reply was lost, not the job: the account may have taken it. The status read decides — never a second submit. */
        setState((s) => (mine(s) ? { phase: "running", job: now.job } : s));
      }
    }
  }, [call, draftId, key]);

  /* Once per completed job: Takes and the Library sidebar read one shared store. */
  const refreshed = useRef<string | null>(null);
  const doneId = finished?.id ?? null;
  useEffect(() => {
    if (!doneId || !draftId || !scope || refreshed.current === doneId) return;
    refreshed.current = doneId;
    void refreshProjectLibrary(scope, draftId);
  }, [doneId, draftId, scope]);

  /** Price the same input again: after a failed quote, a failed job, or a finished take (for another one; the finished take stays on hand). */
  const requote = useCallback(() => { setQuotedFor(null); setState({ phase: "idle" }); }, []);
  const reset = useCallback(() => { setState({ phase: "idle" }); setQuotedFor(null); setFinished(null); }, []);
  return { state, quotedFor, finished, quote, submit, requote, reset };
}
