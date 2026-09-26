"use client";
import { useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { Project } from "@/lib/workbench/studio";

/** A stage that was just left saves what was pending as it goes (its editor flushes on unmount); this read follows it. */
export const FRESH_FOLLOW_UP_MS = 1500;

/**
 * The last full read, by project and revision: the list read (ids and
 * revisions only) says whether it is still the saved copy, so an unchanged
 * project is never downloaded twice.
 */
let saved: { id: string; revision: number; project: Project } | null = null;
/** What a list read decides: the saved copy still stands, or the project must be read in full. */
export function freshRead(id: string, listed: { id?: unknown; revision?: unknown }[] | undefined, known: typeof saved): "known" | "read" {
  const row = listed?.find((p) => p.id === id);
  return known && known.id === id && typeof row?.revision === "number" && row.revision === known.revision ? "known" : "read";
}
/** A fresh copy stands only over the shell copy it was read against; once the shell holds a newer one, the shell's wins. */
export function freshOver(fresh: { base: Project | null; value: Project } | null, shell: Project | null): Project | null {
  return fresh && shell && fresh.base === shell && fresh.value.id === shell.id ? fresh.value : shell;
}

/**
 * The project as it is saved now, for the phone's Home and Studio grid. The
 * shell reads a project once when it is chosen, while every stage edits its
 * own draft, so its copy goes stale the moment the brief is written or the
 * beats broken down. These screens check it when they open (and once more
 * just after, for the stage's last save), and whenever the tab comes back
 * into view: a light list read of revisions, and the full project only when
 * its revision moved. Until then, and on any failure, the shell's copy
 * stands.
 */
export function useFreshProject(project: Project | null): Project | null {
  const scoped = useScopedFetch();
  const [fresh, setFresh] = useState<{ base: Project | null; value: Project } | null>(null);
  const shell = useRef(project);
  useEffect(() => { shell.current = project; });
  const id = project?.id ?? null;
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      const base = shell.current;
      try {
        const list = await scoped("/api/workbench/projects", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)) as { projects?: { id?: unknown; revision?: unknown }[] } | null;
        if (!live) return;
        const known = saved;
        if (list && known && freshRead(id, list.projects, known) === "known") { setFresh({ base, value: known.project }); return; }
        const body = await scoped(`/api/workbench/projects?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)) as { project?: Project | null; revision?: unknown } | null;
        if (!live || body?.project?.id !== id) return;
        saved = { id, revision: typeof body.revision === "number" ? body.revision : -1, project: body.project };
        setFresh({ base, value: body.project });
      } catch { /* the shell's copy stands */ }
    };
    const first = setTimeout(() => void read(), 0);
    const again = setTimeout(() => void read(), FRESH_FOLLOW_UP_MS);
    const shown = () => void read();
    document.addEventListener("visibilitychange", shown);
    return () => { live = false; clearTimeout(first); clearTimeout(again); document.removeEventListener("visibilitychange", shown); };
  }, [id, scoped]);
  return freshOver(fresh, project);
}
