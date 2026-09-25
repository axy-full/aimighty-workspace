"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { Project } from "@/lib/workbench/studio";

/** A stage that was just left saves what was pending as it goes (its editor flushes on unmount); this read follows it. */
export const FRESH_FOLLOW_UP_MS = 1500;

/**
 * The project as it is saved now, for the phone's Home and Studio grid. The
 * shell reads a project once when it is chosen, while every stage edits its
 * own draft, so its copy goes stale the moment the brief is written or the
 * beats broken down. These screens read it again when they open (and once
 * more just after, for the stage's last save), and whenever the tab comes
 * back into view. Until then, and on any failure, the shell's copy stands.
 */
export function useFreshProject(project: Project | null): Project | null {
  const scoped = useScopedFetch();
  const [fresh, setFresh] = useState<Project | null>(null);
  const id = project?.id ?? null;
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () => {
      if (document.visibilityState === "hidden") return;
      void scoped(`/api/workbench/projects?id=${encodeURIComponent(id)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { project?: Project | null } | null) => { if (live && body?.project?.id === id) setFresh(body.project); })
        .catch(() => { /* the shell's copy stands */ });
    };
    read();
    const again = setTimeout(read, FRESH_FOLLOW_UP_MS);
    document.addEventListener("visibilitychange", read);
    return () => { live = false; clearTimeout(again); document.removeEventListener("visibilitychange", read); };
  }, [id, scoped]);
  return fresh && fresh.id === id ? fresh : project;
}
