"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TRAIL } from "@/components/ui/Mark";
import { Glyph, SUITE_LOOK } from "./icons";
import { HEADER_SEGMENT, type ShellSuiteId } from "@/lib/shell/ia";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { creditsLabel } from "@/lib/workspace/format";
import { lowBalance, useLastQuote } from "@/lib/workspace/last-quote";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import Boundary from "@/components/Boundary";
import { JobsFault, JobsPill } from "./JobsTray";

function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "W";
}

/**
 * 56px. particl trail mark + wordmark → the Studio home; Studio | Gen | Business | Viral |
 * Atomik; the search field that opens ⌘K; the jobs pill (while something
 * renders, is held, or finished unseen), which opens the jobs tray; the
 * credits pill; the avatar, which opens Workspace.
 *
 * On a phone (app/phone-chrome.css) the context badge is a button: the Suites
 * and Search open under it, one tap away. `bar` is the top bar's second row
 * there — the project switcher beside the page strip or Gen's own buttons.
 */
export function Header({ account, bar = null }: { account: WorkspaceAccount | null; bar?: ReactNode }) {
  const shell = useShell();
  const { rates, name, requestScope } = useSession();
  const balance = account?.credits?.balance ?? null;
  const credits = creditsLabel(balance, rates.unit, rates.creditUsd);
  /* Amber when the balance cannot pay for the last price a Generate showed here; it reads that quote, never asks for one. */
  const lastQuote = useLastQuote(requestScope);
  const low = rates.unit !== "usd" && lowBalance(balance, lastQuote);
  const selected = shell.view === "gen" ? "gen" : shell.view === "crew" ? "crew" : shell.view === "suite" ? shell.suite.id : null;
  /* The context badge: the phone's Home and its Library read HOME and ASSETS; every other view names itself. */
  const studioPage = shell.view === "suite" && shell.suite.id === "studio" ? shell.page.id : null;
  const mark = shell.view === "workspace" ? "WORKSPACE" : shell.view === "gen" ? "GEN" : shell.view === "crew" ? "CREW" : !shell.wide && shell.libOpen ? "ASSETS" : studioPage === "home" ? "HOME" : shell.suite.mark;
  const who = account?.workspace?.name ?? name ?? "Workspace";
  /* The phone's back button: a stage returns to the stage grid (‹ Studio); the grid returns to Home (‹ Home). */
  const back = studioPage === "stages" ? { label: "Home", page: "home" } : studioPage && studioPage !== "home" ? { label: "Studio", page: "stages" } : null;
  /* The phone's Suites menu: a tap outside it, Escape, a pick or going anywhere else closes it (it is open only where it was opened). */
  const here = `${shell.view}:${shell.suite.id}:${shell.page.id}:${shell.wsTab}`;
  const [openAt, setOpenAt] = useState<string | null>(null);
  const menu = openAt === here;
  const setMenu = (open: boolean) => setOpenAt(open ? here : null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => { if (box.current && event.target instanceof Node && !box.current.contains(event.target)) setOpenAt(null); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenAt(null); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const badge = <span className="gx-brand-mark" data-testid="suite-mark">{mark}</span>;
  return (
    <header className="gx-header" data-row="header" data-menu={menu ? "open" : undefined} ref={box}>
      <div className="gx-aurora" aria-hidden="true" data-testid="header-aurora" /><div className="gx-dots" aria-hidden="true" /><div className="gx-baseline" aria-hidden="true" />
      {back ? (
        <button type="button" className="gx-back" onClick={() => shell.goSuite("studio", back.page)} data-testid="phone-back"><span aria-hidden="true">‹</span> <span className="gx-back-label">{back.label}</span></button>
      ) : null}
      {/* The mark goes home: on a desktop the Studio home (recent projects, what is running, the next step); on a phone Home's "Where to?". */}
      <button type="button" className="gx-brand" onClick={() => shell.goSuite("studio", shell.wide ? "stages" : "home")} aria-label="particl home" data-testid="brand-home">
        <svg width="30" height="14" viewBox="30 68 140 64" fill="#F5F5F7" aria-hidden="true">
          <defs><linearGradient id="gx-mark-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F5F5F7" /><stop offset="1" stopColor="#6EB4FF" /></linearGradient></defs>
          {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
        </svg>
        <span className="gx-brand-name">particl</span>
        {shell.wide ? badge : null}
      </button>
      {shell.wide ? null : (
        <button type="button" className="gx-menu-btn" aria-haspopup="true" aria-expanded={menu} aria-controls="gx-suites" aria-label={`Suites and search · ${mark.toLowerCase()}`} onClick={() => setMenu(!menu)} data-testid="suites-menu">
          {badge}<Glyph name="chev" size={12} className="gx-glyph" />
        </button>
      )}
      <div className="gx-seg" role="tablist" aria-label="Suites" id="gx-suites">
        {HEADER_SEGMENT.map((s) => (
          <button key={s.id} type="button" role="tab" className="gx-seg-btn" aria-selected={selected === s.id} title={s.title} style={{ "--suite": SUITE_LOOK[s.id]?.color } as React.CSSProperties} data-suite-tab={s.id}
            onClick={() => { setMenu(false); if (s.id === "gen") shell.goGen(); else if (s.id === "crew") shell.goCrew(); else shell.goSuite(s.id as ShellSuiteId); }}>
            <Glyph name={SUITE_LOOK[s.id]?.glyph ?? "spark"} size={15} className="gx-glyph" />
            <span className="gx-seg-label">{s.label}</span>
            <span className="gx-sig" aria-hidden="true" />
          </button>
        ))}
      </div>
      <button type="button" className="gx-search" onClick={() => { setMenu(false); shell.setPalette(true); }} aria-label="Search" aria-keyshortcuts="Meta+K" data-testid="header-search">
        <Glyph name="search" size={14} className="gx-glyph" />
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
      <button type="button" className="gx-avatar" onClick={() => shell.goWorkspace()} aria-label={`Workspace and account: ${who}`} title="Workspace" data-testid="workspace-avatar">
        {initialsOf(who)}
      </button>
      {bar ? <div className="gx-bar" data-row="bar">{bar}</div> : null}
    </header>
  );
}
