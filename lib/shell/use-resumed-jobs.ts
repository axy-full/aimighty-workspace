"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONNECTED_GENERATION_ENDPOINT, connectedStatusRequest, parseConnectedJob, type ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import { createResumeTracker, resumableJobs, resumeProblem, type ResumeTracker } from "@/lib/higgsfield-consumer/resume";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * A composer's connected-account jobs still in flight from an earlier visit
 * (the page was closed, reloaded or left mid-render). On opening a project the
 * saved jobs are listed once (GET on the existing generation route); each one
 * this composer made and still in flight is followed with the same `status`
 * read the composer uses, until it settles. The server collects the original
 * (and, for Gen takes, files it); this only shows it happening. Nothing is
 * ever re-sent.
 */
export type ResumedJob = { job: ConnectedJob; problem: string | null };

type Failure = Error & { code?: string };
const failure = (message: string, code?: string): Failure => Object.assign(new Error(message), { code });

export function useResumedConnectedJobs(options: {
  scope?: string;
  draftId: string | null;
  /** Which saved jobs belong to this composer. */
  accept: (job: ConnectedJob) => boolean;
  /** Keep a completed job on screen (its surface has no results grid to move it to). */
  keepCompleted?: boolean;
  /** A settled job: the caller toasts and re-reads the library. */
  onSettled?: (job: ConnectedJob) => void;
}) {
  const { scope, draftId, keepCompleted = false } = options;
  const scoped = useScopedFetch(scope);
  /* Keyed by project: switching projects shows none of the last one's jobs. */
  const [held, setHeld] = useState<{ draftId: string | null; jobs: ResumedJob[] }>({ draftId: null, jobs: [] });
  const latest = useRef({ accept: options.accept, onSettled: options.onSettled });
  useEffect(() => { latest.current = { accept: options.accept, onSettled: options.onSettled }; });
  const tracker = useRef<ResumeTracker<ConnectedJob> | null>(null);

  useEffect(() => {
    if (!draftId) return;
    let live = true;
    const setJobs = (fn: (list: ResumedJob[]) => ResumedJob[]) =>
      setHeld((current) => ({ draftId, jobs: fn(current.draftId === draftId ? current.jobs : []) }));
    const status = async (id: string) => {
      const response = await scoped(CONNECTED_GENERATION_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(connectedStatusRequest(draftId, id)),
      });
      const json = await response.json().catch(() => null) as { job?: unknown; pollAfterSeconds?: number; error?: string; code?: string } | null;
      if (!response.ok || !json?.job) throw failure(json?.error ?? "The account could not be reached.", json?.code);
      return { job: parseConnectedJob(json.job, draftId), pollAfterSeconds: json.pollAfterSeconds };
    };
    const follow = createResumeTracker<ConnectedJob>({
      status,
      onUpdate: (job) => { if (live) setJobs((list) => list.map((item) => (item.job.id === job.id ? { job, problem: null } : item))); },
      onSettled: (job) => {
        if (!live) return;
        /* A failed job stays until dismissed; a completed one leaves unless its surface keeps it. */
        if (job.status === "completed" && !keepCompleted) setJobs((list) => list.filter((item) => item.job.id !== job.id));
        latest.current.onSettled?.(job);
      },
      onProblem: (id, error) => {
        if (!live) return;
        const problem = resumeProblem((error as Failure).code, error instanceof Error ? error.message : null);
        setJobs((list) => list.map((item) => (item.job.id === id ? { ...item, problem } : item)));
      },
    });
    tracker.current = follow;
    void (async () => {
      try {
        /* Only the owner runs the connected account; nobody else has jobs to resume. */
        const me = await scoped("/api/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { owner?: boolean } | null;
        if (!live || me?.owner !== true) return;
        const response = await scoped(`${CONNECTED_GENERATION_ENDPOINT}?draftId=${encodeURIComponent(draftId)}`, { cache: "no-store" });
        const json = await response.json().catch(() => null) as { jobs?: unknown[] } | null;
        if (!live || !response.ok || !Array.isArray(json?.jobs)) return;
        const jobs = json.jobs.flatMap((value) => { try { return [parseConnectedJob(value, draftId)]; } catch { return []; } });
        const open = resumableJobs(jobs, (job) => latest.current.accept(job));
        if (!open.length) return;
        setJobs(() => open.map((job) => ({ job, problem: null })));
        follow.track(open);
      } catch { /* nothing to resume here; the background sweep still finishes it */ }
    })();
    return () => { live = false; follow.stop(); if (tracker.current === follow) tracker.current = null; };
  }, [draftId, scoped, keepCompleted]);

  const dismiss = useCallback((id: string) => {
    tracker.current?.forget(id);
    setHeld((current) => ({ ...current, jobs: current.jobs.filter((item) => item.job.id !== id) }));
  }, []);
  return { jobs: held.draftId === draftId ? held.jobs : [], dismiss };
}
