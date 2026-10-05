"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { TRAIL } from "@/components/ui/Mark";
import { Glyph, SEGMENT_LOOK, posterOf } from "./icons";
import { HEADER_SEGMENT, type HeaderSegmentId } from "@/lib/shell/ia";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { creditsLabel } from "@/lib/workspace/format";
import { lowBalance, useLastQuote } from "@/lib/workspace/last-quote";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import Boundary from "@/components/Boundary";
import { JobsFault, JobsPill } from "./JobsTray";
import { SettingsMenu } from "./SettingsMenu";
/* LOCAL WIRING, stream 7's worktree only. */
import { useNewInterface } from "@/lib/shell/new-interface";
import { openAtomikPanel } from "@/lib/shell/atomik-panel";
import { useAtomikPanelMode } from "./atomik/panel/use-atomik-panel";

function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "W";
}

/**
 * 56px, header option B (design/particl-graphite/README.md § 1): the particl mark and the suite pill; the segment
 * Home · <the open project> · Make · Atomik; Search (⌘K) in the middle; the jobs pill (while something renders, is
 * held, or finished unseen), which opens the jobs tray; the credits; the avatar, which opens Settings.
 *
 * Until the packages that build the new screens ship, each segment opens today's page for it: Home the Studio
 * overview (on a phone, Home's "Where to?"), the project its current Studio page, Make its panel over the page on
 * screen (⌥M), Atomik its suite. Business, Viral and Crew are reached from ⌘K and the phone's Home.
 *
 * On a phone (components/graphite/phone.css) the context badge is a button: the segment and Search open under it,
 * one tap away. `bar` is the top bar's second row there — the project switcher beside the page strip.
 */
export function Header({ account, project = null, bar = null }: { account: WorkspaceAccount | null; project?: string | null; bar?: ReactNode }) {
  const shell = useShell();
  const newInterface = useNewInterface();
  const atomikOpen = useAtomikPanelMode() !== null;
  const { rates, name, requestScope } = useSession();
  const balance = account?.credits?.balance ?? null;
  const credits = creditsLabel(balance, rates.unit, rates.creditUsd);
  /* Amber when the balance cannot pay for the last price a Generate showed here; it reads that quote, never asks for one. */
  const lastQuote = useLastQuote(requestScope);
  const low = rates.unit !== "usd" && lowBalance(balance, lastQuote);
  const studioPage = shell.view === "suite" && shell.suite.id === "studio" ? shell.page.id : null;
  /* Home is the Studio overview on a desktop and Home's "Where to?" on a phone, where the overview is the project's stage grid. */
  const onHome = studioPage === "home" || (studioPage === "stages" && shell.wide);
  /* What each segment is lit for (the master's rules): the project for every suite page but Atomik's, and for Crew. */
  const lit: Record<HeaderSegmentId, boolean> = {
    home: onHome,
    project: (shell.view === "suite" && shell.suite.id !== "atomik" && !onHome) || shell.view === "crew",
    /* Make is a panel over the page on screen (README § 3.2): lit while it is open, beside whatever else is. */
    make: shell.make !== null,
    atomik: newInterface ? atomikOpen : shell.view === "suite" && shell.suite.id === "atomik",
  };
  /* The suite pill names where you are: HOME, an old page's own mark, MAKE, CREW, SETTINGS; the phone's Library reads ASSETS. */
  const mark = shell.view === "workspace" ? "SETTINGS" : shell.view === "gen" ? "MAKE" : shell.view === "crew" ? "CREW" : !shell.wide && shell.libOpen ? "ASSETS" : onHome ? "HOME" : shell.suite.mark;
  const who = account?.workspace?.name ?? name ?? "Workspace";
  /* The phone's back button: a stage returns to the stage grid (‹ Studio); the grid returns to Home (‹ Home). */
  const back = studioPage === "stages" ? { label: "Home", page: "home" } : studioPage && studioPage !== "home" ? { label: "Studio", page: "stages" } : null;
  /* The phone's menu: a tap outside it, Escape, a pick or going anywhere else closes it (it is open only where it was opened). */
  const here = `${shell.view}:${shell.suite.id}:${shell.page.id}:${shell.wsTab}`;
  const [openAt, setOpenAt] = useState<string | null>(null);
  const menu = openAt === here;
  const setMenu = (open: boolean) => setOpenAt(open ? here : null);
  const [settings, setSettings] = useState(false);
  const avatar = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => { if (box.current && event.target instanceof Node && !box.current.contains(event.target)) setOpenAt(null); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenAt(null); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const goTo = (id: HeaderSegmentId) => {
    setMenu(false);
    if (id === "home") shell.goSuite("studio", shell.wide ? "stages" : "home");
    else if (id === "project") shell.goProject();
    else if (id === "make") shell.goGen();
    /* LOCAL WIRING, stream 7's worktree only: with the new interface, Atomik is a panel over any screen. */
    else if (newInterface) openAtomikPanel("1");
    else shell.goSuite("atomik");
  };
  const badge = <span className="gx-brand-mark" data-testid="suite-mark">{mark}</span>;
  return (
    <header className="gx-header" data-row="header" data-menu={menu ? "open" : undefined} ref={box}>
      {back ? (
        <button type="button" className="gx-back" onClick={() => shell.goSuite("studio", back.page)} data-testid="phone-back"><span aria-hidden="true">‹</span> <span className="gx-back-label">{back.label}</span></button>
      ) : null}
      {/* The mark goes Home, as the Home segment does. */}
      <button type="button" className="gx-brand" onClick={() => goTo("home")} aria-label="particl home" data-testid="brand-home">
        <svg width="30" height="14" viewBox="30 68 140 64" fill="currentColor" aria-hidden="true">
          {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
        </svg>
        <span className="gx-brand-name">particl</span>
        {shell.wide ? badge : null}
      </button>
      {shell.wide ? null : (
        <button type="button" className="gx-menu-btn" aria-haspopup="true" aria-expanded={menu} aria-controls="gx-suites" aria-label={`Go to and search · ${mark.toLowerCase()}`} onClick={() => setMenu(!menu)} data-testid="suites-menu">
          {badge}<Glyph name="chev" size={12} className="gx-glyph" />
        </button>
      )}
      <div className="gx-seg" role="tablist" aria-label="Suites" id="gx-suites">
        {HEADER_SEGMENT.map((s) => {
          const look = s.id === "project" ? null : SEGMENT_LOOK[s.id];
          const swatch = s.id === "project" ? posterOf(project ?? "") : null;
          return (
            <button key={s.id} type="button" role="tab" className="gx-seg-btn" aria-selected={lit[s.id]} title={s.id === "project" && project ? `${project} · ${s.title.toLowerCase()}` : s.title}
              aria-keyshortcuts={s.id === "make" ? "Alt+M" : undefined} data-suite-tab={s.id} style={look?.color ? ({ "--suite": look.color } as CSSProperties) : undefined}
              onClick={() => goTo(s.id)}>
              {swatch ? <span className="gx-seg-swatch" aria-hidden="true" style={{ background: `linear-gradient(135deg, ${swatch.from}, ${swatch.to})` }} /> : <Glyph name={look!.glyph} size={13} className="gx-glyph" />}
              <span className="gx-seg-label">{s.id === "project" ? project ?? s.label : s.label}</span>
              {look?.color ? <span className="gx-sig" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <button type="button" className="gx-search" onClick={() => { setMenu(false); shell.setPalette(true); }} aria-label="Search" aria-keyshortcuts="Meta+K" data-testid="header-search">
        <Glyph name="search" size={13} className="gx-glyph" />
        <span className="gx-search-label">Search</span>
        <span className="gx-key">⌘K</span>
      </button>
      <span className="gx-spacer" />
      {/* The tray draws rows the server sent: one that cannot be drawn costs the pill, never the header. */}
      <Boundary what="Jobs" probe="jobs" fallback={(fault) => <JobsFault fault={fault} />}><JobsPill /></Boundary>
      <button type="button" className="gx-hbtn gx-credits" data-low={low || undefined} onClick={() => shell.goWorkspace("credits")} data-testid="workspace-credits"
        title={low ? `${credits.title} · below the last price quoted (${lastQuote!.credits.toLocaleString("en-US")} cr) · Plans & credits` : credits.title}
        aria-label={low ? `Credits: ${credits.text}, below the last price quoted, ${lastQuote!.credits.toLocaleString("en-US")} cr. Open Plans & credits` : `Credits: ${credits.text}`}>
        <span className="gx-credits-n">{credits.text.replace(/\s*cr$/i, "")}</span>
        {/cr$/i.test(credits.text) ? <span className="gx-credits-u">cr</span> : null}
      </button>
      <button type="button" ref={avatar} className="gx-avatar" onClick={() => { setMenu(false); setSettings((open) => !open); }} aria-haspopup="menu" aria-expanded={settings}
        aria-label={`Workspace and account: ${who}`} title="Settings" data-testid="workspace-avatar">
        {initialsOf(who)}
      </button>
      {settings ? <SettingsMenu anchor={avatar} who={who} onClose={() => setSettings(false)} /> : null}
      {bar ? <div className="gx-bar" data-row="bar">{bar}</div> : null}
    </header>
  );
}
