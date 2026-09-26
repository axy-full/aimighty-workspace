"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONNECTED_GENERATION_ENDPOINT, connectedStatusRequest, parseConnectedJob, type ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import { canProgress, createResumeTracker, resumableJobs, resumeProblem, type ResumeTracker } from "@/lib/higgsfield-consumer/resume";
import { awaitingReconciliation } from "@/lib/higgsfield-consumer/job-state";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * A composer's connected-account jobs still open from an earlier visit (the
 * page was closed, reloaded or left mid-render). On opening a project the
 * saved jobs are listed once (GET on the existing generation route). Each one
 * this composer made that a read can still move is followed with the same
 * `status` read the composer uses, until it settles; the server collects the
 * original into the project's Takes, this only shows it happening. A job no
 * read can move is shown as it is, with Dismiss. Nothing is ever re-sent.
 */
export type ResumedJob = {
  job: ConnectedJob;
  problem: string | null;
  /** Still being asked after. False once no read can move it, or it cannot be checked from here. */
  following: boolean;
};

type Failure = Error & { code?: string; status?: number };
const failure = (message: string, code: string | undefined, status: number): Failure => Object.assign(new Error(message), { code, status });

/* Dismiss hides a row for this viewer only; nothing is deleted or set aside. */
const hiddenKey = (draftId: string) => `particl:resumed-hidden:${draftId}`;
function hidden(draftId: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(hiddenKey(draftId)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}
function hide(draftId: string, id: string) {
  try { localStorage.setItem(hiddenKey(draftId), JSON.stringify([...hidden(draftId), id].slice(-50))); } catch { /* shown again next visit */ }
}
/** What an open job no read can move asks of its owner, if anything. */
const unmovedNote = (job: ConnectedJob) => (awaitingReconciliation(job) ? "Free its slot in Workspace › Engines." : null);

export function useResumedConnectedJobs(options: {
  scope?: string;
  draftId: string | null;
  /** Which saved jobs belong to this composer. */
  accept: (job: ConnectedJob) => boolean;
  /** Jobs the composer itself is following: never listed or read here, so each job has one poller and one toast. */
  owned?: readonly (string | null | undefined)[];
  /** Keep a completed job on screen (its surface has no results grid to move it to). */
  keepCompleted?: boolean;
  /** A settled job: the caller toasts and re-reads the library. */
  onSettled?: (job: ConnectedJob) => void;
}) {
  const { scope, draftId, keepCompleted = false } = options;
  const scoped = useScopedFetch(scope);
  /* Keyed by project: switching projects shows none of the last one's jobs. */
  const [held, setHeld] = useState<{ draftId: string | null; jobs: ResumedJob[] }>({ draftId: null, jobs: [] });
  /* A job its composer picked up (or submitted) is the composer's alone from then on, even after the
     composer lets it go: kept as state, adjusted while rendering, so no effect has to set it. */
  const [released, setReleased] = useState<readonly string[]>([]);
  const claimed = (options.owned ?? []).filter((id): id is string => typeof id === "string" && id.length > 0 && !released.includes(id));
  if (claimed.length) setReleased([...released, ...claimed]);
  const releasedKey = released.join(",");
  const latest = useRef({ accept: options.accept, onSettled: options.onSettled, released });
  useEffect(() => { latest.current = { accept: options.accept, onSettled: options.onSettled, released }; });
  const tracker = useRef<ResumeTracker<ConnectedJob> | null>(null);

  useEffect(() => {
    if (!draftId) return;
    let live = true;
    const setJobs = (fn: (list: ResumedJob[]) => ResumedJob[]) =>
      setHeld((current) => ({ draftId, jobs: fn(current.draftId === draftId ? current.jobs : []) }));
    const patch = (id: string, fn: (item: ResumedJob) => ResumedJob) => setJobs((list) => list.map((item) => (item.job.id === id ? fn(item) : item)));
    const status = async (id: string) => {
      const response = await scoped(CONNECTED_GENERATION_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(connectedStatusRequest(draftId, id)),
      });
      const json = await response.json().catch(() => null) as { job?: unknown; pollAfterSeconds?: number; error?: string; code?: string } | null;
      if (!response.ok || !json?.job) throw failure(json?.error ?? "The account could not be reached.", json?.code, response.status);
      return { job: parseConnectedJob(json.job, draftId), pollAfterSeconds: json.pollAfterSeconds };
    };
    const follow = createResumeTracker<ConnectedJob>({
      status,
      onUpdate: (job) => { if (live) patch(job.id, (item) => ({ ...item, job, problem: null })); },
      onSettled: (job) => {
        if (!live) return;
        /* A failed job stays until dismissed; a completed one leaves unless its surface keeps it. */
        if (job.status === "completed" && !keepCompleted) setJobs((list) => list.filter((item) => item.job.id !== job.id));
        else patch(job.id, (item) => ({ ...item, following: false }));
        latest.current.onSettled?.(job);
      },
      onStalled: (id, error) => {
        if (!live) return;
        patch(id, (item) => ({ ...item, following: false, problem: error ? resumeProblem(error) : unmovedNote(item.job) }));
      },
      onProblem: (id, error) => { if (live) patch(id, (item) => ({ ...item, problem: resumeProblem(error) })); },
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
        const skip = hidden(draftId);
        const open = resumableJobs(jobs, (job) => !skip.has(job.id) && !latest.current.released.includes(job.id) && latest.current.accept(job));
        if (!open.length) return;
        setJobs(() => open.map((job) => {
          const following = canProgress(job);
          return { job, following, problem: following ? null : unmovedNote(job) };
        }));
        follow.track(open);
      } catch { /* nothing to resume here; the background sweep still collects it */ }
    })();
    return () => { live = false; follow.stop(); if (tracker.current === follow) tracker.current = null; };
  }, [draftId, scoped, keepCompleted]);

  /* Never read here again once its composer has it. */
  useEffect(() => {
    if (releasedKey) for (const id of releasedKey.split(",")) tracker.current?.forget(id);
  }, [releasedKey]);

  const dismiss = useCallback((id: string) => {
    tracker.current?.forget(id);
    if (draftId) hide(draftId, id);
    setHeld((current) => ({ ...current, jobs: current.jobs.filter((item) => item.job.id !== id) }));
  }, [draftId]);
  return { jobs: held.draftId === draftId ? held.jobs.filter((item) => !released.includes(item.job.id)) : [], dismiss };
}
