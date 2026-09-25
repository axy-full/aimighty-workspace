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

type Entry = { state: LibraryState; listeners: Set<() => void>; busy: Promise<void> | null };
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { state: EMPTY, listeners: new Set(), busy: null };
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
async function load(scope: string, projectId: string) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.busy) return e.busy;
  /* A retry after a failed first read shows the skeletons again, not the stale error. */
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
      set(key, {
        status: "ready", error: null,
        uploads: uploads.items as LibraryUpload[], generations: generations.items as Generation[],
        next: { uploads: uploads.next, generations: generations.next },
        pages: { uploads: uploads.pages, generations: generations.pages },
      });
    } catch (error) {
      set(key, { status: e.state.status === "ready" ? "ready" : "error", error: error instanceof Error ? error.message : "The project library could not be loaded." });
    } finally {
      e.busy = null;
    }
  })();
  return e.busy;
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

/* ── Settling ─────────────────────────────────────────────────────────── */

/** How often a grid with a take in flight re-reads its newest page. */
export const SETTLE_MS = 6_000;

/**
 * A take the engine is still working on: queued, running, or held for a
 * free slot. A take held for credits waits on a top-up, not on time, so it
 * does not keep the grid polling.
 */
export function settling(generations: readonly Pick<Generation, "status" | "params">[]): boolean {
  return generations.some((g) => g.status === "queued" || g.status === "running"
    || (g.status === "held" && (g.params as { held?: { why?: unknown } } | null)?.held?.why === "slots"));
}

/**
 * The newest generations page, merged into what is loaded: rows it carries
 * replace their old copies, new rows join. The Queued / Rendering chips move
 * on their own and a finished take lands without a reload. A failed poll is
 * not a failed library — the next tick tries again.
 */
async function settle(scope: string, projectId: string) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.busy || e.state.status !== "ready") return;
  try {
    const page = await readPage(scope, projectId, "generations", null);
    if (e.busy || e.state.status !== "ready") return;
    set(key, { generations: mergeNewest(e.state.generations, page.items as Generation[]) });
  } catch { /* the next tick */ }
}

/** Rows in `newest` replace their loaded copies; rows not loaded yet join at the front. */
export function mergeNewest<T extends { id: string }>(loaded: readonly T[], newest: readonly T[]): T[] {
  const fresh = new Map(newest.map((g) => [g.id, g]));
  const known = new Set(loaded.map((g) => g.id));
  return [...newest.filter((g) => !known.has(g.id)), ...loaded.map((g) => fresh.get(g.id) ?? g)];
}

/* One timer per project, however many grids read it; only while the tab is on screen. */
const pollers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();
function watch(scope: string, projectId: string): () => void {
  const key = keyOf(scope, projectId);
  const found = pollers.get(key);
  if (found) found.count++;
  else pollers.set(key, {
    count: 1,
    timer: setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (settling(entry(key).state.generations)) void settle(scope, projectId);
    }, SETTLE_MS),
  });
  return () => {
    const poller = pollers.get(key);
    if (!poller || --poller.count > 0) return;
    clearInterval(poller.timer);
    pollers.delete(key);
  };
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

/* ── What a grid of takes shows ───────────────────────────────────────── */

/** The library's load state, as every grid of takes reads it (Gen › Results, Library › Assets, Takes). */
export type LibraryLoad = Pick<LibraryState, "status" | "error"> & { refresh: () => Promise<void> };

export type LibraryView = {
  /** Aspect-true placeholders while the first read is in flight. */
  skeletons: boolean;
  /** A failed read: "error" when nothing could be shown, "stale" when the cards on screen are the last good read. */
  banner: { tone: "error" | "stale"; message: string } | null;
  /** Only a finished, successful read may say the project is empty. */
  empty: boolean;
};

/**
 * One contract for every grid of takes: never "nothing here" while the read is
 * in flight or after it failed, and a failed read always says so with a way to
 * try again. With no project open, `projects` is the project list's own read:
 * still opening shows skeletons; failed shows nothing here (the shell's banner
 * says it and offers Try again).
 */
export function libraryView(load: Pick<LibraryState, "status" | "error"> | null, shown: number, projects: "loading" | "ready" | "error" = "ready"): LibraryView {
  if (!load) return projects === "loading" ? { skeletons: shown === 0, banner: null, empty: false } : { skeletons: false, banner: null, empty: projects === "ready" && shown === 0 };
  if (load.status === "error")
    return { skeletons: false, banner: { tone: "error", message: load.error || "The project library could not be loaded." }, empty: false };
  if (load.status !== "ready") return { skeletons: shown === 0, banner: null, empty: false };
  return { skeletons: false, banner: load.error ? { tone: "stale", message: load.error } : null, empty: shown === 0 };
}

/** The project's frame as a CSS aspect-ratio, held between 9:16 and 2:1 so a tile stays a tile. */
export function tileAspect(aspect: string | null | undefined): string | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(aspect ?? "");
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0)) return null;
  const ratio = Math.min(2, Math.max(9 / 16, w / h));
  return ratio === w / h ? `${m[1]} / ${m[2]}` : `${Math.round(ratio * 1000) / 1000} / 1`;
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

/**
 * What a card's picture area shows: the media; a live or held render; a
 * failure; a finished take whose stored copy is not there yet ("Preview
 * unavailable · Refresh"); or the sound / file glyph.
 */
export type EntryFace = "media" | "live" | "held" | "failed" | "unavailable" | "audio" | "file";
export function entryFace(entry: Pick<LibraryEntry, "take" | "asset" | "url" | "media">): EntryFace {
  if (entry.take.status === "failed") return "failed";
  if (entry.take.status === "rendering") return entry.take.stage === "held" ? "held" : "live";
  if (entry.url && (entry.media === "image" || entry.media === "video")) return "media";
  if (entry.media === "audio") return "audio";
  /* A finished render with no stored copy to show: the store may still be landing, so a re-read can bring it. */
  if (entry.asset.origin === "generation" && entry.asset.value.kind !== "model") return "unavailable";
  return "file";
}

/** The kind a card is filed under, whether or not it rendered (a failed still is still a still). */
export function entryKind(entry: Pick<LibraryEntry, "asset">): "image" | "video" | "audio" | "file" {
  const kind = libraryKind(entry.asset);
  return kind === "image" || kind === "video" || kind === "audio" ? kind : "file";
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
    if (projectId && entry(keyOf(scope, projectId)).state.status === "idle") void load(scope, projectId);
  }, [scope, projectId]);
  const inFlight = state.status === "ready" && settling(state.generations);
  useEffect(() => (projectId && inFlight ? watch(scope, projectId) : undefined), [scope, projectId, inFlight]);
  const items = useMemo(() => libraryEntries(state), [state]);
  return {
    state,
    items,
    refresh: useCallback(() => (projectId ? load(scope, projectId) : Promise.resolve()), [scope, projectId]),
    more: useCallback(() => (projectId ? more(scope, projectId) : Promise.resolve()), [scope, projectId]),
    upload: useCallback((files: File[]) => (projectId ? uploadToProject(scope, projectId, files) : Promise.reject(new Error("Open a saved project first."))), [scope, projectId]),
  };
}
