"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import logo from "@/public/aimighty-logo.png";
import { useProject } from "@/lib/projectContext";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { UserMenu } from "./NavRail";

const TITLE: Record<string, string> = {
  "/": "Compose", "/all": "Library", "/usage": "Usage", "/team": "Team",
};

type U = { name: string; email: string; role: string };
type Usage = { pending: number };

/** The design's 54px top bar: where you are, which project you're in,
 *  and whether anything is rendering right now. */
export default function TitleBar({ user }: { user: U }) {
  const path = usePathname();
  const [projOpen, setProjOpen] = useState(false);
  const { selection, setSelection, projects, current, refreshProjects } = useProject();
  const { data: usage } = useApi<Usage>("/api/usage", 20000);

  const projLabel =
    selection === "all" ? "All projects" : selection === "unfiled" ? "Unfiled" : current?.name ?? "All projects";

  async function newProject() {
    const name = prompt("Project name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) { setSelection(json.id); refreshProjects(); }
    setProjOpen(false);
  }

  async function renameCurrent() {
    if (!current) return;
    const name = prompt("Rename project", current.name);
    if (!name?.trim() || name === current.name) return;
    await fetch(`/api/projects/${current.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    refreshProjects();
  }

  async function deleteCurrent() {
    if (!current) return;
    if (!confirm(`Delete "${current.name}"? Its clips move to Unfiled — nothing is lost.`)) return;
    await fetch(`/api/projects/${current.id}`, { method: "DELETE" });
    setSelection("all");
    refreshProjects();
    setProjOpen(false);
  }

  return (
    <header className="app-title relative flex items-center gap-3 border-b border-line px-5 max-[860px]:px-3.5">
      {/* Phones have no rail — the mark stands in for it. */}
      <Link href="/" className="hidden shrink-0 items-center max-[860px]:flex">
        <Image src={logo} alt="aimighty" priority
          className="h-[12px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
      </Link>

      <span className="ptitle shrink-0 text-[15px] max-[860px]:hidden">{TITLE[path] ?? ""}</span>
      <span className="h-4 w-px shrink-0 bg-line max-[860px]:hidden" />

      {/* Project switcher — the single "where am I working" control. */}
      <div className="relative min-w-0">
        <button
          onClick={() => setProjOpen(!projOpen)}
          className="chip max-w-full !gap-2 !py-1.5 !text-[12.5px] !text-dim"
        >
          <span className="h-2 w-2 shrink-0 rounded-[3px] bg-red" />
          <span className="min-w-0 truncate">{projLabel}</span>
          <svg width="8" height="6" viewBox="0 0 8 6" className="shrink-0">
            <path d="M1 1.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </button>

        {projOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setProjOpen(false)} />
            <div className="absolute left-0 top-[calc(100%+8px)] z-50 w-[248px] overflow-hidden rounded-[11px] border border-line bg-panel2 shadow-[var(--shadow)]">
              <div className="max-h-[300px] overflow-y-auto p-1">
                {[{ id: "all", name: "All projects" }, { id: "unfiled", name: "Unfiled" }].map((row) => (
                  <button key={row.id}
                    onClick={() => { setSelection(row.id); setProjOpen(false); }}
                    className={`menu-item ${selection === row.id ? "text-lift" : "text-dim"}`}>
                    {row.name}
                  </button>
                ))}
                {projects.length > 0 && <div className="mx-2 my-1 h-px bg-hair" />}
                {projects.map((pr) => (
                  <button key={pr.id}
                    onClick={() => { setSelection(pr.id); setProjOpen(false); }}
                    className={`menu-item ${selection === pr.id ? "text-lift" : "text-dim"}`}>
                    <span className="min-w-0 flex-1 truncate">{pr.name}</span>
                    <span className="shrink-0 font-mono text-[9px] text-mute">
                      {pr.genCount} · {usd(pr.spend, 2)}
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-hair p-1">
                <button onClick={newProject} className="menu-item text-dim hover:text-bone">
                  ＋ New project
                </button>
                {current && (
                  <div className="flex gap-2 px-2.5 pb-1.5 pt-0.5">
                    <button onClick={renameCurrent} className="font-mono text-[9.5px] tracking-wider text-mute hover:text-lift">RENAME</button>
                    <span className="text-mute/40">·</span>
                    <button onClick={deleteCurrent} className="font-mono text-[9.5px] tracking-wider text-mute hover:text-lift">DELETE</button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        {usage != null && usage.pending > 0 && (
          <span className="flex items-center gap-2 rounded-full bg-chip px-3 py-1.5 text-[11.5px] text-dim">
            <span className="lamp lamp-live text-lift" style={{ width: 7, height: 7 }} />
            Rendering · {usage.pending}
          </span>
        )}
        {/* The rail carries the account on desktop; phones get it here. */}
        <span className="hidden max-[860px]:block">
          <UserMenu user={user} />
        </span>
      </div>
    </header>
  );
}
