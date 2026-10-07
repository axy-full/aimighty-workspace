"use client";
import type { ReactNode } from "react";
import { useSession } from "@/lib/session";
import { creditsUsd } from "@/lib/shell/price-words";
import { creditsLabel } from "@/lib/workspace/format";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { useWorkspace } from "@/lib/workspace/state";
import { useCreditUsd } from "../Price";

/** The master's 16-unit tab glyphs (`Particl Suites.dc.html` › phoneVals tabs), stroked at 1.4. */
const TAB_GLYPH = {
  home: "M2 8l6-5 6 5v6H2z",
  record: "M3 2h10v12H3zM5.5 5.5h5M5.5 8.5h5",
  make: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z",
  atomik: "M8 9.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6zM8 14.5c-1.8 0-3.2-2.9-3.2-6.5S6.2 1.5 8 1.5s3.2 2.9 3.2 6.5-1.4 6.5-3.2 6.5z",
} as const;
export type PhoneTab = keyof typeof TAB_GLYPH;
const TABS: { id: PhoneTab; label: string }[] = [
  { id: "home", label: "Home" }, { id: "record", label: "Record" }, { id: "make", label: "Make" }, { id: "atomik", label: "Atomik" },
];

/**
 * The phone's header (frames A–H): ‹ back where there is somewhere to go back to, the screen's title, and the
 * workspace's credits, which open Top up (Settings › Plan & credits, the existing request flow). The credits
 * are the account's balance as the desktop header shows it, with its dollar value on hover.
 */
export function PhoneHeader({ title, account, onBack, onTopUp }: { title: string; account: WorkspaceAccount | null; onBack: (() => void) | null; onTopUp: () => void }) {
  const { rates } = useSession();
  const rate = useCreditUsd();
  const balance = account?.credits?.balance ?? null;
  const credits = creditsLabel(balance, rates.unit, rates.creditUsd);
  const usd = credits.known && typeof balance === "number" ? creditsUsd(balance, rate) : null;
  return (
    <header className="ph-header" data-testid="phone-header">
      <div className="ph-header-lead">
        {onBack ? <button type="button" className="ph-back" aria-label="Back" onClick={onBack} data-testid="phone-back">‹</button> : null}
        <h1 className="ph-title" data-testid="phone-title">{title}</h1>
      </div>
      <button type="button" className="ph-credits" onClick={onTopUp} title={usd ? `${usd} · Top up` : credits.title} data-testid="phone-credits">{credits.text}</button>
    </header>
  );
}

/** The phone's tabs: Home · Record · Make · Atomik (frames A–H), clear of the home indicator. Home counts what needs you. A tab whose screen is not in this build is disabled, never a way to nowhere. */
export function PhoneTabs({ active, needs, onTab, drawn = () => true }: { active: PhoneTab | null; needs: number; onTab: (tab: PhoneTab) => void; drawn?: (tab: PhoneTab) => boolean }) {
  return (
    <nav className="ph-tabs" aria-label="Tabs" data-testid="mobile-dock">
      {TABS.map((t) => (
        <button key={t.id} type="button" className="ph-tab" aria-current={active === t.id ? "page" : undefined} disabled={!drawn(t.id)} onClick={() => onTab(t.id)} data-destination={`tab:${t.id}`} data-testid={`phone-tab-${t.id}`}>
          <span className="ph-tab-glyph" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={TAB_GLYPH[t.id]} /></svg>
            {t.id === "home" && needs > 0 ? <span className="ph-tab-badge" data-testid="phone-needs-badge">{needs > 99 ? "99+" : needs}</span> : null}
          </span>
          <span className="ph-tab-label">{t.label}{t.id === "home" && needs > 0 ? <span className="ph-sr"> · {needs} waiting</span> : null}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * The shell's own toast (lib/workspace/state › toast), drawn where the phone's master draws it: under the
 * header, with its Undo. One toast system: the same text and action every surface sets.
 */
export function PhoneToast() {
  const ws = useWorkspace();
  const text = ws.state.toast;
  if (!text) return null;
  const given = ws.toastAction?.text === text ? ws.toastAction.action : null;
  const action = given && (!given.live || given.live()) ? given : null;
  return (
    <div className="ph-toast" role="status" data-testid="toast">
      <span className="ph-toast-text"><span className="ph-toast-dot" aria-hidden="true" data-done={action?.kind === "undo" || action?.kind === "open" ? "" : undefined} />{text}</span>
      {action ? <button type="button" className="ph-toast-act" onClick={(e) => { e.stopPropagation(); action.run(); }} data-testid={action.kind === "undo" ? "toast-undo" : "toast-open"}>{action.label}</button> : null}
    </div>
  );
}

/** An eyebrow with its count on the right ("NEEDS YOU · 5 items"). */
export function Eyebrow({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="ph-eyebrow-row">
      <h2 className="ph-eyebrow" data-functional-label="">{children}</h2>
      {aside ? <span className="ph-eyebrow-aside" data-functional-label="">{aside}</span> : null}
    </div>
  );
}
