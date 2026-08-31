"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import logo from "@/public/aimighty-logo.png";
import { useProject } from "@/lib/projectContext";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { appPrompt } from "./dialog";
import { IconCompose, IconLibrary, IconMeter, IconBins, IconFilm, IconPlus } from "./Icons";

type U = { name: string; email: string; role: string };
type Usage = { remainingUsd: number; spentUsd: number; purchasedUsd: number; pending: number };

const PAGES = [
  { href: "/",      label: "Compose", Icon: IconCompose },
  { href: "/all",   label: "Library", Icon: IconLibrary },
  { href: "/usage", label: "Usage",   Icon: IconMeter },
];

/** Deterministic avatar hue per person, like the design's member circles. */
export function avatarHue(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 35% 42%)`;
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/** The design's left rail: brand, pages, projects, then you. */
export default function NavRail({ user }: { user: U }) {
  const path = usePathname();
  const { selection, setSelection, projects, refreshProjects } = useProject();
  const router = useRouter();
  const { data: usage } = useApi<Usage>("/api/usage/summary", 30000);

  /** Select the project and land in its media pool. */
  function openPool(id: string) {
    setSelection(id);
    if (path !== "/all") router.push("/all");
  }

  async function newProject() {
    const name = await appPrompt("New project", "", "Project name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) { refreshProjects(); openPool(json.id); }
  }

  return (
    <aside className="app-rail">
      <Link href="/" title="Compose" className="flex items-center gap-2.5 px-5 pb-4 pt-[18px]">
        {/* Accent red is 2.3:1 on the desk — lift the mark so it reads. */}
        <Image src={logo} alt="aimighty" priority
          className="h-[13px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
        <span className="pb-px text-[10px] font-bold tracking-[.14em] text-dim">WORKSPACE</span>
      </Link>

      <nav className="flex flex-col gap-1 px-3">
        {PAGES.map(({ href, label, Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} className="rail-row" data-active={active}>
              <Icon className={`!h-[15px] !w-[15px] ${active ? "text-lift" : ""}`} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 flex items-center gap-2 px-5">
        <span className="lbl">Projects</span>
        <button onClick={newProject} title="New project"
          className="ml-auto grid h-[18px] w-[18px] place-items-center rounded-[6px] text-mute transition-colors hover:bg-chip hover:text-lift">
          <IconPlus />
        </button>
      </div>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <RailProject
          icon={<IconLibrary className="!h-3.5 !w-3.5" />} label="All clips"
          active={selection === "all"} onClick={() => openPool("all")}
        />
        <RailProject
          icon={<IconFilm className="!h-3.5 !w-3.5" />} label="Unfiled"
          active={selection === "unfiled"} onClick={() => openPool("unfiled")}
          pasteTarget="unfiled"
        />
        {projects.map((p) => (
          <RailProject
            key={p.id}
            icon={<IconBins className="!h-3.5 !w-3.5" />}
            label={p.name}
            meta={`${String(p.genCount).padStart(2, "0")} · ${usd(p.spend, 2)}`}
            active={selection === p.id}
            onClick={() => openPool(p.id)}
            pasteTarget={p.id}
          />
        ))}
        {projects.length === 0 && (
          <p className="px-2 py-2 text-[11.5px] leading-relaxed text-mute">
            No projects yet — make one and renders will file into it.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between px-5 py-2 font-mono text-[9.5px] tracking-wide text-mute">
        <span>SPENT <span className="tabular-nums text-dim">{usage ? usd(usage.spentUsd, 2) : "--"}</span></span>
        <span>CREDIT <span className={`tabular-nums ${usage && usage.remainingUsd < 0 ? "text-lift" : "text-dim"}`}>
          {usage ? usd(usage.remainingUsd, 2) : "--"}
        </span></span>
      </div>

      <div className="border-t border-line px-3 py-2.5">
        <UserMenu user={user} up />
      </div>
    </aside>
  );
}

function RailProject({ icon, label, meta, active, onClick, pasteTarget }: {
  icon: React.ReactNode; label: string; meta?: string; active: boolean; onClick: () => void;
  pasteTarget?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-active={active}
      data-project-target={pasteTarget}
      data-project-name={pasteTarget ? label : undefined}
      className="rail-row !gap-2.5 !py-[6px] text-left"
    >
      <span className={active ? "text-lift" : "text-mute"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
      {meta && <span className="shrink-0 font-mono text-[9px] tabular-nums text-mute">{meta}</span>}
      {active && <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-lift" />}
    </button>
  );
}

/** Avatar + name; opens the account menu. Shared by the rail (opens upward)
 *  and the mobile top bar (opens downward, where it also carries the spend
 *  readout the hidden rail would have shown). */
export function UserMenu({ user, up = false, usage }: {
  user: U; up?: boolean;
  usage?: { spentUsd: number; remainingUsd: number };
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={`${user.name} · ${user.email}`}
        className={`flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-chip ${up ? "" : "w-auto !px-1.5"}`}
      >
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: avatarHue(user.name) }}>
          {initialsOf(user.name)}
        </span>
        {up && (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12.5px] font-semibold">{user.name}</span>
            <span className="truncate text-[11px] text-mute">{user.role} · aimighty</span>
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute z-50 w-[212px] overflow-hidden rounded-[11px] border border-line bg-panel2 p-1 shadow-[var(--shadow)] ${
            up ? "bottom-[calc(100%+8px)] left-0" : "right-0 top-[calc(100%+8px)]"
          }`}>
            <div className="px-2.5 pb-2 pt-1.5">
              <p className="truncate text-[12.5px] font-semibold text-bone">{user.name}</p>
              <p className="truncate font-mono text-[9.5px] text-mute">{user.email}</p>
              {usage && (
                <p className="mt-1.5 flex justify-between font-mono text-[9.5px] text-mute">
                  <span>SPENT <span className="tabular-nums text-dim">{usd(usage.spentUsd, 2)}</span></span>
                  <span>CREDIT <span className={`tabular-nums ${usage.remainingUsd < 0 ? "text-lift" : "text-dim"}`}>
                    {usd(usage.remainingUsd, 2)}
                  </span></span>
                </p>
              )}
            </div>
            <div className="mx-1 mb-1 h-px bg-hair" />
            {user.role === "admin" && (
              <button onClick={() => { setOpen(false); router.push("/team"); }}
                className="menu-item max-[860px]:py-[10px] text-dim hover:text-bone">
                Team &amp; invites
              </button>
            )}
            <button onClick={signOut} disabled={busy} className="menu-item max-[860px]:py-[10px] text-dim hover:text-bone">
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
