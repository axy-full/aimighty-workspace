"use client";
import { useEffect, useRef } from "react";
import { AGENT_CHANGED } from "@/components/graphite/board/cards/plan/use-run";
import { APPROVALS_CHANGED } from "@/lib/control-room/approve";
import { useJobsTray } from "./use-jobs-tray";
import type { TrayJob } from "@/lib/jobsTray";

/** The ids of this project's takes the tray shows as complete (a job with no project of its own counts: it may be this one's). */
export function completeIn(jobs: readonly Pick<TrayJob, "id" | "stage" | "draftId">[], projectId: string): string[] {
  return jobs.filter((job) => job.stage === "complete" && (!job.draftId || job.draftId === projectId)).map((job) => job.id);
}

/** Which of `complete` the Library has not been read for: none until a baseline exists (the first read), then the ids not seen before. */
export function newlyComplete(complete: readonly string[], seen: ReadonlySet<string> | null): string[] {
  return seen ? complete.filter((id) => !seen.has(id)) : [];
}

/**
 * The project's Library follows the jobs tray. A take Atomik renders for a plan is made on the server, so nothing in this
 * tab put it in the Library: the board's Inspector said "No take yet" and the phone's Home offered no review row until
 * the page was opened again. The tray already knows when a job ends (its own paced poll, and a read soon after a plan
 * acts); when a take of this project newly completes, the Library is read once more. No timer of its own.
 *
 * The first read of the tray is the baseline: takes that were already complete when the page opened are in the Library
 * the shell read on opening.
 */
export function useLibraryFollowsJobs(projectId: string | null, refreshLibrary: () => Promise<void>): void {
  const tray = useJobsTray();
  const seen = useRef<{ project: string | null; ids: Set<string> } | null>(null);
  const refresh = useRef(refreshLibrary);
  useEffect(() => { refresh.current = refreshLibrary; });
  const trayRefresh = tray?.refresh;

  /* A plan was approved or a render was pressed, on the board (AGENT_CHANGED) or from Needs you (APPROVALS_CHANGED): read the tray now rather than on its next turn. */
  useEffect(() => {
    if (!trayRefresh) return;
    const soon = () => trayRefresh();
    window.addEventListener(AGENT_CHANGED, soon);
    window.addEventListener(APPROVALS_CHANGED, soon);
    return () => { window.removeEventListener(AGENT_CHANGED, soon); window.removeEventListener(APPROVALS_CHANGED, soon); };
  }, [trayRefresh]);

  const jobs = tray?.jobs;
  const ready = tray?.status === "ready";
  useEffect(() => {
    if (!ready || !jobs || !projectId) return;
    const complete = completeIn(jobs, projectId);
    if (!seen.current || seen.current.project !== projectId) { seen.current = { project: projectId, ids: new Set(complete) }; return; }
    const fresh = newlyComplete(complete, seen.current.ids);
    if (!fresh.length) return;
    for (const id of fresh) seen.current.ids.add(id);
    void refresh.current();
  }, [ready, jobs, projectId]);
}
