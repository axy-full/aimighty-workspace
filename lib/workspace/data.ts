"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";

/* Client data hooks for the shell. They read the existing routes the
   workbench already uses — /api/workbench/projects and /api/me — and add
   nothing server-side. */

export type ProjectSummary = { id: string; name: string; revision?: number; updatedAt?: string };

export type WorkspaceAccount = {
  workspace: { id: string; name: string } | null;
  credits: { balance: number } | null;
};

export type ProjectsState = {
  status: "loading" | "ready" | "error";
  projects: ProjectSummary[];
  project: Project | null;
  error: string | null;
};

/**
 * The project list and the open project's draft. With no project named,
 * the workbench's remembered project for this scope opens, else the most
 * recently updated one; `onResolved` reports which id that was.
 */
export function useProjects(scope: string, projectId: string | null, onResolved: (id: string) => void): ProjectsState & { retry: () => void } {
  const [data, setData] = useState<ProjectsState>({ status: "loading", projects: [], project: null, error: null });
  const loaded = useRef<{ scope: string; id: string } | null>(null);
  /* Retry after a failed read: a new attempt re-runs the read even for the id already in the URL. */
  const [attempt, setAttempt] = useState(0);
  const answered = useRef(0);
  useEffect(() => {
    const retrying = attempt !== answered.current;
    answered.current = attempt;
    /* The id this hook just resolved coming back through the URL is not a new request. */
    if (!retrying && projectId && loaded.current?.scope === scope && loaded.current.id === projectId) return;
    const controller = new AbortController();
    const request = async (id: string | null) => {
      const response = await fetch("/api/workbench/projects" + (id ? "?id=" + encodeURIComponent(id) : ""), {
        headers: { "X-Workbench-Scope": scope },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Projects could not be loaded.");
      return body as { projects?: ProjectSummary[]; project?: Project | null };
    };
    (async () => {
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(scope); } catch { /* Storage may be disabled; fall back to the list. */ }
      const wanted = projectId ?? remembered;
      let body = await request(wanted);
      const projects = body.projects ?? [];
      let project = body.project ?? null;
      if (!project && projects.length && (!wanted || !projects.some((p) => p.id === wanted))) {
        body = await request(projects[0].id);
        project = body.project ?? null;
      }
      if (controller.signal.aborted) return;
      loaded.current = project ? { scope, id: project.id } : null;
      setData({ status: "ready", projects, project, error: null });
      if (project) onResolved(project.id);
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setData((prev) => ({ ...prev, status: "error", error: error instanceof Error ? error.message : "Projects could not be loaded." }));
    });
    return () => controller.abort();
    // onResolved is a navigation callback; re-fetching when its identity changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, projectId, attempt]);
  const retry = useCallback(() => {
    setData((prev) => ({ ...prev, status: "loading", error: null }));
    setAttempt((n) => n + 1);
  }, []);
  return useMemo(() => ({ ...data, retry }), [data, retry]);
}

/** Ask every mounted useAccount to read /api/me now — after a change it reports, such as a rename. */
export const ACCOUNT_REFRESH_EVENT = "particl-account-refresh";
export function requestAccountRefresh() {
  try { window.dispatchEvent(new Event(ACCOUNT_REFRESH_EVENT)); } catch { /* no window: nothing mounted to refresh */ }
}

/**
 * The workspace's live credit state, refreshed the same way the workbench's
 * account menu does it (components/workbench/WorkspaceMenu.tsx): on mount,
 * every 30 seconds and whenever the tab becomes visible, and at once on requestAccountRefresh().
 */
export function useAccount(initial: WorkspaceAccount | null): WorkspaceAccount | null {
  const [account, setAccount] = useState(initial);
  const workspaceId = initial?.workspace?.id;
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void fetch("/api/me", { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const data = await response.json();
          setAccount((prev) => nextAccount(prev, data));
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener(ACCOUNT_REFRESH_EVENT, refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener(ACCOUNT_REFRESH_EVENT, refresh);
    };
  }, [workspaceId]);
  return account;
}

/**
 * The account a refresh leaves behind.
 *
 * /api/me reads its credit state behind `creditState().catch(() => null)`, so
 * one failed billing read used to wipe a balance the header was already
 * showing — the refresh replaced the whole account, credits included, and the
 * figure disappeared until a later poll happened to succeed. A refresh that
 * brings no balance for the SAME workspace now keeps the last known one; a
 * different workspace starts clean, because one workspace's balance must never
 * be shown against another.
 */
export function nextAccount(prev: WorkspaceAccount | null, data: {
  workspace?: { id?: unknown; name?: unknown } | null;
  credits?: { balance?: unknown } | null;
}): WorkspaceAccount {
  const workspace = data.workspace && data.workspace.id != null
    ? { id: String(data.workspace.id), name: String(data.workspace.name ?? "") }
    : null;
  const fresh = data.credits && typeof data.credits.balance === "number" ? { balance: data.credits.balance } : null;
  const same = Boolean(workspace && prev?.workspace && workspace.id === prev.workspace.id);
  return { workspace, credits: fresh ?? (same ? prev?.credits ?? null : null) };
}

/** Uploads filed in the open project's draft: the Library's Media tab. */
export function projectUploads(project: Project | null) {
  return (project?.assets ?? []).filter((asset) => Boolean(asset.uploadId) && !asset.generationId);
}
