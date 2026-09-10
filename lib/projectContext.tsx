"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useApi } from "./useApi";

/**
 * The one answer to "which project am I in?".
 *
 * Bins, the Library sidebar and the Compose strip dropdown were three
 * different controls for the same question. Now it's a single title-bar
 * switcher: the filmstrip scopes to it, the Library scopes to it, and new
 * renders file into it. 'all' and 'unfiled' are pseudo-projects.
 *
 * Persisted in localStorage through useSyncExternalStore — the server
 * snapshot says 'all', the client snapshot reads storage, and React
 * reconciles after hydration without a mismatch.
 *
 * THE CHOICE IS THIS TAB'S, not this browser's. Storage is where it is
 * remembered between visits; it is not a channel between open tabs. It used
 * to be both — `subscribe` listened for the cross-tab `storage` event and
 * the snapshot re-read localStorage — and two consequences followed.
 *
 * The visible one: two canvases open on different productions deadlocked.
 * Each page insists the switcher follows the production it is about
 * (projects/[id]/canvas), so tab A wrote X, tab B was told, tab B wrote Y,
 * tab A was told, for ever — 73 requests to each of three endpoints in 1.2
 * seconds, until the browser began refusing new ones outright.
 *
 * The one that actually matters: this selection is what a render FILES
 * INTO (`projectId` in the generate payload). Sharing it across tabs meant
 * opening one production's canvas silently retargeted a composer sitting in
 * another tab, and the next take — and its cost — landed on a production
 * nobody had chosen for it. A tab is a window onto one production; two
 * windows may look at two different things.
 */

export type Project = {
  id: string; name: string; description: string; code?: string;
  createdAt: number; genCount: number; spend: number; credits?: number;
  capUsd?: number | null; capCredits?: number | null; capUnlocked?: boolean; starter?: boolean; kind?: string | null; runtimeTarget?: number | null; stage?: string | null;
  /** §15's project (design/particl-v2): the production it belongs to, its format, its step. */
  productionId?: string | null; format?: string; step?: number;
};

type Ctx = {
  selection: string; // 'all' | 'unfiled' | project id
  setSelection: (v: string) => void;
  projects: Project[];
  current: Project | null;
  refreshProjects: () => void;
};

const ProjectCtx = createContext<Ctx | null>(null);

const KEY = "aw_project";
const listeners = new Set<() => void>();

/**
 * This tab's chosen production, read from storage once and held here after.
 *
 * Holding it is the point. `getSnapshot` runs on every render, so a snapshot
 * that read localStorage each time would pick up another tab's choice at the
 * next render whether or not anyone listened for the `storage` event —
 * dropping the listener alone would not have made tabs independent.
 */
let chosen: string | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function readStored(): string {
  // Empty means never chosen: a new workspace then opens on its starter production.
  if (chosen === null) {
    try { chosen = localStorage.getItem(KEY) ?? ""; } catch { chosen = ""; }
  }
  return chosen;
}

/** Module-level, so it is one stable identity for every consumer's deps. */
function choose(v: string) {
  // Re-announcing the same choice is what let two pages talk past each other.
  if (chosen === v) return;
  chosen = v;
  try { localStorage.setItem(KEY, v); } catch { /* fine */ }
  listeners.forEach((l) => l());
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const stored = useSyncExternalStore(subscribe, readStored, () => "");
  const { data, refresh } = useApi<{ projects: Project[] }>("/api/projects", 30000);
  const projects = useMemo(() => data?.projects ?? [], [data]);

  // A deleted project can't stay selected — derive the fallback rather than
  // writing state back, so there's no effect and no cascade.
  const starter = projects.find((p) => p.starter)?.id ?? null;
  const selection =
    stored === "" ? (starter ?? "all")
    : stored === "all" || stored === "unfiled" || !data || projects.some((p) => p.id === stored)
      ? stored
      : "all";

  const current = projects.find((p) => p.id === selection) ?? null;

  /* Memoised, and `choose` is module-level, so the value only changes when
     something in it actually changed. It used to be a fresh object with a
     fresh `setSelection` on every render, which put a new identity into the
     deps of every effect that watches this context — including the canvas
     effect at the other end of the deadlock. */
  const value = useMemo(
    () => ({ selection, setSelection: choose, projects, current, refreshProjects: refresh }),
    [selection, projects, current, refresh],
  );

  return <ProjectCtx.Provider value={value}>{children}</ProjectCtx.Provider>;
}

export function useProject(): Ctx {
  const ctx = useContext(ProjectCtx);
  if (!ctx) throw new Error("useProject outside ProjectProvider");
  return ctx;
}
