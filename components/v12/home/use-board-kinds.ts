"use client";
import { useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/workspace/data";
import { useScopedFetch } from "@/lib/useScopedFetch";

type Kind = NonNullable<ProjectSummary["kind"]>;

/**
 * Each board's kind, for Your boards' filters: the list read once more with `?kinds=1` (the route reads each draft's
 * kind only when asked, so today's list reads stay as cheap as they were). Read again when the list changes.
 */
export function useBoardKinds(scope: string, projects: readonly ProjectSummary[]): ReadonlyMap<string, Kind> {
  const fetcher = useScopedFetch(scope);
  const [kinds, setKinds] = useState<ReadonlyMap<string, Kind>>(new Map());
  const key = projects.map((p) => `${p.id}:${p.revision ?? ""}`).join(",");
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    fetcher("/api/workbench/projects?kinds=1", { cache: "no-store", signal: controller.signal })
      .then(async (r) => (r.ok ? ((await r.json()) as { projects?: ProjectSummary[] }) : null))
      .then((body) => {
        if (controller.signal.aborted || !Array.isArray(body?.projects)) return;
        const next = new Map<string, Kind>();
        for (const p of body.projects) if (p.kind === "studio" || p.kind === "ads" || p.kind === "social") next.set(p.id, p.kind);
        setKinds(next);
      })
      .catch(() => { /* the filters treat an unread board as a film until the next read */ });
    return () => controller.abort();
  }, [fetcher, key]);
  return kinds;
}
