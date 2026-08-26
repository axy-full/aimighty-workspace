"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, timeAgo } from "@/lib/format";
import { Panel } from "@/components/Panel";
import { IconPlus, IconBins } from "@/components/Icons";

type Project = {
  id: string; name: string; description: string;
  createdAt: number; genCount: number; spend: number;
};

export default function BinsPage() {
  const { data, refresh } = useApi<{ projects: Project[] }>("/api/projects");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not create the bin");
      setName(""); setDesc("");
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const projects = data?.projects ?? [];
  const total = projects.reduce((a, p) => a + p.spend, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-chrome px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <input
          className="ctl w-[200px] shrink-0" value={name} placeholder="Bin name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <input
          className="ctl w-[280px] shrink-0" value={desc} placeholder="Description (optional)"
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button
          onClick={create} disabled={busy || !name.trim()}
          className="ptitle flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-red px-3 text-[10.5px] tracking-[.1em] text-white transition-colors hover:bg-lift disabled:bg-panel3 disabled:text-mute"
        >
          <IconPlus /> New bin
        </button>

        {err && <span className="shrink-0 font-mono text-[9.5px] text-lift">{err}</span>}
        <span className="ml-auto shrink-0 pl-3 font-mono text-[10px] tracking-wider text-mute">
          {String(projects.length).padStart(2, "0")} BINS
          <span className="mx-2 text-line">│</span>
          <span className="text-lift">{usd(total, 2)}</span>
        </span>
      </div>

      <Panel className="min-h-0 flex-1 border-0" bodyClass="overflow-y-auto">
        {projects.length === 0 ? (
          <div className="desk-grid grid h-full min-h-[240px] place-items-center">
            <p className="font-mono text-[10.5px] tracking-[.14em] text-mute">
              No bins — create one above.
            </p>
          </div>
        ) : (
          <div className="grid gap-2.5 p-2.5 [grid-template-columns:repeat(auto-fill,minmax(272px,1fr))]">
            {projects.map((p) => (
              <Link
                key={p.id} href={`/projects/${p.id}`}
                className="group flex flex-col border border-line bg-panel transition-colors hover:border-lift/60"
              >
                <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-line bg-panel2 px-2 text-mute group-hover:text-lift">
                  <IconBins className="!h-3 !w-3" />
                  <span className="font-mono text-[9.5px] tracking-wider">BIN</span>
                  <span className="ml-auto font-mono text-[9.5px] text-mute">{timeAgo(p.createdAt)}</span>
                </div>

                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <h2 className="ptitle text-[14px] leading-tight text-bone group-hover:text-lift">
                    {p.name}
                  </h2>
                  {p.description && (
                    <p className="line-clamp-2 text-[12px] leading-relaxed text-dim">{p.description}</p>
                  )}
                  <div className="mt-auto flex items-center gap-3 border-t border-hair pt-2 font-mono text-[9.5px] text-mute">
                    <span>{String(p.genCount).padStart(2, "0")} CLIPS</span>
                    <span className="ml-auto text-lift">{usd(p.spend, 2)}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
