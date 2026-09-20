"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UploadedFile } from "../uploadClient";
import { writeDraft } from "../workbench/draft-request";
import type { Asset, Project } from "../workbench/studio";
import { uploadWorkbench } from "../workbench/upload";

/**
 * Editing the open project's draft from a workspace page, through the same
 * revision-checked save the workbench uses (PUT /api/workbench/projects via
 * writeDraft, which reconciles an uncertain write). One store per scope and
 * project so a page and its Inspector see the same draft.
 *
 * A change applies at once and saves shortly after; `ensureSaved` flushes
 * and reports whether the server holds it. A revision conflict (the project
 * changed in another window) stops saving and says so — nothing is merged
 * behind the person's back.
 */

export type DraftState = {
  status: "idle" | "loading" | "ready" | "error";
  project: Project | null;
  revision: number;
  dirty: boolean;
  saving: boolean;
  error: string | null;
};

const EMPTY: DraftState = { status: "idle", project: null, revision: 0, dirty: false, saving: false, error: null };
type Entry = { state: DraftState; listeners: Set<() => void>; chain: Promise<boolean>; timer: ReturnType<typeof setTimeout> | null };
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);
const SAVE_DELAY = 700;

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { state: EMPTY, listeners: new Set(), chain: Promise.resolve(true), timer: null };
    entries.set(key, found);
  }
  return found;
}
function set(key: string, patch: Partial<DraftState>) {
  const e = entry(key);
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((listener) => listener());
}

async function load(scope: string, projectId: string) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.state.status === "loading" || e.state.dirty || e.state.saving) return;
  set(key, { status: "loading", error: null });
  try {
    const response = await fetch("/api/workbench/projects?id=" + encodeURIComponent(projectId), { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.project) throw new Error(typeof body.error === "string" ? body.error : "This project could not be opened.");
    set(key, { status: "ready", project: body.project as Project, revision: Number(body.revision) || 0, error: null });
  } catch (error) {
    set(key, { status: "error", error: error instanceof Error ? error.message : "This project could not be opened." });
  }
}

function save(scope: string, projectId: string): Promise<boolean> {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  e.chain = e.chain.then(async () => {
    const { project, revision, dirty, error } = e.state;
    if (error) return false;
    if (!project || !dirty) return true;
    set(key, { saving: true, dirty: false });
    try {
      const receipt = await writeDraft("/api/workbench", scope, { project, revision });
      const current = e.state.project ?? project;
      set(key, {
        saving: false, revision: receipt.revision,
        project: { ...current, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings },
      });
      return true;
    } catch (cause) {
      set(key, { saving: false, dirty: true, error: cause instanceof Error ? cause.message : "This project could not be saved." });
      return false;
    }
  });
  return e.chain;
}

function change(scope: string, projectId: string, fn: (p: Project) => Project) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (!e.state.project) return;
  const next = fn(e.state.project);
  if (next === e.state.project) return;
  set(key, { project: next, dirty: true });
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => void save(scope, projectId), SAVE_DELAY);
}

/** An uploaded original as a project asset — the workbench's own shape (Studio uploadFiles). */
export function assetFromUpload(file: Pick<File, "name" | "type">, data: UploadedFile, category: string): Asset {
  return {
    id: data.id,
    uploadId: data.id,
    ...(typeof data.durationS === "number" && data.durationS > 0 ? { seconds: data.durationS } : {}),
    name: file.name,
    kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "document",
    category,
    url: data.url,
    mime: file.type,
    description: "Uploaded from device",
    prompt: "",
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  };
}

export function useDraftEditor(scope: string, projectId: string | null) {
  const key = projectId ? keyOf(scope, projectId) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    const e = entry(key);
    e.listeners.add(listener);
    return () => { e.listeners.delete(listener); };
  }, [key]);
  const state = useSyncExternalStore(subscribe, () => (key ? entry(key).state : EMPTY), () => EMPTY);
  useEffect(() => {
    if (!projectId) return;
    const s = entry(keyOf(scope, projectId)).state;
    /* Re-read when a page opens, unless edits are still on their way. */
    if (!s.dirty && !s.saving) void load(scope, projectId);
  }, [scope, projectId]);
  const onChange = useCallback((fn: (p: Project) => Project) => { if (projectId) change(scope, projectId, fn); }, [scope, projectId]);
  const ensureSaved = useCallback(() => (projectId ? save(scope, projectId) : Promise.resolve(false)), [scope, projectId]);
  /** Upload originals into the draft as assets of `category`, then save. */
  const uploadAssets = useCallback(async (files: File[], category: string, onProgress?: (label: string) => void): Promise<Asset[]> => {
    if (!projectId) throw new Error("Open a saved project first.");
    const received: Asset[] = [];
    for (const file of files) {
      onProgress?.(`Uploading ${file.name}`);
      const data = await uploadWorkbench(file, (pct) => onProgress?.(`${file.name} · ${pct}%`), scope);
      received.push(assetFromUpload(file, data, category));
    }
    if (received.length) {
      change(scope, projectId, (p) => ({ ...p, assets: [...p.assets, ...received.filter((a) => !p.assets.some((b) => b.id === a.id))] }));
      if (!(await save(scope, projectId))) throw new Error("The originals uploaded, but this project could not be saved. They remain in your workspace uploads.");
    }
    return received;
  }, [scope, projectId]);
  return { state, project: state.project, onChange, ensureSaved, uploadAssets, reload: useCallback(() => (projectId ? load(scope, projectId) : Promise.resolve()), [scope, projectId]) };
}
