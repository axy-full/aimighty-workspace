"use client";
import { useCallback, useEffect, useRef } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectSummary } from "@/lib/workspace/data";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { SAY, assetRef, referenceRole, retryPreset, type AssetRef } from "./assets";
import { sendGenPreset } from "./gen-preset";
import { sendReference } from "./reference-inbox";
import { useShell } from "./state";

/**
 * What the right-click commands, the Library `+` and a drop actually do to
 * an asset — every one through a route the app already has, every
 * destructive one pushing its inverse onto the undo stack (README ›
 * Right-click menu). Nothing here invents a copy of a file.
 */
export type AssetClip = { mode: "copy" | "cut"; asset: AssetRef; fromProjectId: string };

export function useAssetActions(input: { scope: string; project: Project | null; projects: ProjectSummary[]; items: LibraryEntry[] }) {
  const { scope, project, projects, items } = input;
  const scoped = useScopedFetch();
  const ws = useWorkspace();
  const shell = useShell();
  const projectId = project?.id ?? null;
  const projectName = project?.name ?? "this project";

  const call = useCallback(async (url: string, init: RequestInit) => {
    const response = await scoped(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const json = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(json?.error ?? "That could not be done.");
    return json;
  }, [scoped]);
  const refresh = useCallback((id = projectId) => { if (id) void refreshProjectLibrary(scope, id); }, [scope, projectId]);
  const find = useCallback((id: string) => items.find((entry) => entry.take.id === id) ?? null, [items]);
  const fail = useCallback((error: unknown) => ws.toast(error instanceof Error ? error.message : "That could not be done."), [ws]);

  /* Filing: an upload is filed into or out of a project; a generation is moved between productions. */
  const file = useCallback((uploadId: string, into: string) => call("/api/workbench/library", { method: "POST", body: JSON.stringify({ projectId: into, uploadId }) }), [call]);
  const unfile = useCallback((uploadId: string, from: string) => call("/api/workbench/library", { method: "DELETE", body: JSON.stringify({ projectId: from, uploadId }) }), [call]);
  const productionOf = useCallback(async (workbenchId: string): Promise<string | null> => {
    const response = await scoped(`/api/workbench/projects?id=${encodeURIComponent(workbenchId)}`, { cache: "no-store" });
    const json = await response.json().catch(() => null) as { project?: { productionProjectId?: string } } | null;
    return json?.project?.productionProjectId ?? null;
  }, [scoped]);

  const trash = useCallback(async (asset: AssetRef, from = projectId) => {
    if (!from) return;
    if (asset.origin === "generation") await call(`/api/jobs/${encodeURIComponent(asset.sourceId)}`, { method: "PATCH", body: JSON.stringify({ trashed: true }) });
    else await unfile(asset.sourceId, from);
    if (ws.state.selKind === "take" && ws.state.selId === asset.id) ws.dispatch({ type: "patch", patch: { selKind: "page", selId: ws.state.page } });
    refresh(from);
  }, [projectId, call, unfile, ws, refresh]);
  const restore = useCallback(async (asset: AssetRef, into: string) => {
    if (asset.origin === "generation") await call(`/api/jobs/${encodeURIComponent(asset.sourceId)}`, { method: "PATCH", body: JSON.stringify({ trashed: false }) });
    else await file(asset.sourceId, into);
    refresh(into);
  }, [call, file, refresh]);

  const remove = useCallback(async (id: string) => {
    const entry = find(id);
    if (!entry || !projectId) return;
    const asset = assetRef(entry), from = projectId;
    try {
      await trash(asset, from);
      shell.pushUndo({ label: SAY.restored(asset.name), undo: () => restore(asset, from) });
      ws.toast(SAY.deleted(asset));
    } catch (error) { fail(error); }
  }, [find, projectId, trash, restore, shell, ws, fail]);

  /* Undo of a move is a move back, so the function needs itself: through a ref, not its own closure. */
  const moveRef = useRef<(asset: AssetRef, from: string, to: ProjectSummary, silent?: boolean) => Promise<void>>(async () => {});
  const move = useCallback(async (asset: AssetRef, from: string, to: ProjectSummary, silent = false) => {
    if (asset.origin === "upload") {
      await file(asset.sourceId, to.id);
      await unfile(asset.sourceId, from);
    } else {
      const production = await productionOf(to.id);
      if (!production) throw new Error(`${to.name} has not been opened in Studio yet, so it has no production to move a render into. Open it once, then try again.`);
      await call(`/api/jobs/${encodeURIComponent(asset.sourceId)}`, { method: "PATCH", body: JSON.stringify({ projectId: production }) });
    }
    refresh(from); refresh(to.id);
    if (!silent) {
      const back: ProjectSummary = { id: from, name: projects.find((p) => p.id === from)?.name ?? "its project" };
      shell.pushUndo({ label: SAY.moved(asset.name, back.name), undo: () => moveRef.current(asset, to.id, back, true) });
      ws.toast(SAY.moved(asset.name, to.name));
    }
  }, [file, unfile, productionOf, call, refresh, projects, shell, ws]);
  useEffect(() => { moveRef.current = move; }, [move]);

  const copy = useCallback((id: string, mode: "copy" | "cut") => {
    const entry = find(id);
    if (!entry || !projectId) return;
    const asset = assetRef(entry);
    shell.setClip({ mode, target: { kind: "asset", id: asset.id }, name: asset.name, payload: { asset, fromProjectId: projectId } });
    ws.toast(mode === "cut" ? SAY.cut(asset.name) : SAY.copied(asset.name));
  }, [find, projectId, shell, ws]);

  const paste = useCallback(async () => {
    const clip = shell.clip;
    const payload = clip?.payload as { asset: AssetRef; fromProjectId: string } | undefined;
    if (!clip || !payload || !projectId) return;
    const { asset, fromProjectId } = payload;
    const here: ProjectSummary = { id: projectId, name: projectName };
    try {
      if (fromProjectId === projectId) { ws.toast(`${asset.name} is already in ${projectName}.`); return; }
      if (clip.mode === "cut") {
        await move(asset, fromProjectId, here);
        shell.setClip(null);
      } else {
        if (asset.origin !== "upload") { ws.toast("A generation belongs to one project: cut it to move it."); return; }
        await file(asset.sourceId, projectId);
        refresh(projectId);
        shell.pushUndo({ label: `${asset.name} unfiled from ${projectName}`, undo: async () => { await unfile(asset.sourceId, projectId); refresh(projectId); } });
        ws.toast(SAY.pasted(asset.name, projectName));
      }
    } catch (error) { fail(error); }
  }, [shell, projectId, projectName, move, file, unfile, refresh, ws, fail]);

  const useAsReference = useCallback((id: string) => {
    const entry = find(id);
    if (!entry) return;
    const role = referenceRole(entry.media);
    if (!role) { ws.toast("References are images and videos."); return; }
    sendReference({ id: entry.take.id, name: entry.take.name });
    if (shell.view !== "gen") shell.goGen();
    ws.toast(SAY.referenced(entry.take.name, role));
  }, [find, shell, ws]);

  const retry = useCallback((id: string) => {
    const entry = find(id);
    if (!entry) return;
    if (entry.asset.origin !== "generation") { ws.toast("An upload was not generated; there is nothing to retry."); return; }
    /* Gen applies it at once when it is on screen, or when it opens. */
    sendGenPreset(retryPreset(entry.asset.value));
    if (shell.view !== "gen") shell.goGen();
    ws.toast(SAY.retry(entry.take.name));
  }, [find, shell, ws]);

  /* A render dropped on a Rig row is filed on that shot (its next version); an upload cannot be. */
  const fileOnShot = useCallback(async (id: string, shot: { nodeId: string; name: string }) => {
    const entry = find(id);
    if (!entry || !project) return;
    if (entry.asset.origin !== "generation") { ws.toast("Only a render can be filed on a shot. Use it as a reference instead."); return; }
    try {
      let shotId = project.shotMappings?.[shot.nodeId] ?? null;
      if (!shotId) {
        const mapped = await call("/api/workbench/projects", { method: "POST", body: JSON.stringify({ projectId: project.id, action: "map-shot", nodeId: shot.nodeId }) }) as { shotId?: string } | null;
        shotId = mapped?.shotId ?? null;
      }
      if (!shotId) throw new Error("This shot has no production shot yet.");
      const before = entry.asset.value.shotId ?? null;
      await call(`/api/jobs/${encodeURIComponent(entry.take.sourceId)}`, { method: "PATCH", body: JSON.stringify({ shotId }) });
      refresh();
      shell.pushUndo({ label: `${entry.take.name} unfiled from ${shot.name}`, undo: async () => { await call(`/api/jobs/${encodeURIComponent(entry.take.sourceId)}`, { method: "PATCH", body: JSON.stringify({ shotId: before }) }); refresh(); } });
      ws.toast(SAY.filed(entry.take.name, shot.name));
    } catch (error) { fail(error); }
  }, [find, project, call, refresh, shell, ws, fail]);

  const moveTo = useCallback(async (id: string, to: ProjectSummary) => {
    const entry = find(id);
    if (!entry || !projectId) return;
    try { await move(assetRef(entry), projectId, to); } catch (error) { fail(error); }
  }, [find, projectId, move, fail]);

  return { remove, copy, paste, useAsReference, retry, fileOnShot, moveTo };
}
