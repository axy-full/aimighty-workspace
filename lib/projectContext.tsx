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
 */

export type Project = {
  id: string; name: string; description: string; code?: string;
  createdAt: number; genCount: number; spend: number;
  capUsd?: number | null; kind?: string | null; runtimeTarget?: number | null; stage?: string | null;
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
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}
function readStored() {
  try { return localStorage.getItem(KEY) ?? "all"; } catch { return "all"; }
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const stored = useSyncExternalStore(subscribe, readStored, () => "all");
  const { data, refresh } = useApi<{ projects: Project[] }>("/api/projects", 30000);
  const projects = useMemo(() => data?.projects ?? [], [data]);

  // A deleted project can't stay selected — derive the fallback rather than
  // writing state back, so there's no effect and no cascade.
  const selection =
    stored === "all" || stored === "unfiled" || !data || projects.some((p) => p.id === stored)
      ? stored
      : "all";

  function setSelection(v: string) {
    try { localStorage.setItem(KEY, v); } catch { /* fine */ }
    listeners.forEach((l) => l());
  }

  const current = projects.find((p) => p.id === selection) ?? null;

  return (
    <ProjectCtx.Provider value={{ selection, setSelection, projects, current, refreshProjects: refresh }}>
      {children}
    </ProjectCtx.Provider>
  );
}

export function useProject(): Ctx {
  const ctx = useContext(ProjectCtx);
  if (!ctx) throw new Error("useProject outside ProjectProvider");
  return ctx;
}
