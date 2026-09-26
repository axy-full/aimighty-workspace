"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UploadedFile } from "../uploadClient";
import { DraftRequestError, draftWriter, writeMergedDraft, type DraftWriter } from "../workbench/draft-request";
import { rebaseProject } from "../workbench/draft-merge";
import { noteTakenOut, recordMade, sameJson, type MadeRecords } from "../workbench/merge";
import type { Asset, Project } from "../workbench/studio";
import { uploadWorkbench } from "../workbench/upload";
import { useOptionalToast } from "./state";

/**
 * Editing the open project's draft from a workspace page, through the same
 * revision-checked save the workbench uses (PUT /api/workbench/projects). One
 * store per scope and project so a page and its Inspector see the same draft.
 *
 * A change applies at once and saves shortly after; `ensureSaved` flushes
 * and reports whether the server holds it. The store keeps the draft as the
 * server last held it (`base`) beside the edited copy: when another save of
 * the project landed first (the Rig, another stage, another tab), the edits
 * made since `base` are merged into the newer version (lib/workbench/merge.ts)
 * and saved at its revision, and the page then shows the merged draft —
 * nothing another window saved is overwritten, and no edit made here is
 * dropped (what did not fit a full list is said, `notice`); what an edit takes
 * out of the records windows make alike is noted (noteTakenOut). A save whose
 * outcome is unknown is kept and tried again once the server can say whether
 * it landed (writeMergedDraft). Any other refusal says so; the next edit tries
 * again.
 */

export type DraftState = {
  status: "idle" | "loading" | "ready" | "error";
  project: Project | null;
  revision: number;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** What of this page's edits a merge could not fit (a full list another window filled first), or null. */
  notice: string | null;
};

const EMPTY: DraftState = { status: "idle", project: null, revision: 0, dirty: false, saving: false, error: null, notice: null };
type Entry = {
  state: DraftState;
  /** The draft exactly as the server holds it at `state.revision`: what the edits are merged from. */
  base: Project | null;
  /** Set by a refusal that saving again would not fix. */
  stopped: boolean;
  /** This store's saves of the draft: a save whose reply was lost is checked on the server. */
  writer: DraftWriter;
  /** What this store's changes made, as made: a record another window made from the same source merges from it. */
  made: MadeRecords;
  retries: number;
  /** Moves on with every edit and every save: a read begun before either is older than the draft on screen. */
  stamp: number;
  listeners: Set<() => void>;
  chain: Promise<boolean>;
  timer: ReturnType<typeof setTimeout> | null;
};
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);
const SAVE_DELAY = 700;
/** A save whose outcome is unknown (the connection dropped) is tried again after this, then less often. */
const RETRY_MS = 4000;
const RETRY_MAX_MS = 60_000;

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { state: EMPTY, base: null, stopped: false, writer: draftWriter(), made: new Map(), retries: 0, stamp: 0, listeners: new Set(), chain: Promise.resolve(true), timer: null };
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
  const stamp = e.stamp;
  set(key, { status: "loading", error: null });
  try {
    const response = await fetch("/api/workbench/projects?id=" + encodeURIComponent(projectId), { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.project) throw new Error(typeof body.error === "string" ? body.error : "This project could not be opened.");
    /* An edit or a save made while it was read is newer than the read: it stays, and the next save merges the newer version in. */
    if (e.state.dirty || e.state.saving || e.stamp !== stamp) { set(key, { status: "ready" }); return; }
    e.base = body.project as Project;
    e.stopped = false;
    e.retries = 0;
    if (!e.writer.unconfirmed) { e.writer = draftWriter(); e.made = new Map(); }
    set(key, { status: "ready", project: e.base, revision: Number(body.revision) || 0, error: null, notice: null });
  } catch (error) {
    set(key, { status: "error", error: error instanceof Error ? error.message : "This project could not be opened." });
  }
}

function save(scope: string, projectId: string): Promise<boolean> {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  e.chain = e.chain.catch(() => false).then(async () => {
    const { project, revision, dirty } = e.state;
    if (e.stopped) return false;
    if (!project || !dirty) return true;
    const from = e.base ?? project;
    set(key, { saving: true, dirty: false });
    try {
      const saved = await writeMergedDraft("/api/workbench", scope, { base: from, mine: project, revision, writer: e.writer, made: e.made });
      e.base = saved.project;
      e.retries = 0;
      e.stamp++;
      /* The page shows what was saved — another window's edits included — with any edits made meanwhile laid over it. */
      const next = rebaseProject(project, e.state.project ?? project, saved.project);
      set(key, { saving: false, revision: saved.revision, project: next, dirty: e.state.dirty || !sameJson(next, saved.project), error: null, notice: saved.notes.length ? saved.notes.join(" ") : null });
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "This project could not be saved.";
      if (cause instanceof DraftRequestError && (cause.uncertain || cause.retryable)) {
        /* Unknown or temporary: the edits stay, and the save is tried again once the server can say whether it landed. */
        set(key, { saving: false, dirty: true, error: message });
        const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** e.retries++);
        if (!e.timer) e.timer = setTimeout(() => void save(scope, projectId), wait);
        return false;
      }
      e.stopped = true;
      set(key, { saving: false, dirty: true, error: message });
      return false;
    }
  });
  return e.chain;
}

/** Saves until the server holds every edit made so far (edits made during a write go out with the next). */
async function saveAll(scope: string, projectId: string): Promise<boolean> {
  const e = entry(keyOf(scope, projectId));
  for (let pass = 0; pass < 3; pass++) {
    if (!(await save(scope, projectId))) return false;
    if (!e.state.dirty) return true;
  }
  return !e.state.dirty;
}

function change(scope: string, projectId: string, fn: (p: Project) => Project) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (!e.state.project) return;
  const changed = fn(e.state.project);
  if (changed === e.state.project) return;
  /* What it made, as made, and what it took out of what windows make alike: the merge reads both. */
  const next = noteTakenOut(e.state.project, changed);
  recordMade(e.made, e.state.project, next);
  e.stamp++;
  set(key, { project: next, dirty: true });
  /* A refused save held the edits; this edit may be what the server needed. It tries again. */
  e.stopped = false;
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
  /* What a merge could not fit is said where the person looks. */
  const toast = useOptionalToast();
  useEffect(() => { if (state.notice) toast?.(state.notice); }, [state.notice, toast]);
  useEffect(() => {
    if (!projectId) return;
    const s = entry(keyOf(scope, projectId)).state;
    /* Re-read when a page opens, unless edits are still on their way. */
    if (!s.dirty && !s.saving) void load(scope, projectId);
  }, [scope, projectId]);
  const onChange = useCallback((fn: (p: Project) => Project) => { if (projectId) change(scope, projectId, fn); }, [scope, projectId]);
  const ensureSaved = useCallback(() => (projectId ? saveAll(scope, projectId) : Promise.resolve(false)), [scope, projectId]);
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
      if (!(await saveAll(scope, projectId))) throw new Error("The originals uploaded, but this project could not be saved. They remain in your workspace uploads.");
    }
    return received;
  }, [scope, projectId]);
  return { state, project: state.project, onChange, ensureSaved, uploadAssets, reload: useCallback(() => (projectId ? load(scope, projectId) : Promise.resolve()), [scope, projectId]) };
}
