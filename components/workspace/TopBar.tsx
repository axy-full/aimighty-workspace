"use client";
import { formatCredits, initialsOf } from "@/lib/workspace/format";
import { getSuite, SUITES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { Keycap } from "./ui";

/** idle / running / waiting / open, from state.run and state.agentOpen. */
export function atomikButtonLook(state: ReturnType<typeof useWorkspace>["state"], stepCount: number | null) {
  const run = state.run && state.run.page === state.page ? state.run : null;
  const waiting = run?.status === "waiting";
  const running = run?.status === "running";
  const open = state.agentOpen;
  return {
    status: open ? "open" : waiting ? "waiting" : running ? "running" : "idle",
    bg: open ? "rgba(240,178,62,.14)" : waiting ? "rgba(255,159,10,.14)" : "var(--pxw-control)",
    border: open || waiting ? "rgba(240,178,62,.42)" : "var(--pxw-control-border)",
    color: open || waiting ? "var(--pxw-atomik-panel-gold)" : "var(--pxw-secondary)",
    dot: waiting ? "var(--pxw-amber)" : running || state.gen ? "var(--pxw-blue)" : "var(--pxw-atomik-gold)",
    badge: waiting ? "1 approval" : running ? (stepCount ? `${run!.i}/${stepCount}` : "running") : "ready",
    badgeColor: waiting ? "var(--pxw-amber-ink)" : running ? "var(--pxw-blue-soft-ink)" : "var(--pxw-faintest)",
    caret: open ? "▲" : "▼",
  };
}

export function TopBar({ account, onOpenPalette }: { account: WorkspaceAccount | null; onOpenPalette?: () => void }) {
  const { state, dispatch, home, switchSuite, plans } = useWorkspace();
  const suite = getSuite(state.suite);
  const look = atomikButtonLook(state, plans(state.page)?.steps?.length ?? null);
  const workspace = account?.workspace ?? null;
  return (
    <header className="pxw-topbar" data-row="topbar">
      <button type="button" className="pxw-wordmark" onClick={() => home()} aria-label={`particl ${suite.short} home`}>
        <span className="pxw-wordmark-mark" aria-hidden="true" />
        <span className="pxw-wordmark-name">particl</span>
        <span className="pxw-wordmark-suite">{suite.mark}</span>
      </button>
      <div className="pxw-spacer" />
      <div className="pxw-seg pxw-seg--pill" role="group" aria-label="Suites" style={{ borderColor: "var(--pxw-control-border)" }}>
        {SUITES.map((s) => (
          <button key={s.id} type="button" className="pxw-suite-tab" aria-pressed={s.id === state.suite} title={s.name} onClick={() => switchSuite(s.id)}>
            <span className="pxw-dot" style={{ background: s.dot }} aria-hidden="true" />
            <span>{s.short}</span>
          </button>
        ))}
      </div>
      <div className="pxw-spacer" />
      <button type="button" className="pxw-search" onClick={onOpenPalette} aria-label="Search" aria-keyshortcuts="Meta+K">
        <span className="pxw-search-label">Search</span>
        <Keycap>⌘K</Keycap>
      </button>
      <button
        type="button"
        className="pxw-atomik-btn"
        data-atomik-state={look.status}
        aria-expanded={state.agentOpen}
        onClick={() => dispatch({ type: "patch", patch: { agentOpen: !state.agentOpen } })}
        style={{ background: look.bg, borderColor: look.border }}
      >
        <span className="pxw-dot" style={{ background: look.dot }} aria-hidden="true" />
        <span className="pxw-atomik-label" style={{ color: look.color }}>Atomik</span>
        <span className="pxw-atomik-badge" style={{ color: look.badgeColor }}>{look.badge}</span>
        <span className="pxw-atomik-caret" aria-hidden="true">{look.caret}</span>
      </button>
      {account?.credits ? (
        <a className="pxw-credits" href="/billing" title="Workspace credits and billing" data-testid="workspace-credits">
          {formatCredits(account.credits.balance)}
        </a>
      ) : null}
      {workspace ? (
        <span className="pxw-avatar" title={workspace.name} aria-label={`Workspace: ${workspace.name}`} role="img">
          {initialsOf(workspace.name)}
        </span>
      ) : null}
    </header>
  );
}
