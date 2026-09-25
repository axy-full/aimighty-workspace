"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONNECTED_GENERATION_ENDPOINT, connectedQuoteRequest, connectedRecoverable, connectedStatusRequest, connectedSubmitRequest, parseConnectedJob, type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";
import type { ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { refreshProjectLibrary } from "@/lib/workspace/library";

/**
 * One connected-account job from a Business composer (FINAL_SPEC §2), on the
 * existing catalogue-generation route: quote → the exact price on the
 * button → submit with that price → poll to completion. Nothing here prices
 * anything; a moved price refuses at the server and comes back as an error.
 * A finished job is filed to the project by the server; the project's Library
 * is re-read once so Takes and the Library show it without a reload, and the
 * job stays on hand (`finished`) while the composer prices its next run.
 * `done` means completed and filed — a job the account left unsent is a
 * failure that billed nothing, never a finished one.
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
const FAILED = "The connected account reported this job as failed. Failed renders are not billed.";
const NOT_SENT = "This job was not sent, so nothing was billed. Generate again.";
/** Where a job the account answered for leaves the composer. */
function settled(job: ConnectedJob): ConnectedJobState {
  if (job.status === "completed") return { phase: "done", job };
  if (job.status === "failed") return { phase: "failed", job, error: FAILED };
  if (connectedRecoverable(job)) return { phase: "running", job };
  return { phase: "failed", job, error: NOT_SENT };
}

export function useConnectedJob(draftId: string | null, scope?: string) {
  const scoped = useScopedFetch();
  const [state, setState] = useState<ConnectedJobState>({ phase: "idle" });
  const [quotedFor, setQuotedFor] = useState<string | null>(null);
  const [finished, setFinished] = useState<ConnectedJob | null>(null);
  const live = useRef(state);
  useEffect(() => { live.current = state; });
  const land = useCallback((next: ConnectedJobState) => {
    setState(next);
    if (next.phase === "done") setFinished(next.job);
  }, []);

  const call = useCallback(async (body: unknown) => {
    const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as { job?: unknown; error?: string; code?: string } | null;
    if (!response.ok || !json?.job) throw new Error(json?.error ?? "The connected account could not complete this request.");
    return parseConnectedJob(json.job, draftId!);
  }, [scoped, draftId]);

  /** A read-only quote for exactly this input; the key says which input it prices. */
  const quote = useCallback(async (input: ConsumerGenerationInput, key: string) => {
    if (!draftId) return;
    setState({ phase: "quoting" });
    try {
      const job = await call(connectedQuoteRequest(draftId, input));
      setState({ phase: "quoted", job }); setQuotedFor(key);
    } catch (error) {
      setState({ phase: "failed", job: null, error: error instanceof Error ? error.message : "The price could not be read." }); setQuotedFor(key);
    }
  }, [call, draftId]);

  /* Poll a submitted job until the account settles it. */
  useEffect(() => {
    if (state.phase !== "running" || !draftId) return;
    let stop = false;
    const tick = async () => {
      try {
        const job = await call(connectedStatusRequest(draftId, state.job.id));
        if (stop) return;
        land(settled(job));
      } catch { /* a missed poll is retried on the next tick */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [state, call, draftId, land]);

  /** Approve exactly the quoted price and submit. */
  const submit = useCallback(async () => {
    const now = live.current;
    if (now.phase !== "quoted" || !draftId) return;
    setState({ phase: "submitting", job: now.job });
    try {
      const job = await call(connectedSubmitRequest(draftId, now.job));
      land(settled(job));
    } catch (error) {
      setState({ phase: "failed", job: now.job, error: error instanceof Error ? error.message : "The job could not be submitted." });
    }
  }, [call, draftId, land]);

  /* Once per completed job: Takes and the Library sidebar read one shared store. */
  const refreshed = useRef<string | null>(null);
  const doneId = finished?.status === "completed" ? finished.id : null;
  useEffect(() => {
    if (!doneId || !draftId || !scope || refreshed.current === doneId) return;
    refreshed.current = doneId;
    void refreshProjectLibrary(scope, draftId);
  }, [doneId, draftId, scope]);

  const reset = useCallback(() => { setState({ phase: "idle" }); setQuotedFor(null); setFinished(null); }, []);
  return { state, quotedFor, finished, quote, submit, reset };
}
