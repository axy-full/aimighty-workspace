"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useProject } from "@/lib/projectContext";
import { usd } from "@/lib/format";
import { IconBins, IconLibrary, IconFilm, IconPlus, IconClose } from "./Icons";

/**
 * The left drawer: every project at a glance. Clicking one selects it
 * app-wide and opens its media pool (the Library scoped to it). Mirror of
 * the chat dock — slim rail collapsed, panel expanded, remembered per
 * browser.
 */

const OPEN_KEY = "aw_pool_open";
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}
function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

export default function ProjectDrawer() {
  const open = useSyncExternalStore(subscribe, readOpen, () => false);
  const { selection, setSelection, projects, refreshProjects } = useProject();
  const router = useRouter();
  const pathname = usePathname();

  function toggle(next: boolean) {
    try { localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* fine */ }
    listeners.forEach((l) => l());
  }

  /** Select the project and land in its media pool. */
  function openPool(id: string) {
    setSelection(id);
    if (pathname !== "/all") router.push("/all");
  }

  async function newProject() {
    const name = prompt("Project name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) { refreshProjects(); openPool(json.id); }
  }

  if (!open) {
    return (
      <button
        onClick={() => toggle(true)}
        title="Projects"
        className="flex h-full w-[30px] shrink-0 flex-col items-center gap-2 border-r border-line bg-chrome pt-3 text-mute transition-colors hover:text-lift"
      >
        <IconBins className="!h-[15px] !w-[15px]" />
        <span className="lbl rotate-180 [writing-mode:vertical-rl]">PROJECTS</span>
      </button>
    );
  }

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-chrome max-[1100px]:fixed max-[1100px]:bottom-[var(--switcher)] max-[1100px]:left-0 max-[1100px]:top-[var(--titlebar)] max-[1100px]:z-40 max-[1100px]:h-auto max-[1100px]:shadow-[12px_0_32px_rgba(0,0,0,.5)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-hair bg-panel2 px-3">
        <h2 className="ptitle text-[10.5px] tracking-[.1em] text-dim">PROJECTS</h2>
        <button onClick={() => toggle(false)} title="Collapse"
          className="ml-auto grid h-[20px] w-[20px] place-items-center rounded-[6px] text-mute hover:text-lift">
          <IconClose />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        <DrawerRow
          icon={<IconLibrary className="!h-3.5 !w-3.5" />} label="All clips"
          active={selection === "all"} onClick={() => openPool("all")}
        />
        <DrawerRow
          icon={<IconFilm className="!h-3.5 !w-3.5" />} label="Unfiled"
          active={selection === "unfiled"} onClick={() => openPool("unfiled")}
        />

        <p className="lbl px-3 pb-1 pt-3 text-mute/70">Projects</p>
        {projects.length === 0 && (
          <p className="px-3 py-2 text-[11.5px] leading-relaxed text-mute">
            No projects yet — make one and renders will file into it.
          </p>
        )}
        {projects.map((p) => (
          <DrawerRow
            key={p.id}
            icon={<IconBins className="!h-3.5 !w-3.5" />}
            label={p.name}
            meta={`${String(p.genCount).padStart(2, "0")} · ${usd(p.spend, 2)}`}
            active={selection === p.id}
            onClick={() => openPool(p.id)}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-hair p-2">
        <button onClick={newProject}
          className="flex w-full items-center gap-1.5 rounded-[8px] px-2.5 py-2 text-left text-[12px] text-dim transition-colors hover:bg-panel2 hover:text-lift">
          <IconPlus /> New project
        </button>
      </div>
    </aside>
  );
}

function DrawerRow({ icon, label, meta, active, onClick }: {
  icon: React.ReactNode; label: string; meta?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-[7px] text-left transition-colors ${
        active ? "bg-panel2 text-bone" : "text-dim hover:bg-panel2/60"
      }`}
    >
      <span className={active ? "text-lift" : "text-mute"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
      {meta && <span className="shrink-0 font-mono text-[9px] tabular-nums text-mute">{meta}</span>}
      {active && <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-lift" />}
    </button>
  );
}
