"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectHold } from "@/lib/workspace/data";
import { linkWorkspace, stillCurrent, type AssetLink } from "./asset-link";
import { useShell } from "./state";

/**
 * A link to a take, from the moment the page opens until the take is on
 * screen (idea 26; the link itself: lib/shell/asset-link.ts). While it is
 * being checked, project resolution is held (lib/workspace/data.ts ›
 * useProjects `hold`): nothing opens in its place — not the remembered project,
 * not the newest one — and nothing about the take is shown until it resolves
 * in a project this person may open.
 *
 * - Another workspace's link resolves nothing here. One of this account's
 *   other workspaces is offered as a switch; any other says it does not open.
 * - A link names a production: this person's OWN newest draft of it opens
 *   (GET /api/workbench/projects?production=). With none, opening the
 *   production is offered — the existing explicit open, which copies only its
 *   published shared context into a new draft of theirs. Nothing is created,
 *   and no one else's draft is read, while the link loads.
 * - An address-bar URL names a draft: only this person's own opens.
 * Once the project is open the take is selected again (opening a project
 * clears the selection), and the link's own params leave the address bar.
 *
 * Two hooks, because project resolution sits between them: useAssetLink says
 * how resolution is held (before useProjects), useLinkView says what the link
 * shows and lands it once the project has resolved (after).
 */
export type LinkView =
  | { phase: "none" }
  /* `error`: the check itself could not be made (the connection, a refused read); Try again asks again. */
  | { phase: "checking"; error?: string | null }
  | { phase: "workspace"; switchTo: { id: string; name: string } | null; busy: boolean; error: string | null }
  | { phase: "no-draft"; name: string | null; busy: boolean; error: string | null }
  | { phase: "unavailable"; why: "broken" | "project" | "production" };

type Resolved = { production: string; draft: string | null; name: string | null };
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Acting = { busy: boolean; error: string | null };

export type LinkControl = {
  link: AssetLink | null;
  hold: ProjectHold;
  where: "here" | "switch" | "elsewhere";
  /** The link's production, when it names one and may open here. */
  production: string | null;
  resolved: Resolved | null;
  /** The draft the link opens: a string once known, undefined while a production is being looked up, null when there is none. */
  target: string | null | undefined;
  switchTo: { id: string; name: string } | null;
  acting: Acting;
  checkError: string | null;
  dismiss: () => void;
  retry: () => void;
  openProduction: () => Promise<void>;
  switchWorkspace: () => Promise<void>;
};

const failure = async (response: Response, fallback: string) =>
  ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? fallback;

export function useAssetLink(input: {
  scope: string;
  /** The session's workspace and the workspaces this account belongs to. */
  workspace: { id: string } | null | undefined;
  workspaces: readonly { id: string; name: string }[] | null | undefined;
  /** The Workspace state's project id. */
  projectId: string | null;
  selectProject: (id: string, opts?: { replace?: boolean }) => void;
  /** A fetch that carries the page's workspace scope (lib/useScopedFetch). */
  fetch: Fetch;
}): LinkControl {
  const { scope, workspace, workspaces, projectId, selectProject, fetch } = input;
  const { link, live } = useShell();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [acting, setActing] = useState<Acting>({ busy: false, error: null });
  const [checkError, setCheckError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /* A late answer for a link that has since resolved or been dismissed (or another scope) is dropped. */
  const current = useRef<{ link: AssetLink | null; scope: string }>({ link, scope });
  useEffect(() => { current.current = { link, scope }; }, [link, scope]);
  const same = useCallback((asked: AssetLink) => current.current.link === asked && stillCurrent({ scope, projectId: null }, { scope: current.current.scope, projectId: null }), [scope]);

  const where = link ? linkWorkspace(link, workspace?.id ?? null, workspaces ?? []) : "here";
  const production = link && !link.broken && where === "here" ? link.production : null;

  /* A production: this person's own newest draft of it, and its name for the card if the workspace lists it. */
  useEffect(() => {
    if (!link || !production || resolved?.production === production) return;
    const asked = link;
    let live = true;
    void (async () => {
      const read = async (url: string) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(await failure(response, "Projects could not be loaded."));
        return response.json() as Promise<{ id?: unknown; productions?: { id: string; name: string }[] }>;
      };
      try {
        const [own, list] = await Promise.all([read(`/api/workbench/projects?production=${encodeURIComponent(production)}`), read("/api/workbench/projects")]);
        if (!live || !same(asked)) return;
        const name = list.productions?.find((p) => p.id === production)?.name ?? null;
        setResolved({ production, draft: typeof own.id === "string" ? own.id : null, name });
      } catch (error) {
        if (live && same(asked)) setCheckError(error instanceof Error ? error.message : "Projects could not be loaded.");
      }
    })();
    return () => { live = false; };
  }, [link, production, resolved, fetch, attempt, same]);

  /* The draft a link opens, once known: the one the Workspace opens. */
  const target = !link || link.broken || where !== "here" ? null
    : production ? (resolved?.production === production ? resolved.draft : undefined)
    : link.project;
  useEffect(() => {
    if (target && projectId !== target) selectProject(target, { replace: true });
  }, [target, projectId, selectProject]);

  const dismiss = useCallback(() => { setResolved(null); setActing({ busy: false, error: null }); setCheckError(null); live().endLink(true); }, [live]);
  const retry = useCallback(() => { setCheckError(null); setAttempt((n) => n + 1); }, []);

  /* The one explicit way a link creates anything: this person opens the production, as its own draft of the shared context. */
  const openProduction = useCallback(async () => {
    if (!link || !production || acting.busy) return;
    const asked = link;
    setActing({ busy: true, error: null });
    try {
      const opened = await fetch("/api/workbench/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open", projectId: production }) });
      const body = (await opened.json().catch(() => null)) as { project?: Project; error?: string } | null;
      if (!opened.ok || !body?.project?.id) throw new Error(opened.status === 404 ? "This production is not in this workspace." : body?.error ?? "The production could not be opened. Try again.");
      const saved = await fetch("/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: body.project, revision: 0 }) });
      if (!saved.ok) throw new Error(await failure(saved, "The production could not be opened. Try again."));
      if (!same(asked)) return;
      setResolved((r) => ({ production, draft: body.project!.id, name: r?.production === production ? r.name : null }));
      setActing({ busy: false, error: null });
    } catch (error) {
      if (same(asked)) setActing({ busy: false, error: error instanceof Error ? error.message : "The production could not be opened. Try again." });
    }
  }, [link, production, acting.busy, fetch, same]);

  /* Another of this account's workspaces: switch the session, then open the same link there. */
  const switchTo = link?.workspace && where === "switch" ? (workspaces ?? []).find((w) => w.id === link.workspace) ?? null : null;
  const switchWorkspace = useCallback(async () => {
    if (!switchTo || acting.busy) return;
    setActing({ busy: true, error: null });
    try {
      const response = await fetch("/api/workspaces/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: switchTo.id }) });
      if (!response.ok) throw new Error(await failure(response, "The workspace could not be switched. Try again."));
      window.location.assign(window.location.pathname + window.location.search);
    } catch (error) {
      setActing({ busy: false, error: error instanceof Error ? error.message : "The workspace could not be switched. Try again." });
    }
  }, [switchTo, acting.busy, fetch]);

  /* How project resolution is held: nothing opens while the link is checked or cannot open; exactly its draft once known. */
  const hold: ProjectHold = !link ? null
    : link.broken || where !== "here" ? "wait"
    : production ? (typeof target === "string" ? "exact" : "wait")
    : link.project ? "exact" : null;

  return { link, hold, where, production, resolved, target, switchTo, acting, checkError, dismiss, retry, openProduction, switchWorkspace };
}

/**
 * What the link shows, given what project resolution answered; and, once the
 * project it resolved to is open, the take is selected (as the link's own
 * history entry) and the link's params leave the address bar.
 */
export function useLinkView(control: LinkControl, data: { status: "loading" | "ready" | "error"; project: Project | null; missing?: string | null }): LinkView {
  const { link, where, production, resolved, target, switchTo, acting, checkError } = control;
  const { live } = useShell();
  const opened = data.status === "ready" ? data.project?.id ?? null : null;
  /* A bare take (no project, no production) lands in whichever project opens; any other only in the one it names. */
  const landed = Boolean(link) && !link!.broken && where === "here" && opened !== null
    && (typeof target === "string" ? opened === target : !production && !link!.project);
  useEffect(() => {
    if (!landed || !link) return;
    live().selectAsset(link.asset, { reason: "link" });
    live().endLink(false);
  }, [landed, link, live]);

  /* A failed project read is the shell's own banner, with Try again; the link waits behind it. */
  if (!link || landed || data.status === "error") return { phase: "none" };
  if (link.broken) return { phase: "unavailable", why: "broken" };
  if (where !== "here") return { phase: "workspace", switchTo, ...acting };
  if (production) {
    if (resolved?.production !== production) return { phase: "checking", error: checkError };
    if (!resolved.draft) return { phase: "no-draft", name: resolved.name, ...acting };
    if (data.missing === resolved.draft) return { phase: "unavailable", why: "production" };
    return { phase: "checking" };
  }
  if (link.project) return data.missing === link.project ? { phase: "unavailable", why: "project" } : { phase: "checking" };
  /* A bare take in a workspace with no project to open it in. */
  return data.status === "ready" && !data.project ? { phase: "unavailable", why: "project" } : { phase: "checking" };
}
