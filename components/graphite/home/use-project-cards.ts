"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { ProjectSummary } from "@/lib/workspace/data";
import { libraryEntries, type LibraryState } from "@/lib/workspace/library";
import { editedLine, needsLine, renderingByProject, type Needs, type NeedsTone } from "./home-model";

/**
 * Home's project cards, and the phone Home's (stream 10 imports this): one per project, in the list's
 * order (newest save first), with what waits in it. Rendering comes from the jobs tray the header
 * already polls; approvals from stream 8's queue, passed in as counts per project (null until then).
 */
export type ProjectCardModel = {
  id: string;
  name: string;
  meta: string;
  needs: Needs;
  line: { text: string; tone: NeedsTone } | null;
};

export function useProjectCards(projects: readonly ProjectSummary[], now: number, approvalsByProject: ReadonlyMap<string, number> | null = null): ProjectCardModel[] {
  const jobs = useJobsTray()?.jobs;
  return useMemo(() => {
    const rendering = renderingByProject(jobs ?? []);
    return projects.map((p) => {
      const needs: Needs = { approvals: approvalsByProject ? approvalsByProject.get(p.id) ?? 0 : null, rendering: rendering.get(p.id) ?? 0 };
      return { id: p.id, name: p.name, meta: editedLine(p, now), needs, line: needsLine(needs) };
    });
  }, [projects, now, jobs, approvalsByProject]);
}

/* ── Card pictures ─────────────────────────────────────────────────────────
   A card's picture is its project's newest take, else its newest upload: one
   read of one item (the Library's own route, `limit=1`), made when the card
   nears the viewport and kept a minute per workspace and project. */

export type Cover = { url: string; kind: "image" | "video"; name: string };
type CoverState = { cover: Cover | null; at: number; reading: boolean };
const COVER_KEEP_MS = 60_000;
const covers = new Map<string, CoverState>();
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
async function readCover(fetcher: Fetcher, projectId: string): Promise<Cover | null> {
  for (const source of ["generations", "uploads"] as const) {
    const query = new URLSearchParams({ projectId, source, limit: "1" });
    const response = await fetcher("/api/workbench/library?" + query, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const items = Array.isArray(body?.[source]) ? body[source] : [];
    if (!items.length) continue;
    const state = (source === "generations" ? { generations: items, uploads: [] } : { generations: [], uploads: items }) as Pick<LibraryState, "uploads" | "generations">;
    const entry = libraryEntries(state).find((e) => e.url && (e.media === "image" || e.media === "video"));
    /* The newest item only: a take still rendering, or a sound, leaves the swatch rather than reaching further back. */
    return entry ? { url: entry.url!, kind: entry.media as Cover["kind"], name: entry.take.name } : null;
  }
  return null;
}

/** The project's picture, read once `visible`; null while unread or when it has none (the card shows its swatch). */
export function useProjectCover(scope: string, projectId: string, visible: boolean): Cover | null {
  const fetcher = useScopedFetch(scope);
  const key = keyOf(scope, projectId);
  const cover = useSyncExternalStore(subscribe, () => covers.get(key)?.cover ?? null, () => null);
  useEffect(() => {
    if (!visible) return;
    const known = covers.get(key);
    if (known && (known.reading || Date.now() - known.at < COVER_KEEP_MS)) return;
    covers.set(key, { cover: known?.cover ?? null, at: known?.at ?? 0, reading: true });
    void readCover(fetcher, projectId)
      .catch(() => null)
      .then((found) => {
        covers.set(key, { cover: found, at: Date.now(), reading: false });
        listeners.forEach((notify) => notify());
      });
  }, [visible, key, fetcher, projectId]);
  return cover;
}
