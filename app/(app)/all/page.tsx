"use client";

import { useMemo, useState } from "react";
import GenGrid from "@/components/GenGrid";
import { Panel } from "@/components/Panel";
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
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-2.5">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto rounded-[var(--r)] border border-line bg-panel px-2.5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="ptitle shrink-0 text-[11px] tracking-[.08em] text-dim">{scopeName}</span>
        <span className="h-4 w-px shrink-0 bg-line" />
        <div className="relative flex shrink-0 items-center">
          <span className="pointer-events-none absolute left-2 text-mute"><IconSearch /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search prompts" className="ctl w-[220px] pl-7" />
        </div>

        <div className="flex shrink-0 items-center overflow-hidden rounded-[8px] border border-line">
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`h-[30px] border-r border-line px-2.5 font-mono text-[9.5px] uppercase tracking-wider transition-colors last:border-0 ${
                status === s ? "bg-panel3 text-bone" : "bg-desk text-mute hover:text-dim"
              }`}>
              {s === "all" ? "any" : s}
            </button>
          ))}
        </div>

        <button onClick={() => setMine(!mine)}
          className={`h-[30px] shrink-0 rounded-[8px] border px-2.5 font-mono text-[9.5px] uppercase tracking-wider transition-colors ${
            mine ? "border-lift text-lift" : "border-line text-mute hover:text-dim"
          }`}>
          My clips
        </button>

        <span className="ml-auto shrink-0 pl-3 font-mono text-[10px] tracking-wider text-mute">
          {String(gens.length).padStart(3, "0")} CLIPS
          <span className="mx-2 text-line">│</span>
          <span className="text-lift">{usd(spend, 2)}</span>
        </span>
      </div>

      <Panel className="min-h-0 flex-1" bodyClass="overflow-y-auto">
        <GenGrid gens={gens} projects={projects} onChanged={refresh}
          empty="Nothing matches those filters." />
      </Panel>
    </div>
  );
}
