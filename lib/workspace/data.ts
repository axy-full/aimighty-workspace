"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { usePublishedProject } from "./spec-store";
import { knownCopy, rememberCopy } from "@/lib/shell/use-fresh-project";

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
/** A closed stage's edits save within the draft editor's debounce (700 ms) and one request; reads wait this long. */
const STAGE_SETTLE_MS = 2_500;
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
export function useProjects(scope: string, projectId: string | null, onResolved: (id: string) => void): ProjectsState & { refresh: () => void; retry: () => void } {
  const [data, setData] = useState<ProjectsState>({ status: "loading", projects: [], project: null, error: null });
  const loaded = useRef<{ scope: string; id: string } | null>(null);
  /* A retry, or a full re-resolve (after a failed first read), re-runs the effect below — even for the id already in the URL. */
  const [attempt, setAttempt] = useState(0);
  const answered = useRef(0);
  /* True while that read is out: a focus or an announcement then waits for it rather than restarting it. */
  const resolving = useRef(false);
  /* The saved revision of the copy on screen: a re-read that finds it unchanged in the list never downloads the project again. */
  const revision = useRef<number | null>(null);
  useEffect(() => {
    const retrying = attempt !== answered.current;
    answered.current = attempt;
    /* The id this hook just resolved coming back through the URL is not a new request. */
    if (!retrying && projectId && loaded.current?.scope === scope && loaded.current.id === projectId) return;
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
      return body as { projects?: ProjectSummary[]; project?: Project | null; revision?: number };
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
      revision.current = project && typeof body.revision === "number" ? body.revision : null;
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
  /* Until this moment a closed stage's last edits may still be saving: reads wait for it, and its copy stays on screen. */
  const settleUntil = useRef(0);
  /* The closed stage's last copy, shown until a read that began after its edits had time to save lands. */
  const [kept, setKept] = useState<Project | null>(null);
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
    const startedAt = Date.now();
    lastRead.current = startedAt;
    try {
      /* The list first (ids and revisions only): the project itself is read only when its revision moved. */
      const listed = await fetch("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
        .then(async (r) => (r.ok ? await r.json() as { projects?: ProjectSummary[] } : null)).catch(() => null);
      const row = Array.isArray(listed?.projects) ? listed.projects.find((p) => p.id === open.id) : undefined;
      if (row && typeof row.revision === "number" && row.revision === revision.current) {
        if (loaded.current?.id !== open.id) return;
        setData((prev) => ({ ...prev, projects: listed!.projects! }));
        if (startedAt >= settleUntil.current) setKept(null);
        return;
      }
      /* The phone grid's own check (lib/shell/use-fresh-project) may already hold this revision. */
      const known = knownCopy();
      if (row && typeof row.revision === "number" && known?.id === open.id && known.revision === row.revision) {
        if (loaded.current?.id !== open.id) return;
        revision.current = known.revision;
        serverCopies.add(known.project);
        setData({ status: "ready", projects: listed!.projects!, project: known.project, error: null });
        if (startedAt >= settleUntil.current) setKept(null);
        return;
      }
      const response = await fetch("/api/workbench/projects?id=" + encodeURIComponent(open.id), { headers: { "X-Workbench-Scope": scope }, cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { projects?: ProjectSummary[]; project?: Project | null; revision?: number };
      if (!response.ok || !body.project || loaded.current?.id !== open.id || body.project.id !== open.id) return;
      revision.current = typeof body.revision === "number" ? body.revision : null;
      serverCopies.add(body.project);
      rememberCopy(open.id, body.revision, body.project);
      setData((prev) => ({ status: "ready", projects: body.projects ?? prev.projects, project: body.project!, error: null }));
      if (startedAt >= settleUntil.current) setKept(null);
    } catch { /* The copy on screen stays; the next focus or change reads again. */ }
    finally { reading.current = false; }
  }, [scope]);

  /* One pending re-read at a time, never sooner than CHANGED_REREAD_MS after the last one, nor before a
     closed stage's edits have had time to save. */
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; at: number } | null>(null);
  const soon = useCallback(() => {
    const at = Math.max(Date.now(), lastRead.current + CHANGED_REREAD_MS, settleUntil.current);
    if (pending.current && pending.current.at >= at) return;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { at, timer: setTimeout(() => { pending.current = null; void reread(); }, at - Date.now()) };
  }, [reread]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current.timer); }, []);

  useEffect(() => {
    /* Announcements that come in a burst (a page change, then a plan finishing) read once, shortly after. */
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
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(PROJECT_CHANGED_EVENT, onChanged);
    };
  }, [soon]);

  /* A stage's live draft of this project wins while it is on screen (a copy this hook read, mirrored back,
     does not). When the stage closes, its last copy stays on screen — its edits save a moment later
     (the editor's debounce, then the request) — and the saved draft is read once they have had time to land. */
  const published = usePublishedProject();
  const live = published && data.project && published.id === data.project.id && !serverCopies.has(published) ? published : null;
  const [lastLive, setLastLive] = useState<Project | null>(null);
  if (live !== lastLive && (live || lastLive)) {
    setLastLive(live);
    setKept(live ? null : lastLive);
  }
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !live) {
      settleUntil.current = Date.now() + STAGE_SETTLE_MS;
      soon();
    }
    wasLive.current = Boolean(live);
  }, [live, soon]);

  const shown = live ?? (kept && kept.id === data.project?.id ? kept : null) ?? data.project;
  /* Retry after a failed read: a new attempt re-runs the read even for the id already in the URL. */
  const retry = useCallback(() => {
    setData((prev) => ({ ...prev, status: "loading", error: null }));
    setAttempt((n) => n + 1);
  }, []);
  return useMemo(() => ({ ...data, project: shown, refresh: () => void reread(), retry }), [data, shown, reread, retry]);
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
