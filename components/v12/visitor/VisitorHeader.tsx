"use client";
import { TRAIL } from "@/components/ui/Mark";
import { IconButton, Tooltip } from "@/components/v12/ui";
import { useJoin } from "@/components/v12/join/JoinProvider";
import { loginPath } from "@/components/v12/join/join-model";
import { sampleTab, type VisitorScreen } from "@/lib/v12/visitor";

/**
 * The visitor's header (docs/redesign/inventory.md § 8.1; prototype L43–L56 with `?guest=1`): the logo, Home, Make and
 * one tab for the sample board, "+" (which opens the join sheet), the Atomik field, then "Log in" and the one filled
 * "Request access". No Activity, no avatar, no credits. Asking Atomik or searching opens the join sheet. On a phone it
 * is the logo, "Log in" and "Request access", with 44 px targets.
 */
export function VisitorHeader({ screen, sampleTitle, compact, onGo }: { screen: VisitorScreen | null; sampleTitle: string; compact: boolean; onGo: (screen: VisitorScreen) => void }) {
  const join = useJoin();
  const open = join?.openJoin;
  const here = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
  const logo = (
    <Tooltip name="Home">
      <button type="button" className="v12-logo" onClick={() => onGo("home")} aria-label="particl, Home" data-testid="v12-visitor-logo">
        <svg width="30" height="14" viewBox="30 68 140 64" fill="currentColor" aria-hidden="true">
          {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
        </svg>
        <span className="v12-logo-name">particl</span>
      </button>
    </Tooltip>
  );
  const login = <a className="v12-vlogin" href={loginPath(here)} data-testid="v12-visitor-login">Log in</a>;
  const request = <button type="button" className="v12-vbtn v12-vbtn-primary" onClick={() => open?.("request")} data-testid="v12-visitor-request">Request access</button>;
  if (compact) {
    return (
      <header className="v12-header v12-vheader" data-compact="" data-testid="v12-visitor-header">
        {logo}
        <span className="v12-vspacer" />
        {login}
        {request}
      </header>
    );
  }
  const tab = (id: VisitorScreen, label: string, glyph?: string) => (
    <div className="v12-tab" data-active={screen === id ? "" : undefined} data-testid={`v12-visitor-tab-${id}`}>
      <button type="button" className="v12-tab-main" onClick={() => onGo(id)} aria-current={screen === id ? "page" : undefined}>
        {glyph ? <span className="v12-tab-spark" aria-hidden="true">{glyph}</span> : null}
        <span className="v12-tab-label">{label}</span>
      </button>
    </div>
  );
  return (
    <header className="v12-header v12-vheader" data-testid="v12-visitor-header">
      {logo}
      <nav className="v12-tabs" aria-label="Tabs">
        <div className="v12-tab" data-active={screen === "home" ? "" : undefined} data-testid="v12-visitor-tab-home">
          <button type="button" className="v12-tab-main" onClick={() => onGo("home")} aria-current={screen === "home" ? "page" : undefined}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 8l6-5 6 5v6h-4v-4H6v4H2z" /></svg>
            <span className="v12-tab-label">Home</span>
          </button>
        </div>
        {tab("make", "Make", "✦")}
        <div className="v12-tab" data-board="" data-active={screen === "board" ? "" : undefined} data-testid="v12-visitor-tab-board">
          <Tooltip name={sampleTab(sampleTitle)} line="Particl’s own sample board. Explore it; nothing you do on it is saved.">
            <button type="button" className="v12-tab-main" onClick={() => onGo("board")} aria-current={screen === "board" ? "page" : undefined}>
              <span className="v12-tab-dot" data-state="idle" aria-hidden="true" />
              <span className="v12-tab-label">{sampleTab(sampleTitle)}</span>
            </button>
          </Tooltip>
        </div>
        <IconButton tooltip={{ name: "New tab", line: "Open a new board." }} label="New tab" className="v12-tab-plus" onClick={() => open?.("plus")} data-testid="v12-visitor-plus">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </IconButton>
      </nav>
      <div className="v12-field" data-testid="v12-visitor-field">
        <Tooltip name="Ask Atomik, search or go to" line="Ask a question, find a board, or run an action." shortcut="⌘K">
          <button type="button" className="v12-field-ask" onClick={() => open?.("ask")} aria-keyshortcuts="Meta+K" data-testid="v12-visitor-ask">
            <span className="v12-field-mark" aria-hidden="true">◆</span>
            <span className="v12-field-text">Ask Atomik, search or go to · ⌘K</span>
          </button>
        </Tooltip>
        <IconButton className="v12-field-panel" onClick={() => open?.("ask")} aria-keyshortcuts="Meta+J" tooltip={{ name: "Atomik panel", line: "Open the conversation.", shortcut: "⌘J" }} label="Atomik panel" data-testid="v12-visitor-panel">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
        </IconButton>
      </div>
      <span className="v12-vspacer" />
      {login}
      {request}
    </header>
  );
}
