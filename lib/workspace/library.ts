"use client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Generation } from "../jobs";
import { libraryKind, libraryReady, libraryUrl, type LibraryAsset, type LibraryUpload } from "../genLibrary";
import { inlineSafe } from "../serveType";
import { uploadFile, type UploadedFile } from "../uploadClient";
import { fileProjectUpload } from "../workbench/project-library-client";
import { projectTakes, type Take } from "./takes";

/**
 * The open project's library — every upload and generation filed to it —
 * read from the existing route (GET /api/workbench/library, the same
 * listProjectLibrary the workbench's project library uses) with its own
 * cursors. One store per scope and project, so the Takes page, its Inspector
 * and the Library sidebar's Media tab read one copy and refresh together.
 */

type Source = "uploads" | "generations";
export type LibraryState = {
  status: "idle" | "loading" | "ready" | "error";
  uploads: LibraryUpload[];
  generations: Generation[];
  next: Record<Source, string | null>;
  /** Pages loaded per source; a refresh re-reads the same range. */
  pages: Record<Source, number>;
  moreBusy: boolean;
  error: string | null;
  /** Upload progress, e.g. "still.png · 40%"; null when idle. */
  uploading: string | null;
};

const EMPTY: LibraryState = {
  status: "idle", uploads: [], generations: [], next: { uploads: null, generations: null },
  pages: { uploads: 0, generations: 0 }, moreBusy: false, error: null, uploading: null,
};

type Entry = {
  state: LibraryState;
  listeners: Set<() => void>;
  busy: Promise<void> | null;
  /** A read asked for while one was in flight: it runs once that one lands, so it sees every change made before it was asked for. */
  rerun: Promise<void> | null;
  /** A first read that failed is tried again on its own, a few times, further apart each time. */
  retry: { attempts: number; timer: ReturnType<typeof setTimeout> | null };
};
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);
/** Waits before re-reading a library whose first read failed; then it waits for Try again. */
export const LIBRARY_RETRY_MS = [2_000, 8_000, 30_000] as const;

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { state: EMPTY, listeners: new Set(), busy: null, rerun: null, retry: { attempts: 0, timer: null } };
    entries.set(key, found);
  }
  return found;
}
function set(key: string, patch: Partial<LibraryState>) {
  const e = entry(key);
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((listener) => listener());
}

async function readPage(scope: string, projectId: string, source: Source, cursor: string | null) {
  const query = new URLSearchParams({ projectId, source, limit: "60" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch("/api/workbench/library?" + query, { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
  const json = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(json?.[source])) throw new Error(json?.error || "The project library could not be loaded.");
  return {
    items: json[source] as (LibraryUpload | Generation)[],
    next: ((source === "generations" ? json.nextPageCursor : json.nextCursor) ?? null) as string | null,
  };
}

/** Re-read the loaded range of both sources, first page onwards. */
async function load(scope: string, projectId: string): Promise<void> {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  /* A read already in flight may have started before the change this refresh is for: read once more after it. */
  if (e.busy) {
    e.rerun ??= e.busy.then(() => { e.rerun = null; return load(scope, projectId); });
    return e.rerun;
  }
  if (e.retry.timer) { clearTimeout(e.retry.timer); e.retry.timer = null; }
  if (e.state.status === "idle" || e.state.status === "error") set(key, { status: "loading", error: null });
  e.busy = (async () => {
    try {
      const read = async (source: Source) => {
        const items: (LibraryUpload | Generation)[] = [];
        let cursor: string | null = null, pages = 0;
        const want = Math.max(1, e.state.pages[source]);
        do {
          const page = await readPage(scope, projectId, source, cursor);
          items.push(...page.items);
          cursor = page.next;
          pages++;
        } while (cursor && pages < want);
        return { items, next: cursor, pages };
      };
      const [uploads, generations] = await Promise.all([read("uploads"), read("generations")]);
      e.retry.attempts = 0;
      set(key, {
        status: "ready", error: null,
        uploads: uploads.items as LibraryUpload[], generations: generations.items as Generation[],
        next: { uploads: uploads.next, generations: generations.next },
        pages: { uploads: uploads.pages, generations: generations.pages },
      });
    } catch (error) {
      const first = e.state.status !== "ready";
      set(key, { status: first ? "error" : "ready", error: error instanceof Error ? error.message : "The project library could not be loaded." });
      /* A blip on the first read is not left on screen for the session: try again, a few times, further apart. */
      const wait = first ? LIBRARY_RETRY_MS[e.retry.attempts] : undefined;
      if (wait !== undefined && e.listeners.size) {
        e.retry.attempts++;
        e.retry.timer = setTimeout(() => { e.retry.timer = null; if (e.listeners.size) void load(scope, projectId); }, wait);
      }
    } finally {
      e.busy = null;
    }
  })();
  return e.busy;
}

/** Read (or re-read) a project's library outside a component, and what the store holds for it. */
export function loadProjectLibrary(scope: string, projectId: string) {
  return load(scope, projectId);
}
export function projectLibraryState(scope: string, projectId: string): LibraryState {
  return entry(keyOf(scope, projectId)).state;
}

/**
 * Re-read a project's library outside a component — for anything that files a
 * new take while the Takes page and the Library sidebar are already loaded
 * (the global Generate composer does), so the card appears without a reload.
 */
export function refreshProjectLibrary(scope: string, projectId: string) {
  if (entry(keyOf(scope, projectId)).state.status === "idle") return Promise.resolve();
  return load(scope, projectId);
}

/** The next page of every source that has one (the existing library cursors). */
async function more(scope: string, projectId: string) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.state.moreBusy || e.busy) return;
  const sources = (["uploads", "generations"] as Source[]).filter((s) => e.state.next[s]);
  if (!sources.length) return;
  set(key, { moreBusy: true });
  try {
    const pages = await Promise.all(sources.map((s) => readPage(scope, projectId, s, e.state.next[s])));
    const next = { ...e.state.next }, count = { ...e.state.pages };
    let uploads = e.state.uploads, generations = e.state.generations;
    sources.forEach((source, i) => {
      next[source] = pages[i].next;
      count[source]++;
      if (source === "uploads") uploads = dedupe([...uploads, ...(pages[i].items as LibraryUpload[])]);
      else generations = dedupe([...generations, ...(pages[i].items as Generation[])]);
    });
    set(key, { uploads, generations, next, pages: count, moreBusy: false, error: null });
  } catch (error) {
    set(key, { moreBusy: false, error: error instanceof Error ? error.message : "More assets could not be loaded." });
  }
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/**
 * Upload files into the project the way the workbench library does
 * (components/make/GenAssetLibrary.tsx): each file through the existing
 * chunked upload client, stored byte-for-byte, then filed to this project.
 */
export async function uploadToProject(scope: string, projectId: string, files: File[]): Promise<number> {
  const key = keyOf(scope, projectId);
  if (entry(key).state.uploading) throw new Error("Wait for the current uploads to finish.");
  if (files.length > 20) throw new Error("Choose up to 20 assets per upload batch.");
  let completed = 0;
  try {
    for (const file of files) {
      set(key, { uploading: `Uploading ${file.name}` });
      const stored = await uploadFile(file, "chat", (pct) => set(key, { uploading: `${file.name} · ${pct}%` }), { scope });
      await fileProjectUpload(projectId, stored.id, scope);
      completed++;
    }
  } finally {
    set(key, { uploading: null });
    if (completed) await load(scope, projectId);
  }
  return completed;
}

/**
 * Device files into this project's Library, from any drop or prompt box
 * (owner, 25 September: every kind of media, from anywhere). A picture or
 * video goes up as a reference the engines can take; if the reference intake
 * refuses it (too small, a format the engines do not read), it is still kept
 * as the file it is, and the note says why. Filed to the project, the Library
 * reloaded; answers the new Library ids in order.
 */
export async function uploadFilesToProject(scope: string, projectId: string, files: File[]): Promise<{ ids: string[]; uploads: UploadedFile[]; notes: string[] }> {
  const key = keyOf(scope, projectId);
  if (files.length > 20) throw new Error("Choose up to 20 files at a time.");
  const ids: string[] = [], notes: string[] = [], uploads: UploadedFile[] = [];
  try {
    for (const file of files) {
      set(key, { uploading: `Uploading ${file.name}` });
      const progress = (pct: number) => set(key, { uploading: `${file.name} · ${pct}%` });
      const media = file.type.startsWith("image/") || file.type.startsWith("video/");
      let stored: UploadedFile;
      if (media) {
        try { stored = await uploadFile(file, "reference", progress, { scope }); }
        catch (error) {
          stored = await uploadFile(file, "chat", progress, { scope });
          notes.push(`${file.name} is kept in the Library; engines may not take it as a reference (${error instanceof Error ? error.message.replace(/\.$/, "") : "the reference check refused it"}).`);
        }
      } else stored = await uploadFile(file, "chat", progress, { scope });
      await fileProjectUpload(projectId, stored.id, scope);
      ids.push(`upload:${stored.id}`);
      uploads.push(stored);
    }
  } finally {
    set(key, { uploading: null });
    if (ids.length) await load(scope, projectId);
  }
  return { ids, uploads, notes };
}

/* ── Cards ────────────────────────────────────────────────────────────── */

export type LibraryEntry = {
  take: Take;
  asset: LibraryAsset;
  /** Stored media URL when the browser can show it; null otherwise. */
  url: string | null;
  media: "image" | "video" | "audio" | null;
};

/** Newest first, uploads and generations together — the workbench library's order. */
export function libraryEntries(state: Pick<LibraryState, "uploads" | "generations">): LibraryEntry[] {
  const assets: LibraryAsset[] = [
    ...state.generations.map((value) => ({ origin: "generation" as const, value })),
    ...state.uploads.map((value) => ({ origin: "upload" as const, value })),
  ].sort((a, b) => b.value.createdAt - a.value.createdAt || b.value.id.localeCompare(a.value.id));
  const takes = projectTakes(assets);
  return assets.map((asset, i) => {
    const kind = libraryKind(asset);
    const visible = libraryReady(asset) && (asset.origin === "generation" || inlineSafe(asset.value.mime));
    const media = visible && (kind === "image" || kind === "video" || kind === "audio") ? kind : null;
    return { take: takes[i], asset, url: media ? libraryUrl(asset) : null, media };
  });
}

export function useProjectLibrary(scope: string, projectId: string | null) {
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
    const e = entry(keyOf(scope, projectId));
    /* Opening a project whose last read failed reads it again, from the top of the retries. */
    if (e.state.status === "error" && !e.busy && !e.retry.timer) e.retry.attempts = 0;
    if (e.state.status === "idle" || (e.state.status === "error" && !e.busy && !e.retry.timer)) void load(scope, projectId);
  }, [scope, projectId]);
  const items = useMemo(() => libraryEntries(state), [state]);
  return {
    state,
    items,
    /** True while a cursor says the project has more than is loaded. */
    hasMore: Boolean(state.next.uploads || state.next.generations),
    /** Try again after a failed read: resets the automatic retries. */
    refresh: useCallback(() => {
      if (!projectId) return Promise.resolve();
      entry(keyOf(scope, projectId)).retry.attempts = 0;
      return load(scope, projectId);
    }, [scope, projectId]),
    more: useCallback(() => (projectId ? more(scope, projectId) : Promise.resolve()), [scope, projectId]),
    upload: useCallback((files: File[]) => (projectId ? uploadToProject(scope, projectId, files) : Promise.reject(new Error("Open a saved project first."))), [scope, projectId]),
  };
}
