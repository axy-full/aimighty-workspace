"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import GenGrid from "@/components/GenGrid";
import { Panel } from "@/components/Panel";
import type { Gen } from "@/components/GenCard";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { IconSearch, IconLibrary, IconBins, IconFilm } from "@/components/Icons";

type Project = { id: string; name: string; genCount: number; spend: number };
const STATUSES = ["all", "succeeded", "running", "queued", "failed"];

export default function LibraryPage() {
  const [q, setQ] = useState("");
  const [bin, setBin] = useState("all");
  const [status, setStatus] = useState("all");

  const { data: pj } = useApi<{ projects: Project[] }>("/api/projects");
  const query = bin === "all" || bin === "unfiled" ? "" : `&projectId=${encodeURIComponent(bin)}`;
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=500${query}`, 8000);

  const projects = pj?.projects ?? [];
  const gens = useMemo(() => {
    let out = data?.generations ?? [];
    if (bin === "unfiled") out = out.filter((g) => !g.projectId);
    if (status !== "all") out = out.filter((g) => g.status === status);
    if (q.trim()) {
      const n = q.toLowerCase();
      out = out.filter((g) => g.prompt.toLowerCase().includes(n));
    }
    return out;
  }, [data, q, status, bin]);

  const spend = gens.reduce((a, g) => a + (g.costUsd ?? 0), 0);

  return (
    <div className="bench-flat">
      {/* Media pool */}
      <Panel title="Media pool" className="border-0" bodyClass="overflow-y-auto"
        right={<Link href="/projects" className="font-mono text-[9px] tracking-wider text-mute hover:text-lift">EDIT</Link>}>
        <ul className="py-1">
          <PoolRow label="All clips" icon={<IconLibrary className="!h-3.5 !w-3.5" />}
            active={bin === "all"} onClick={() => setBin("all")} />
          <PoolRow label="Unfiled" icon={<IconFilm className="!h-3.5 !w-3.5" />}
            active={bin === "unfiled"} onClick={() => setBin("unfiled")} />
          <li className="lbl px-2.5 pb-1 pt-3">Bins</li>
          {projects.map((p) => (
            <PoolRow key={p.id} label={p.name} icon={<IconBins className="!h-3.5 !w-3.5" />}
              active={bin === p.id} onClick={() => setBin(p.id)} count={p.genCount} spend={p.spend} />
          ))}
        </ul>
      </Panel>

      {/* Grid */}
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-chrome px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="relative flex shrink-0 items-center">
            <span className="pointer-events-none absolute left-2 text-mute"><IconSearch /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search prompts" className="ctl w-[220px] pl-7" />
          </div>

          <div className="flex shrink-0 items-center overflow-hidden rounded-[8px] border border-line">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`h-[28px] border-r border-line px-2.5 font-mono text-[9.5px] uppercase tracking-wider transition-colors last:border-0 ${
                  status === s ? "bg-panel3 text-bone" : "bg-desk text-mute hover:text-dim"
                }`}>
                {s === "all" ? "any" : s}
              </button>
            ))}
          </div>

          <span className="ml-auto shrink-0 pl-3 font-mono text-[10px] tracking-wider text-mute">
            {String(gens.length).padStart(3, "0")} CLIPS
            <span className="mx-2 text-line">│</span>
            <span className="text-lift">{usd(spend, 2)}</span>
          </span>
        </div>

        <Panel className="min-h-0 flex-1 border-0" bodyClass="overflow-y-auto">
          <GenGrid gens={gens} projects={projects} onChanged={refresh}
            empty="Nothing matches those filters." />
        </Panel>
      </div>
    </div>
  );
}

function PoolRow({ label, icon, active, onClick, count, spend }: {
  label: string; icon: React.ReactNode; active: boolean; onClick: () => void;
  count?: number; spend?: number;
}) {
  return (
    <li>
      <button onClick={onClick}
        className={`flex w-full items-center gap-2 px-2.5 py-[6px] text-left transition-colors ${
          active ? "bg-panel3 text-bone" : "text-dim hover:bg-panel2"
        }`}>
        <span className={active ? "text-lift" : "text-mute"}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
        {count != null && (
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-mute">
            {String(count).padStart(2, "0")}
          </span>
        )}
        {spend != null && spend > 0 && (
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-lift">{usd(spend, 2)}</span>
        )}
      </button>
    </li>
  );
}
