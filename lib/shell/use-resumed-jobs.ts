"use client";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import { awaitingReconciliation } from "@/lib/higgsfield-consumer/job-state";
import { isOpen } from "@/lib/higgsfield-consumer/resume";
import { collectedJobs, subscribeCollected, type CollectedJob } from "./connected-collector";

/**
 * A composer's connected-account jobs still open from an earlier visit (the
 * page was closed, reloaded or left mid-render), as the shell's collector
 * (lib/shell/connected-collector.ts) has them. The collector lists the open
 * project's saved jobs, reads each one that was sent until it settles —
 * whichever page is open — and announces it once; the server files the
 * original into the project's Takes. This hook only shows that for the jobs
 * this composer made: it fetches nothing, reads nothing and toasts nothing,
 * so each job has one reader and one toast. A job no read can move is shown
 * as it is, with Dismiss. Nothing is ever re-sent, and nothing here writes the
 * saved draft.
 */
export type ResumedJob = CollectedJob;

/* Dismiss hides a row for this viewer only; nothing is deleted or set aside. */
const hiddenKey = (draftId: string) => `particl:resumed-hidden:${draftId}`;
function hidden(draftId: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(hiddenKey(draftId)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
function hide(draftId: string, id: string) {
  try { localStorage.setItem(hiddenKey(draftId), JSON.stringify([...new Set([...hidden(draftId), id])].slice(-50))); } catch { /* shown again next visit */ }
}
/** What an open job no read can move asks of its owner, if anything. */
const unmovedNote = (job: ConnectedJob) => (awaitingReconciliation(job) ? "Free its slot in Workspace › Engines." : null);
const NONE: readonly CollectedJob[] = [];
const subscribe = (listener: () => void) => subscribeCollected(listener);

export function useResumedConnectedJobs(options: {
  draftId: string | null;
  /** Which saved jobs belong to this composer. */
  accept: (job: ConnectedJob) => boolean;
  /** Jobs the composer itself is following (running, or reading back): never listed here. */
  owned?: readonly (string | null | undefined)[];
  /** Keep a completed job on screen (its surface has no results grid to move it to). */
  keepCompleted?: boolean;
}) {
  const { draftId, accept, keepCompleted = false } = options;
  const collected = useSyncExternalStore(subscribe, () => (draftId ? collectedJobs(draftId) : NONE), () => NONE);
  /* A job its composer picked up (or submitted) is the composer's alone from then on, even after the
     composer lets it go: kept as state, adjusted while rendering, so no effect has to set it. */
  const [released, setReleased] = useState<readonly string[]>([]);
  const claimed = (options.owned ?? []).filter((id): id is string => typeof id === "string" && id.length > 0 && !released.includes(id));
  if (claimed.length) setReleased([...released, ...claimed]);
  /* What this viewer dismissed on this project, read when the project opens. */
  const [dismissed, setDismissed] = useState<{ draftId: string | null; ids: readonly string[] }>({ draftId: null, ids: [] });
  if (dismissed.draftId !== draftId) setDismissed({ draftId, ids: draftId ? hidden(draftId) : [] });

  const jobs = collected
    .filter(({ job }) => !released.includes(job.id) && !dismissed.ids.includes(job.id) && (keepCompleted || job.status !== "completed") && accept(job))
    .map((item) => (item.problem || item.following || !isOpen(item.job.status) ? item : { ...item, problem: unmovedNote(item.job) }))
    .sort((a, b) => b.job.createdAt - a.job.createdAt);

  const dismiss = useCallback((id: string) => {
    if (draftId) hide(draftId, id);
    setDismissed((current) => ({ draftId: current.draftId, ids: [...current.ids, id] }));
  }, [draftId]);
  return { jobs, dismiss };
}
