"use client";

import Link from "next/link";
import { creditsNumber } from "@/lib/price";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useProject } from "@/lib/projectContext";
import { useSession, useSignInHref, type SessionCredits } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { RequestAccessButton } from "@/components/RequestAccess";
import BrandSwitch from "./BrandSwitch";

/**
 * The particl shell header, from the pipeline handoff.
 *
 * 52px, hairline beneath, six things in a row: the logo, a divider, the
 * project switcher, the nav centred in mono, the cap readout, the avatar.
 * It replaces three pieces of chrome at once — the old top bar, the
 * floating tab pill and the projects rail — because the redesign puts the
 * project in the header and the nav in the header, and once both are there
 * a rail and a pill are two more places saying the same thing.
 *
 * The nav is two groups with a rule between them: what you MAKE (video,
 * images, audio) and what you MANAGE (projects, studio, usage, settings).
 * Active is ink with a 2px inset underline; everything else is muted until
 * hovered. Kode Mono 11px at 0.12em, because in this system the nav is a
 * label, not a sentence.
 */

const MAKE = [
  { href: "/", label: "VIDEO" },
  { href: "/images", label: "IMAGES" },
  { href: "/audio", label: "AUDIO" },
];
const MANAGE = [
  { href: "/projects", label: "PRODUCTIONS" },
  { href: "/studio", label: "STUDIO" },
  { href: "/usage", label: "USAGE" },
  { href: "/settings", label: "SETTINGS" },
];

/* Studio-level screens show the studio's month, not one production's cap. */
const STUDIO_LEVEL = ["/projects", "/all", "/settings", "/usage"];

type Summary = { spentUsd: number; credits?: SessionCredits | null; pending: number };

export default function AppHeader() {
  const path = usePathname();
  const { signedIn, name } = useSession();
  const signIn = useSignInHref();
  const { projects, current, selection, setSelection } = useProject();
  const { data: usage } = useApi<Summary>("/api/usage/summary", 30_000);

  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  /* /projects itself is studio-level; /projects/:id/… is one production. */
  const studioLevel = STUDIO_LEVEL.some((p) => (p === "/projects" ? path === "/projects" : path.startsWith(p)));
  const showAll = studioLevel || selection === "all" || !current;

  const initials = (name ?? "")
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";

  return (
    <header className="hdr">
      {/* The logo is the switch between the two rooms; VIDEO in the nav is home. */}
      <BrandSwitch side="particl" />

      <span className="hdr-rule" aria-hidden="true" />

      <ProjectSwitcher
        projects={projects}
        current={showAll ? null : current}
        onPick={(id) => setSelection(id)}
        disabled={!signedIn}
      />

      <nav className="hdr-nav" aria-label="Sections">
        {MAKE.map((t) => (
          <Link key={t.href} href={t.href} className={`hdr-tab ${active(t.href) ? "is-on" : ""}`}>{t.label}</Link>
        ))}
        <span className="hdr-nav-rule" aria-hidden="true" />
        {MANAGE.map((t) => (
          <Link key={t.href} href={t.href} className={`hdr-tab ${active(t.href) ? "is-on" : ""}`}>{t.label}</Link>
        ))}
      </nav>

      <div className="hdr-right">
        {signedIn ? (
          <>
            <CapReadout studioLevel={showAll} project={showAll ? null : current} spentUsd={usage?.spentUsd ?? null} credits={usage?.credits ?? null} />
            <Link href="/settings" className="hdr-avatar" title={name ?? "Settings"}>{initials}</Link>
          </>
        ) : (
          <>
            <RequestAccessButton className="hdr-mono-link" />
            <a href={signIn} className="btn-primary !h-8 !px-3.5 !text-[12.5px]">Sign in</a>
          </>
        )}
      </div>
    </header>
  );
}


type Proj = { id: string; name: string; kind?: string | null; runtime?: string | null; spend?: number; capUsd?: number | null };

/**
 * The cap readout: `$57.20 OF $250 CAP` for a production, `$612.40 THIS
 * MONTH` on studio-level screens. Value in ink, the rest muted; the whole
 * thing is a link to Usage because that is where the number is explained.
 */
function CapReadout({ studioLevel, project, spentUsd, credits }: {
  studioLevel: boolean; project: Proj | null; spentUsd: number | null; credits?: SessionCredits | null;
}) {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const { credits: sessionCredits } = useSession();
  const cr = credits ?? sessionCredits;
  /* A workspace that pays in credits sees its balance, whatever the screen. */
  if (cr) {
    return (
      <Link href="/settings#credits" className="hdr-cap" title={`${creditsNumber(cr.used)} used of ${creditsNumber(cr.granted)} added — tap to top up`}>
        <span className="hdr-cap-v">{creditsNumber(cr.balance)}</span><span className="hdr-cap-long"> CREDITS LEFT</span><span className="hdr-cap-short"> CR</span>
      </Link>
    );
  }
  if (studioLevel || !project) {
    return (
      <Link href="/usage" className="hdr-cap" title="This month, across the studio">
        <span className="hdr-cap-v">{spentUsd == null ? "—" : money(spentUsd)}</span><span className="hdr-cap-long"> THIS MONTH</span><span className="hdr-cap-short"> MO</span>
      </Link>
    );
  }
  const spent = project.spend ?? 0;
  const cap = project.capUsd ?? null;
  return (
    <Link href="/usage" className="hdr-cap" title={cap ? "Spend against this production's cap" : "This production's spend — no cap set"}>
      <span className="hdr-cap-v">{money(spent)}</span>
      <span className="hdr-cap-long">{cap ? ` OF $${Math.round(cap)} CAP` : " · NO CAP"}</span>
      <span className="hdr-cap-short">{cap ? `/$${Math.round(cap)}` : ""}</span>
    </Link>
  );
}

/**
 * The project switcher: a panel pill carrying the production's name, its
 * kind and a caret. On studio-level screens it reads `All projects`.
 */
function ProjectSwitcher({ projects, current, onPick, disabled }: {
  projects: Proj[]; current: Proj | null; onPick: (id: string) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button type="button" className="hdr-switch" disabled={disabled}
        onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span>{current ? current.name : "All productions"}</span>
        {current?.kind && <span className="hdr-switch-kind">{current.kind}</span>}
        <span className="hdr-caret" aria-hidden="true">▼</span>
      </button>
      {open && (
        <div role="menu" className="menu-pop hdr-switch-menu">
          <button type="button" role="menuitemradio" aria-checked={!current}
            className={`menu-item ${!current ? "is-on" : ""}`}
            onClick={() => { setOpen(false); onPick("all"); }}>All productions</button>
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={current?.id === p.id}
              className={`menu-item ${current?.id === p.id ? "is-on" : ""}`}
              onClick={() => { setOpen(false); onPick(p.id); }}>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.kind && <span className="ml-2 text-[11px] text-mute">{p.kind}</span>}
            </button>
          ))}
          <Link href="/projects" className="menu-item text-mute" onClick={() => setOpen(false)}>
            Every production →
          </Link>
        </div>
      )}
    </div>
  );
}
