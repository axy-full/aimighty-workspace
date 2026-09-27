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
  /** A re-read failed while cards were on screen: they are the last good read (`error` says why). A failed Load more is not stale. */
  stale: boolean;
  /** Upload progress, e.g. "still.png · 40%"; null when idle. */
  uploading: string | null;
};

const EMPTY: LibraryState = {
  status: "idle", uploads: [], generations: [], next: { uploads: null, generations: null },
  pages: { uploads: 0, generations: 0 }, moreBusy: false, error: null, stale: false, uploading: null,
};

type Entry = {
  state: LibraryState;
  listeners: Set<() => void>;
  busy: Promise<void> | null;
  /** The next page on its way (Load more, or a search paging back to one take); a second ask awaits it. */
  paging: Promise<void> | null;
  /** A read asked for while one was in flight: it runs once that one lands, so it sees every change made before it was asked for. */
  rerun: Promise<void> | null;
  /** A first read that failed is tried again on its own, a few times, further apart each time. */
  retry: { attempts: number; timer: ReturnType<typeof setTimeout> | null };
  /** Counts full reads that landed: a settle poll that began before one does not overwrite it. */
  epoch: number;
};
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);
/** Waits before re-reading a library whose first read failed; then it waits for Try again. */
export const LIBRARY_RETRY_MS = [2_000, 8_000, 30_000] as const;

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { state: EMPTY, listeners: new Set(), busy: null, paging: null, rerun: null, retry: { attempts: 0, timer: null }, epoch: 0 };
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
      e.retry.attempts = 0;
      e.epoch++;
      /* A full read just landed: a take still in flight is asked after again soon, not at the end of a long backoff. */
      nudge(key);
      set(key, {
        status: "ready", error: null, stale: false,
        uploads: uploads.items as LibraryUpload[], generations: generations.items as Generation[],
        next: { uploads: uploads.next, generations: generations.next },
        pages: { uploads: uploads.pages, generations: generations.pages },
      });
    } catch (error) {
      const first = e.state.status !== "ready";
      set(key, { status: first ? "error" : "ready", stale: !first, error: error instanceof Error ? error.message : "The project library could not be loaded." });
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

/** The next page of every source that has one (the existing library cursors); a page already on its way is the one awaited. */
async function more(scope: string, projectId: string) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.paging) return e.paging;
  if (e.busy) return;
  const sources = (["uploads", "generations"] as Source[]).filter((s) => e.state.next[s]);
  if (!sources.length) return;
  set(key, { moreBusy: true });
  e.paging = (async () => {
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
      set(key, { uploads, generations, next, pages: count, moreBusy: false, error: null, stale: false });
    } catch (error) {
      set(key, { moreBusy: false, error: error instanceof Error ? error.message : "More assets could not be loaded." });
    } finally {
      e.paging = null;
    }
  })();
  return e.paging;
}

/** How far a search for one take pages back before it gives up (60 of each source a page). */
const FIND_PAGES = 20;
/**
 * Make sure one take (`generation:<id>` or `upload:<id>`) is in the loaded
 * Library before anything opens it: the loaded range is read again (a take
 * filed a moment ago is on the first page), then older pages come in by the
 * existing cursors until it is there or nothing older is left. `since` is the
 * newest the take can be dated: a connected-account original is filed at its
 * job's own time, so pages older than that cannot hold it. Answers whether
 * the take is loaded now.
 */
export async function findProjectTake(scope: string, projectId: string, takeId: string, since?: number): Promise<boolean> {
  const e = entry(keyOf(scope, projectId));
  const split = takeId.indexOf(":");
  const source: Source | null = takeId.slice(0, split) === "generation" ? "generations" : takeId.slice(0, split) === "upload" ? "uploads" : null;
  const id = takeId.slice(split + 1);
  if (!source) return false;
  const has = () => (e.state[source] as { id: string }[]).some((item) => item.id === id);
  if (has()) return true;
  await load(scope, projectId);
  for (let page = 0; page < FIND_PAGES && !has(); page++) {
    if (e.state.status !== "ready" || e.state.error || !e.state.next[source]) break;
    const oldest = e.state[source].at(-1);
    if (since != null && oldest && oldest.createdAt < since) break;
    await (e.busy ?? more(scope, projectId));
  }
  return has();
}

/* ── Settling ─────────────────────────────────────────────────────────── */

/**
 * How long a grid with a take in flight waits before it re-reads its newest
 * page: soon while takes are moving, then less often while nothing changes
 * (a render can sit on the engine for minutes, a take held for credits waits
 * on a top-up), never more than a minute apart.
 */
export const SETTLE_MS = [6_000, 6_000, 12_000, 24_000, 60_000] as const;
export const settleWait = (quiet: number) => SETTLE_MS[Math.min(Math.max(0, quiet), SETTLE_MS.length - 1)];

/** A take that has not settled: queued, running, or held (for a free slot, or until credits arrive). */
export function settling(generations: readonly Pick<Generation, "status">[]): boolean {
  return generations.some((g) => g.status === "queued" || g.status === "running" || g.status === "held");
}

/** Whether the newest page says anything moved: a row not loaded yet, or one whose status, stored copy or last change differs. */
export function pageMoved(loaded: readonly Pick<Generation, "id" | "status" | "storedUrl" | "updatedAt">[], newest: readonly Pick<Generation, "id" | "status" | "storedUrl" | "updatedAt">[]): boolean {
  const known = new Map(loaded.map((g) => [g.id, g]));
  return newest.some((g) => {
    const old = known.get(g.id);
    return !old || old.status !== g.status || old.storedUrl !== g.storedUrl || old.updatedAt !== g.updatedAt;
  });
}

/**
 * The newest generations page, merged into what is loaded: rows it carries
 * replace their old copies, new rows join. The Queued / Rendering / Held
 * chips move on their own and a finished take lands without a reload. A
 * failed poll is not a failed library — the next tick tries again. Answers
 * whether anything moved.
 */
async function settle(scope: string, projectId: string): Promise<boolean> {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.busy || e.state.status !== "ready") return false;
  const epoch = e.epoch;
  try {
    const page = await readPage(scope, projectId, "generations", null);
    /* A full read that started or landed meanwhile is newer than this page: it stands. */
    if (e.busy || e.epoch !== epoch || e.state.status !== "ready") return false;
    const newest = page.items as Generation[];
    if (!pageMoved(e.state.generations, newest)) return false;
    set(key, { generations: mergeNewest(e.state.generations, newest) });
    return true;
  } catch { return false; /* the next tick */ }
}

/** Rows in `newest` replace their loaded copies; rows not loaded yet join at the front. */
export function mergeNewest<T extends { id: string }>(loaded: readonly T[], newest: readonly T[]): T[] {
  const fresh = new Map(newest.map((g) => [g.id, g]));
  const known = new Set(loaded.map((g) => g.id));
  return [...newest.filter((g) => !known.has(g.id)), ...loaded.map((g) => fresh.get(g.id) ?? g)];
}

/* One timer per project, however many grids read it; it reads only while the tab is on screen. */
type Poller = { count: number; quiet: number; timer: ReturnType<typeof setTimeout> | null; running: boolean; tick: () => Promise<void> };
const pollers = new Map<string, Poller>();

/** Something fresh happened (a full read landed, the tab came back): poll again from the short end of the backoff. */
function nudge(key: string, wait: number = settleWait(0)) {
  const poller = pollers.get(key);
  if (!poller) return;
  poller.quiet = 0;
  /* A tick that is out reschedules itself when it lands. */
  if (poller.running) return;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = setTimeout(() => void poller.tick(), wait);
}

let watchingVisibility = false;
function nudgeWhenVisible() {
  if (watchingVisibility || typeof document === "undefined") return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") for (const key of pollers.keys()) nudge(key, 1_000);
  });
}

function watch(scope: string, projectId: string): () => void {
  const key = keyOf(scope, projectId);
  const found = pollers.get(key);
  if (found) found.count++;
  else {
    const poller: Poller = {
      count: 1, quiet: 0, timer: null, running: false,
      tick: async () => {
        poller.timer = null;
        poller.running = true;
        try {
          const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
          if (visible && settling(entry(key).state.generations)) poller.quiet = (await settle(scope, projectId)) ? 0 : poller.quiet + 1;
        } finally {
          poller.running = false;
        }
        if (pollers.get(key) === poller && !poller.timer) poller.timer = setTimeout(() => void poller.tick(), settleWait(poller.quiet));
      },
    };
    poller.timer = setTimeout(() => void poller.tick(), settleWait(0));
    pollers.set(key, poller);
    nudgeWhenVisible();
  }
  return () => {
    const poller = pollers.get(key);
    if (!poller || --poller.count > 0) return;
    if (poller.timer) clearTimeout(poller.timer);
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
 *
 * One file failing does not lose the others: it is named in `notes` and the
 * rest still upload and are answered, so a prompt box attaches what arrived
 * instead of leaving it in the Library with only an error to show.
 */
export async function uploadFilesToProject(scope: string, projectId: string, files: File[]): Promise<{ ids: string[]; uploads: UploadedFile[]; notes: string[] }> {
  const key = keyOf(scope, projectId);
  if (files.length > 20) throw new Error("Choose up to 20 files at a time.");
  const ids: string[] = [], notes: string[] = [], uploads: UploadedFile[] = [];
  const failed = new Map<string, string[]>();
  try {
    for (const file of files) {
      set(key, { uploading: `Uploading ${file.name}` });
      const progress = (pct: number) => set(key, { uploading: `${file.name} · ${pct}%` });
      const media = file.type.startsWith("image/") || file.type.startsWith("video/");
      try {
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
      } catch (error) {
        const why = error instanceof Error && error.message ? error.message.replace(/\.$/, "") : "the upload failed";
        failed.set(why, [...(failed.get(why) ?? []), file.name]);
      }
    }
  } finally {
    set(key, { uploading: null });
    if (ids.length) await load(scope, projectId);
  }
  // The same reason once, with every file it stopped.
  for (const [why, names] of failed) notes.push(`${names.join(", ")} could not be uploaded (${why}).`);
  return { ids, uploads, notes };
}

/* ── What a grid of takes shows ───────────────────────────────────────── */

export type LibraryView = {
  /** Aspect-true placeholders while the first read is in flight. */
  skeletons: boolean;
  /**
   * A failed read: "error" when the first read failed and nothing could be shown (every grid's
   * top banner); "stale" when a re-read failed and the cards on screen are the last good read
   * (Gen's banner; the Library and Takes say it at the list's end, beside Load more).
   */
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
export function libraryView(load: Pick<LibraryState, "status" | "error"> & { stale?: boolean } | null, shown: number, projects: "loading" | "ready" | "error" = "ready"): LibraryView {
  if (!load) return projects === "loading" ? { skeletons: shown === 0, banner: null, empty: false } : { skeletons: false, banner: null, empty: projects === "ready" && shown === 0 };
  if (load.status === "error")
    return { skeletons: false, banner: { tone: "error", message: load.error || "The project library could not be loaded." }, empty: false };
  if (load.status !== "ready") return { skeletons: shown === 0, banner: null, empty: false };
  return { skeletons: false, banner: load.stale && load.error ? { tone: "stale", message: load.error } : null, empty: shown === 0 };
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
 * failure, or a take stopped before it rendered; a finished take whose stored
 * copy is not there yet ("Preview unavailable · Refresh"); or the sound /
 * file glyph.
 */
export type EntryFace = "media" | "live" | "held" | "failed" | "stopped" | "unavailable" | "audio" | "file";
export function entryFace(entry: Pick<LibraryEntry, "take" | "asset" | "url" | "media">): EntryFace {
  if (entry.take.status === "failed") return entry.take.cancelled ? "stopped" : "failed";
  if (entry.take.status === "held") return "held";
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

/** One project's library store, as a grid of takes holds it (Gen › Results, Library › Assets, Takes, the Rig). */
export type ProjectLibrary = ReturnType<typeof useProjectLibrary>;

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
  const inFlight = state.status === "ready" && settling(state.generations);
  useEffect(() => (projectId && inFlight ? watch(scope, projectId) : undefined), [scope, projectId, inFlight]);
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
