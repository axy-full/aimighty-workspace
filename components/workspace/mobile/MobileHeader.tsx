"use client";
import { IconArrowLeft, IconSearch } from "@/components/Icons";
import { ParticlMark } from "@/components/ParticlMark";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { useSession } from "@/lib/session";
import { creditsLabel, initialsOf } from "@/lib/workspace/format";
import { getSuite, pageDef } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * 54px header (05-mobile, "Header"). Left is the particl mark on Projects and
 * a back chevron everywhere else; the title doubles as the suite dropdown on
 * Projects, and only there does it carry the caret. Right: credits in mono,
 * search, then the avatar, which opens Settings. Every button is 44×44; the
 * avatar's 32px circle sits inside its 44px button.
 *
 * The mark is components/ParticlMark.tsx — the same seven dots as
 * public/particl-mark.svg on the same `34 72 132 56` viewBox, in
 * `currentColor`, so nothing is redrawn and nothing is fetched.
 */
export function MobileHeader({
  account,
  projectName,
  onOpenSuiteMenu,
  suiteMenuOpen,
}: {
  account: WorkspaceAccount | null;
  projectName: string;
  onOpenSuiteMenu: () => void;
  suiteMenuOpen: boolean;
}) {
  const ws = useWorkspace();
  const { state } = ws;
  /* The unit is the rate table's, never the balance's (lib/price.ts): a
     workspace on its own keys pays its vendors in dollars and holds no
     credits at all, and the slot says that rather than inventing a figure. */
  const { rates } = useSession();
  const credits = creditsLabel(account?.credits?.balance ?? null, rates.unit);
  const suite = getSuite(state.suite);
  const level = state.mobile;
  const onProjects = level === "projects";

  const title =
    level === "projects" ? suite.short
      : level === "suite" ? suite.name
        : level === "make" ? "Make"
          : level === "settings" ? "Settings"
            : pageDef(state.page).title;
  const sub =
    level === "projects" ? suite.desc
      : level === "suite" ? projectName
        : level === "make" ? "Unfiled wall"
          : level === "settings" ? (account?.workspace?.name ?? "")
            : [suite.short, projectName].filter(Boolean).join(" · ");
  const showDot = level !== "make" && level !== "settings";

  return (
    <header className="pxm-header" data-testid="mobile-header">
      {onProjects ? (
        <button type="button" className="pxm-hit" aria-label={`${suite.name} · pick a suite`} aria-expanded={suiteMenuOpen} onClick={onOpenSuiteMenu}>
          <ParticlMark size={26} />
        </button>
      ) : (
        <button type="button" className="pxm-hit" data-testid="mobile-back" aria-label="Back" onClick={ws.back}>
          <IconArrowLeft />
        </button>
      )}
      <button
        type="button"
        className="pxm-nav-title"
        data-testid="mobile-title"
        aria-expanded={onProjects ? suiteMenuOpen : undefined}
        onClick={onProjects ? onOpenSuiteMenu : ws.back}
      >
        <span className="pxm-nav-title-row">
          <span className="pxm-nav-title-text">{title}</span>
          {onProjects ? <span className="pxm-caret" aria-hidden="true">▼</span> : null}
        </span>
        <span className="pxm-nav-sub-row">
          {showDot ? <span className="pxm-dot6" style={{ background: suite.dot }} aria-hidden="true" /> : null}
          <span className="pxm-nav-sub">{sub}</span>
        </span>
      </button>
      {/* The balance, at every level. It is one node, always mounted: a
          missing figure shows the neutral placeholder creditsLabel() picks,
          because a phone that hides what a screen is about to spend is worse
          than one that admits it does not know yet. */}
      <span
        className="pxm-credits"
        data-functional-label=""
        data-testid="mobile-credits"
        data-known={credits.known ? "" : undefined}
        title={credits.title}
        aria-label={credits.known ? `${credits.text} — ${credits.title.toLowerCase()}` : credits.title}
      >
        <span className="pxm-credits-figure">{credits.text}</span>
      </span>
      <button type="button" className="pxm-hit pxm-hit-control" data-testid="mobile-search" aria-label="Search" onClick={() => ws.setSheet("search")}>
        <IconSearch />
      </button>
      <button
        type="button"
        className="pxm-hit"
        data-testid="mobile-avatar"
        aria-label={`${account?.workspace?.name ?? "Workspace"} · usage and settings`}
        title={account?.workspace?.name ?? undefined}
        onClick={() => ws.setLevel("settings")}
      >
        <span className="pxm-avatar" aria-hidden="true">{initialsOf(account?.workspace?.name)}</span>
      </button>
    </header>
  );
}
