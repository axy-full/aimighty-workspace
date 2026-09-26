"use client";
import { useEffect, useRef } from "react";
import { connectedOriginal, type ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { ConnectedCollector, announceCollected, listConnectedJobs, setSharedCollector, showConnectedJob } from "./connected-collector";

/** A re-listing on focus is at most this often. */
const FOCUS_LIST_MS = 30_000;

/** What the toast says once a job the collector followed settles. */
export function settledToast(job: ConnectedJob): string {
  const name = job.model.name || "The connected render";
  if (job.status === "failed") return `${name} failed on the connected account. Failed renders are not billed.`;
  return connectedOriginal(job) ? `${name} rendered on the connected account. It is in Takes.` : `${name} finished on the connected account.`;
}

/**
 * Mounts the shell's collector (lib/shell/connected-collector.ts) for the
 * workspace owner — the only person the connected account answers. It lists
 * the open project's jobs when the project opens, whenever the page or view
 * changes (the moment a composer that was polling its own job unmounts), and
 * when the tab comes back; a finished job refreshes that project's library.
 * The job the shell's strip shows is a Generate composer's own: the collector
 * leaves it to that composer while it is in flight.
 */
export function useConnectedCollector(input: {
  scope: string | null; owner: boolean; projectId: string | null; place: string; toast: (text: string) => void;
  /** The shell strip's job (ws.state.gen): its id, and whether it has settled (green or red). */
  strip: { id: string; done: boolean } | null;
}) {
  const { scope, owner, projectId, place, toast, strip } = input;
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);
  useEffect(() => {
    if (!scope || !owner) return;
    const collector = new ConnectedCollector({
      fetch: (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("X-Workbench-Scope", scope);
        return fetch(url, { ...init, headers });
      },
      onSettled: (job) => {
        void refreshProjectLibrary(scope, job.draftId);
        toastRef.current(settledToast(job));
      },
      /* Gen's picked-up takes and the Business rows from earlier show what it has (lib/shell/use-resumed-jobs.ts). */
      onChange: announceCollected,
    });
    setSharedCollector(collector);
    return () => { collector.stop(); setSharedCollector(null); };
  }, [scope, owner]);

  const stripId = strip?.id ?? null, stripDone = strip?.done ?? false;
  useEffect(() => { showConnectedJob(stripId, stripDone); }, [scope, owner, stripId, stripDone]);

  /* The open project, and every time the page changes under it. */
  useEffect(() => {
    if (projectId) void listConnectedJobs(projectId);
  }, [scope, owner, projectId, place]);

  useEffect(() => {
    if (!projectId) return;
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < FOCUS_LIST_MS) return;
      last = Date.now();
      void listConnectedJobs(projectId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [projectId]);
}
