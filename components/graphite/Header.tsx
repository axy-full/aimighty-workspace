"use client";
import { TRAIL } from "@/components/ui/Mark";
import { Glyph, SUITE_LOOK } from "./icons";
import { HEADER_SEGMENT, type ShellSuiteId } from "@/lib/shell/ia";
import { OWNER_BADGE, isOwnerRunSuite, ownerBadgeNote } from "@/lib/shell/connected-capability";
import { useConnectedCapability } from "@/lib/shell/use-connected-capability";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { creditsLabel } from "@/lib/workspace/format";
import { useWorkspace } from "@/lib/workspace/state";
import type { WorkspaceAccount } from "@/lib/workspace/data";

function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "W";
}

/**
 * 56px. particl trail mark + wordmark → Studio; Studio | Gen | Business | Viral |
 * Atomik; the search field that opens ⌘K; the running-jobs pill (only while a
 * job runs); the credits pill; the avatar, which opens Workspace. A member
 * sees the key and "Owner" on the suites that run on the owner's Higgsfield
 * account (Business, Viral); the note says who runs them.
 */
export function Header({ account }: { account: WorkspaceAccount | null }) {
  const shell = useShell();
  const { state } = useWorkspace();
  const { rates, name } = useSession();
  /* The session says who owns the workspace: nothing is read for the badge. */
  const capability = useConnectedCapability(undefined, { read: false });
  const ownerNote = ownerBadgeNote(capability.ownerName);
  const credits = creditsLabel(account?.credits?.balance ?? null, rates.unit, rates.creditUsd);
  const selected = shell.view === "gen" ? "gen" : shell.view === "crew" ? "crew" : shell.view === "suite" ? shell.suite.id : null;
  /* The context badge: the phone's Home and its Library read HOME and ASSETS; every other view names itself. */
  const studioPage = shell.view === "suite" && shell.suite.id === "studio" ? shell.page.id : null;
  const mark = shell.view === "workspace" ? "WORKSPACE" : shell.view === "gen" ? "GEN" : shell.view === "crew" ? "CREW" : !shell.wide && shell.libOpen ? "ASSETS" : studioPage === "home" ? "HOME" : shell.suite.mark;
  const who = account?.workspace?.name ?? name ?? "Workspace";
  /* The phone's back button: a stage returns to the stage grid (‹ Studio); the grid returns to Home (‹ Home). */
  const back = studioPage === "stages" ? { label: "Home", page: "home" } : studioPage && studioPage !== "home" ? { label: "Studio", page: "stages" } : null;
  return (
    <header className="gx-header" data-row="header">
      <div className="gx-aurora" aria-hidden="true" data-testid="header-aurora" /><div className="gx-dots" aria-hidden="true" /><div className="gx-baseline" aria-hidden="true" />
      {back ? (
        <button type="button" className="gx-back" onClick={() => shell.goSuite("studio", back.page)} data-testid="phone-back"><span aria-hidden="true">‹</span> {back.label}</button>
      ) : null}
      <button type="button" className="gx-brand" onClick={() => (shell.wide ? shell.goSuite("studio") : shell.goSuite("studio", "home"))} aria-label="particl home">
        <svg width="30" height="14" viewBox="30 68 140 64" fill="#F5F5F7" aria-hidden="true">
          <defs><linearGradient id="gx-mark-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F5F5F7" /><stop offset="1" stopColor="#6EB4FF" /></linearGradient></defs>
          {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
        </svg>
        <span className="gx-brand-name">particl</span>
        <span className="gx-brand-mark" data-testid="suite-mark">{mark}</span>
      </button>
      <div className="gx-seg" role="tablist" aria-label="Suites">
        {HEADER_SEGMENT.map((s) => {
          const ownerRun = !capability.owner && isOwnerRunSuite(s.id);
          return (
            <button key={s.id} type="button" role="tab" className="gx-seg-btn" aria-selected={selected === s.id} title={ownerRun ? `${s.title} · ${ownerNote}` : s.title} style={{ "--suite": SUITE_LOOK[s.id]?.color } as React.CSSProperties} data-suite-tab={s.id}
              aria-describedby={ownerRun ? "gx-owner-run-note" : undefined} data-owner-run={ownerRun || undefined}
              onClick={() => (s.id === "gen" ? shell.goGen() : s.id === "crew" ? shell.goCrew() : shell.goSuite(s.id as ShellSuiteId))}>
              <Glyph name={SUITE_LOOK[s.id]?.glyph ?? "spark"} size={15} className="gx-glyph" />
              <span className="gx-seg-label">{s.label}</span>
              {ownerRun ? (
                <span className="gx-owner-badge" aria-hidden="true" data-testid={`owner-badge-${s.id}`}>
                  <Glyph name="key" size={10} className="gx-owner-badge-key" /><span className="gx-owner-badge-label">{OWNER_BADGE}</span>
                </span>
              ) : null}
              <span className="gx-sig" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {!capability.owner ? <span id="gx-owner-run-note" hidden>{ownerNote}</span> : null}
      <button type="button" className="gx-search" onClick={() => shell.setPalette(true)} aria-label="Search" aria-keyshortcuts="Meta+K" data-testid="header-search">
        <Glyph name="search" size={14} className="gx-glyph" />
        <span className="gx-search-label">Search</span>
        <span className="gx-key">⌘K</span>
      </button>
      <span className="gx-spacer" />
      {state.gen ? (
        <button type="button" className="gx-hbtn gx-jobs" onClick={() => shell.goSuite("atomik", "runs")} data-testid="running-jobs">
          <span className="gx-jobs-dot" aria-hidden="true" />
          <span>{state.gen.name} · {Math.round(state.gen.pct)}%</span>
        </button>
      ) : null}
      <button type="button" className="gx-hbtn" onClick={() => shell.goWorkspace("credits")} title={credits.title} data-testid="workspace-credits" aria-label={`Credits: ${credits.text}`}>
        <span className="gx-credits-n">{credits.text.replace(/\s*cr$/i, "")}</span>
        {/cr$/i.test(credits.text) ? <span className="gx-credits-u">cr</span> : null}
      </button>
      <button type="button" className="gx-avatar" onClick={() => shell.goWorkspace()} aria-label={`Workspace and account: ${who}`} title="Workspace" data-testid="workspace-avatar">
        {initialsOf(who)}
      </button>
    </header>
  );
}
