"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import logo from "@/public/aimighty-logo.png";
import { useProject } from "@/lib/projectContext";
import { usd } from "@/lib/format";

const CRUMB: Record<string, string> = {
  "/": "compose", "/all": "library", "/usage": "usage", "/team": "team",
};

type U = { name: string; email: string; role: string };

export default function TitleBar({ user }: { user: U }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  const { selection, setSelection, projects, current, refreshProjects } = useProject();

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

  const crumb = CRUMB[path] ?? path.replace(/^\//, "");

  const initials = user.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="app-title relative flex items-center gap-3 border-b border-line bg-chrome px-3">
      {/* Brand red is 2.1:1 on near-black — lift the mark so it reads. */}
      <Link href="/" title="Compose" className="group flex items-center gap-3">
        <Image src={logo} alt="aimighty" priority
          className="h-[15px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
        <span className="ptitle text-[11px] tracking-[.16em] text-mute transition-colors group-hover:text-dim">
          WORKSPACE
        </span>
      </Link>

      <span className="h-4 w-px bg-line" />

      {/* Project switcher — the single "where am I working" control. */}
      <div className="relative">
        <button
          onClick={() => setProjOpen(!projOpen)}
          className="flex items-center gap-1.5 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[12px] text-bone transition-colors hover:border-lift/60"
        >
          <span className="max-w-[180px] truncate">{projLabel}</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-mute">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {projOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setProjOpen(false)} />
            <div className="absolute left-0 top-[34px] z-50 w-[248px] overflow-hidden rounded-[10px] border border-line bg-panel shadow-2xl">
              <div className="max-h-[300px] overflow-y-auto py-1">
                {[{ id: "all", name: "All projects" }, { id: "unfiled", name: "Unfiled" }].map((row) => (
                  <button key={row.id}
                    onClick={() => { setSelection(row.id); setProjOpen(false); }}
                    className={`block w-full px-3 py-1.5 text-left text-[12.5px] ${selection === row.id ? "text-lift" : "text-dim hover:bg-panel2"}`}>
                    {row.name}
                  </button>
                ))}
                {projects.length > 0 && <div className="mx-3 my-1 h-px bg-hair" />}
                {projects.map((pr) => (
                  <button key={pr.id}
                    onClick={() => { setSelection(pr.id); setProjOpen(false); }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${selection === pr.id ? "text-lift" : "text-dim hover:bg-panel2"}`}>
                    <span className="min-w-0 flex-1 truncate">{pr.name}</span>
                    <span className="shrink-0 font-mono text-[9px] text-mute">
                      {pr.genCount} · {usd(pr.spend, 2)}
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-hair p-1.5">
                <button onClick={newProject}
                  className="block w-full rounded-[6px] px-2 py-1.5 text-left text-[12px] text-dim hover:bg-panel2 hover:text-lift">
                  ＋ New project
                </button>
                {current && (
                  <div className="mt-0.5 flex gap-1.5 px-2 pb-1">
                    <button onClick={renameCurrent} className="font-mono text-[9.5px] tracking-wider text-mute hover:text-lift">RENAME</button>
                    <span className="text-line">·</span>
                    <button onClick={deleteCurrent} className="font-mono text-[9.5px] tracking-wider text-mute hover:text-lift">DELETE</button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <span className="hidden font-mono text-[10.5px] tracking-wide text-dim md:block">~/{crumb}</span>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden font-mono text-[10px] tracking-wider text-mute xl:block">
          MODELARK · AP-SOUTHEAST
        </span>
        <span className="hidden h-4 w-px bg-line xl:block" />
        <span className="hidden items-center gap-1.5 font-mono text-[10px] tracking-wider text-ok sm:flex">
          <span className="lamp lamp-live" />READY
        </span>
        <span className="h-4 w-px bg-line" />

        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 transition-colors hover:bg-panel2"
          title={`${user.name} · ${user.email}`}
        >
          <span className="grid h-[20px] w-[20px] place-items-center rounded-full bg-panel3 font-mono text-[9px] text-bone">
            {initials}
          </span>
          <span className="hidden font-mono text-[10px] text-dim md:block">{user.name}</span>
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-2 top-[38px] z-50 w-[212px] border border-line bg-panel shadow-xl">
            <div className="border-b border-line px-3 py-2.5">
              <p className="truncate text-[12px] text-bone">{user.name}</p>
              <p className="truncate font-mono text-[9.5px] text-mute">{user.email}</p>
              <p className="lbl mt-1.5">{user.role}</p>
            </div>
            {user.role === "admin" && (
              <button
                onClick={() => { setOpen(false); router.push("/team"); }}
                className="w-full px-3 py-2 text-left font-mono text-[10.5px] tracking-wider text-dim hover:bg-panel2 hover:text-lift"
              >
                TEAM &amp; INVITES
              </button>
            )}
            <button
              onClick={signOut} disabled={busy}
              className="w-full px-3 py-2 text-left font-mono text-[10.5px] tracking-wider text-dim hover:bg-panel2 hover:text-lift"
            >
              {busy ? "SIGNING OUT…" : "SIGN OUT"}
            </button>
          </div>
        </>
      )}
    </header>
  );
}
