"use client";

import { useMemo, useState } from "react";
import { LibrarySections } from "@/components/GenGrid";
import type { Gen } from "@/components/GenCard";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { IconSearch } from "@/components/Icons";
import { useProject } from "@/lib/projectContext";

const STATUSES = ["all", "succeeded", "running", "queued", "failed"];

/** The team's whole output for the current project — searchable, filterable.
 *  Which project is showing is the title-bar switcher's job, not a second
 *  sidebar's. */
export default function LibraryPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [mine, setMine] = useState(false);
  const { selection, projects, current } = useProject();

  const query =
    (selection === "all" || selection === "unfiled" ? "" : `&projectId=${encodeURIComponent(selection)}`) +
    (mine ? "&mine=1" : "");
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=500${query}`, 8000);

  const gens = useMemo(() => {
    let out = data?.generations ?? [];
    if (selection === "unfiled") out = out.filter((g) => !g.projectId);
    if (status !== "all") out = out.filter((g) => g.status === status);
    if (q.trim()) {
      const n = q.toLowerCase();
      out = out.filter((g) => g.prompt.toLowerCase().includes(n));
    }
    return out;
  }, [data, q, status, selection]);

  const spend = gens.reduce((a, g) => a + (g.costUsd ?? 0), 0);
  const scopeName =
    selection === "all" ? "All projects" : selection === "unfiled" ? "Unfiled" : current?.name ?? "";

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5 max-[860px]:px-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="ptitle text-[20px] leading-tight">Library</span>
          <span className="text-[12px] text-dim">
            {scopeName} · {gens.length} render{gens.length === 1 ? "" : "s"} ·{" "}
            <span className="text-lift">{usd(spend, 2)}</span>
          </span>
        </span>
        <span className="ml-auto" />
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-2.5 text-mute"><IconSearch /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search generations" className="ctl w-[210px] pl-8" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-[5px] text-[12px] font-medium capitalize transition-colors ${
              status === s
                ? "border-transparent bg-red text-white"
                : "border-line bg-chip text-dim hover:bg-chip2"
            }`}>
            {s === "all" ? "All" : s}
          </button>
        ))}
        <span className="h-4 w-px bg-line" />
        <button onClick={() => setMine(!mine)}
          className={`rounded-full border px-3 py-[5px] text-[12px] font-medium transition-colors ${
            mine
              ? "border-transparent bg-red text-white"
              : "border-line bg-chip text-dim hover:bg-chip2"
          }`}>
          My clips
        </button>
      </div>

      <div className="mt-5">
        <LibrarySections gens={gens} projects={projects} onChanged={refresh}
          empty="Nothing matches those filters." />
      </div>
    </div>
  );
}
