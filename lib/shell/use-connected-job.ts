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

export function useConnectedJob(draftId: string | null) {
  const scoped = useScopedFetch();
  const [state, setState] = useState<ConnectedJobState>({ phase: "idle" });
  const [quotedFor, setQuotedFor] = useState<string | null>(null);
  const live = useRef(state);
  useEffect(() => { live.current = state; });

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
        if (job.status === "completed") setState({ phase: "done", job });
        else if (job.status === "failed") setState({ phase: "failed", job, error: "The connected account reported this job as failed. Failed renders are not billed." });
        else if (connectedRecoverable(job)) setState({ phase: "running", job });
        else setState({ phase: "done", job });
      } catch { /* a missed poll is retried on the next tick */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [state, call, draftId]);

  /** Approve exactly the quoted price and submit. */
  const submit = useCallback(async () => {
    const now = live.current;
    if (now.phase !== "quoted" || !draftId) return;
    setState({ phase: "submitting", job: now.job });
    try {
      const job = await call(connectedSubmitRequest(draftId, now.job));
      setState(job.status === "completed" ? { phase: "done", job } : job.status === "failed" ? { phase: "failed", job, error: "The connected account reported this job as failed. Failed renders are not billed." } : { phase: "running", job });
    } catch (error) {
      setState({ phase: "failed", job: now.job, error: error instanceof Error ? error.message : "The job could not be submitted." });
    }
  }, [call, draftId]);

  const reset = useCallback(() => { setState({ phase: "idle" }); setQuotedFor(null); }, []);
  return { state, quotedFor, quote, submit, reset };
}
