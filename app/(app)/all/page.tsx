"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LibrarySections } from "@/components/GenGrid";
import type { Gen } from "@/components/GenCard";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { usd } from "@/lib/format";
import { IconSearch } from "@/components/Icons";
import { useProject } from "@/lib/projectContext";

const STATUSES = ["all", "succeeded", "running", "queued", "failed"];
const PAGE = 60;

type Page = { generations: Gen[]; nextCursor: number | null };

/**
 * The team's whole output for the current project.
 *
 * Searching and filtering are the SERVER's job here. The browser only ever
 * holds the pages it has asked for, so filtering in the browser would quietly
 * search the newest slice and report that everything older doesn't exist.
 */
export default function LibraryPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");        // debounced, what the server sees
  const [status, setStatus] = useState("all");
  const [mine, setMine] = useState(false);
  const { selection, projects, current } = useProject();

  // Older pages, appended by "Load more". The newest page keeps polling so
  // renders in flight still animate; older pages are static history.
  const [older, setOlder] = useState<Gen[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const scope =
    (selection === "all" || selection === "unfiled" ? "" : `&projectId=${encodeURIComponent(selection)}`) +
    (mine ? "&mine=1" : "") +
    (status !== "all" ? `&status=${status}` : "") +
    (query ? `&q=${encodeURIComponent(query)}` : "");

  const { data, refresh } = useApi<Page>(`/api/jobs?limit=${PAGE}${scope}`, 8000);
  useOnChange(refresh);

  // Any change of scope invalidates the older pages — they belong to the
  // question that was being asked before.
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    setOlder([]);
    setCursor(null);
    setExhausted(false);
  }, [scope]);

  const first = useMemo(() => data?.generations ?? [], [data]);

  const gens = useMemo(() => {
    const seen = new Set<string>();
    const out: Gen[] = [];
    for (const g of [...first, ...older]) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(g);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }, [first, older]);

  const nextCursor = cursor ?? data?.nextCursor ?? null;
  const canLoadMore = !exhausted && nextCursor != null;

  async function loadMore() {
    if (!canLoadMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/jobs?limit=${PAGE}&sync=0&before=${nextCursor}${scope}`, { cache: "no-store" });
      const page: Page = await res.json();
      if (!res.ok) throw new Error("Could not load more");
      setOlder((prev) => [...prev, ...(page.generations ?? [])]);
      setCursor(page.nextCursor);
      if (!page.nextCursor || !page.generations?.length) setExhausted(true);
    } catch {
      /* Deliberately NOT setExhausted: one failed page used to retire the
         button for good, hiding the rest of the library behind a reload.
         Leave it pressable so they can simply try again. */
    } finally {
      setLoadingMore(false);
    }
  }

  const spend = gens.reduce((a, g) => a + (g.costUsd ?? 0) + (g.refineCostUsd ?? 0), 0);
  const scopeName =
    selection === "all" ? "All projects" : selection === "unfiled" ? "Unfiled" : current?.name ?? "";

  // "Unfiled" is a client-side view of the all-projects listing.
  const shown = selection === "unfiled" ? gens.filter((g) => !g.projectId) : gens;

  return (
    <div className="screen"><div className="mx-auto w-full max-w-[1120px]">
      <div className="flex flex-wrap items-end gap-3 pt-6">
        <span className="flex flex-col gap-0.5">
          <span className="h1">Library</span>
          <span className="mt-1 text-[15px] text-dim">
            {scopeName} · showing {shown.length}
            {canLoadMore ? "+" : ""} render{shown.length === 1 ? "" : "s"} ·{" "}
            <span className="text-lift">{usd(spend, 2)}</span>
          </span>
        </span>
        <span className="ml-auto" />
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-3.5 text-mute"><IconSearch /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search every prompt" className="h-[42px] w-[240px] rounded-[12px] bg-panel2 pl-10 pr-4 text-[15px] text-bone placeholder:text-mute focus:bg-panel focus:outline-none" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`rounded-full border px-3.5 py-[6px] text-[13.5px] font-medium capitalize transition-colors ${
              status === s
                ? "border-transparent bg-blue text-white"
                : "border-transparent bg-chip text-dim hover:bg-chip2"
            }`}>
            {s === "all" ? "All" : s}
          </button>
        ))}
        <span className="h-4 w-px bg-line" />
        <button onClick={() => setMine(!mine)}
          className={`rounded-full border px-3.5 py-[6px] text-[13.5px] font-medium transition-colors ${
            mine
              ? "border-transparent bg-blue text-white"
              : "border-transparent bg-chip text-dim hover:bg-chip2"
          }`}>
          My clips
        </button>
      </div>

      <div className="mt-5">
        <LibrarySections gens={shown} projects={projects} onChanged={refresh}
          empty={query ? `Nothing matches “${query}”.` : "Nothing matches those filters."} />
      </div>

      {canLoadMore && (
        <div className="mt-8 flex justify-center">
          <button onClick={loadMore} disabled={loadingMore}
            className="chip !py-2.5 px-5 font-medium disabled:opacity-50">
            {loadingMore ? "Loading…" : "Load older renders"}
          </button>
        </div>
      )}
    </div>
    </div>
  );
}
