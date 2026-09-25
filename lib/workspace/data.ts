"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { usePublishedProject } from "./spec-store";

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

/** Something changed the saved project (a job filed a take, a plan wrote the draft): the shell re-reads its copy. */
export const PROJECT_CHANGED_EVENT = "particl:project-changed";
export function projectChanged(projectId?: string | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED_EVENT, { detail: { projectId: projectId ?? null } }));
}
/** Focus and visibility re-reads are at most this often; announced changes, this soon after the last read. */
const FOCUS_REREAD_MS = 10_000;
const CHANGED_REREAD_MS = 1_500;
/* Every copy of a project this hook read from the server. A page that only mirrors one of these back
   through spec-store is not a newer draft, so it never hides a later read. */
const serverCopies = new WeakSet<Project>();

/**
 * The project list and the open project's draft. With no project named,
 * the workbench's remembered project for this scope opens, else the most
 * recently updated one; `onResolved` reports which id that was.
 *
 * The draft is not a snapshot of the moment the project opened: while a
 * stage has it on screen, its live copy (spec-store) is the one returned;
 * when that stage closes, and when the tab comes back into focus or
 * `projectChanged` is announced, the saved draft is read again. So the phone
 * Studio grid, Up next and the Atomik plans count what the project holds now.
 */
export function useProjects(scope: string, projectId: string | null, onResolved: (id: string) => void): ProjectsState & { refresh: () => void } {
  const [data, setData] = useState<ProjectsState>({ status: "loading", projects: [], project: null, error: null });
  const loaded = useRef<{ scope: string; id: string } | null>(null);
  /* A full re-resolve (after a failed first read) re-runs the effect below. */
  const [attempt, setAttempt] = useState(0);
  /* True while that first read is out: a focus or an announcement then waits for it rather than restarting it. */
  const resolving = useRef(false);
  useEffect(() => {
    /* The id this hook just resolved coming back through the URL is not a new request. */
    if (projectId && loaded.current?.scope === scope && loaded.current.id === projectId) return;
    const controller = new AbortController();
    resolving.current = true;
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
      if (project) serverCopies.add(project);
      setData({ status: "ready", projects, project, error: null });
      if (project) onResolved(project.id);
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setData((prev) => ({ ...prev, status: "error", error: error instanceof Error ? error.message : "Projects could not be loaded." }));
    }).finally(() => { if (!controller.signal.aborted) resolving.current = false; });
    return () => controller.abort();
    // onResolved is a navigation callback; re-fetching when its identity changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, projectId, attempt]);

  /* A quiet re-read of the open project: the screen keeps what it has until the newer copy lands. */
  const reading = useRef(false);
  const lastRead = useRef(0);
  const reread = useCallback(async () => {
    const open = loaded.current;
    if (!open || open.scope !== scope) {
      /* Nothing open yet (a failed first read, an empty workspace): resolve again, unless that read is still out. */
      if (resolving.current) return;
      lastRead.current = Date.now();
      setAttempt((n) => n + 1);
      return;
    }
    if (reading.current) return;
    reading.current = true;
    lastRead.current = Date.now();
    try {
      const response = await fetch("/api/workbench/projects?id=" + encodeURIComponent(open.id), { headers: { "X-Workbench-Scope": scope }, cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { projects?: ProjectSummary[]; project?: Project | null };
      if (!response.ok || !body.project || loaded.current?.id !== open.id || body.project.id !== open.id) return;
      serverCopies.add(body.project);
      setData((prev) => ({ status: "ready", projects: body.projects ?? prev.projects, project: body.project!, error: null }));
    } catch { /* The copy on screen stays; the next focus or change reads again. */ }
    finally { reading.current = false; }
  }, [scope]);

  useEffect(() => {
    /* Announcements that come in a burst (a page change, then a plan finishing) read once, shortly after. */
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void reread(); }, Math.max(0, lastRead.current + CHANGED_REREAD_MS - Date.now()));
    };
    const onFocus = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastRead.current < FOCUS_REREAD_MS) return;
      soon();
    };
    const onChanged = (event: Event) => {
      const id = (event as CustomEvent<{ projectId: string | null }>).detail?.projectId ?? null;
      if (!id || id === loaded.current?.id) soon();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(PROJECT_CHANGED_EVENT, onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(PROJECT_CHANGED_EVENT, onChanged);
    };
  }, [reread]);

  /* A stage's live draft of this project wins while it is on screen (a copy this hook read, mirrored back,
     does not); when the stage closes, read what it saved. */
  const published = usePublishedProject();
  const live = published && data.project && published.id === data.project.id && !serverCopies.has(published) ? published : null;
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !live) void reread();
    wasLive.current = Boolean(live);
  }, [live, reread]);

  return useMemo(() => ({ ...data, project: live ?? data.project, refresh: () => void reread() }), [data, live, reread]);
}

/**
 * The workspace's live credit state, refreshed the same way the workbench's
 * account menu does it (components/workbench/WorkspaceMenu.tsx): on mount,
 * every 30 seconds and whenever the tab becomes visible.
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
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
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
