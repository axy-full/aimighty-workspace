"use client";
import type { Project } from "@/lib/workbench/studio";
import { suiteHref } from "@/lib/suites";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { pageViews, primaryAction } from "@/lib/workspace/pages";
import { runPageAction } from "@/lib/workspace/page-actions";
import { useWorkspace } from "@/lib/workspace/state";
import type { LibFilter, RigView } from "@/lib/workspace/types";
import { primaryAvailability, type GenerateStatus } from "@/components/workspace/PageHeader";
import { useShell } from "@/lib/shell/state";
import { PRODUCTION_AGENT_PAGES } from "@/lib/shell/production-tools";
import { isOwnerRunPage, isOwnerRunSuite } from "@/lib/shell/connected-capability";
import { isOwnPage } from "@/lib/shell/business-own";
import { useConnectedCapability } from "@/lib/shell/use-connected-capability";
import { Glyph } from "./icons";

/**
 * Title (26/600) + hint; the page's view segment; on narrow widths the Library
 * and Inspector toggles; the primary action with its live quote. A blocked
 * primary says why beside the button — never a silent disabled button.
 */
export function PageHead({ project, onGenerate, generate }: { project: Project | null; onGenerate?: () => void; generate?: GenerateStatus }) {
  const shell = useShell();
  const { state, dispatch, setLibFilter } = useWorkspace();
  const atomik = useAtomik();
  const { owner } = useConnectedCapability(undefined, { read: false });
  /* Studio › Takes filters on its own desk (status, kind, search); the workspace's view segment would do nothing there. */
  const views = shell.suite.id === "studio" && shell.page.id === "takes" ? [] : pageViews(state.page);
  const action = primaryAction(state.page);
  const availability = primaryAvailability(state, onGenerate, generate);
  /* What it does, then what it costs: the price is its own run of text, so a phone can set it under the action, whole. */
  const price = action.kind === "generate" && availability.enabled && generate?.quote ? generate.quote : null;
  const run = () => {
    if (action.kind === "generate") { if (availability.enabled) onGenerate?.(); return; }
    if (action.kind === "run-stage") { void atomik.start(state.page); return; }
    if (!runPageAction(state.page)) window.location.assign(suiteHref("particl", project?.id ?? state.projectId, action.kind === "upload" ? "assets" : "characters"));
  };
  const current = state.page === "rig" ? state.rigView : state.libFilter;
  return (
    <div className="gx-pagehead" data-row="page">
      <h1 className="gx-h1" data-testid="page-title">{shell.page.title}</h1>
      <span className="gx-hint" data-testid="page-hint">{shell.page.hint}</span>
      <span className="gx-spacer" />
      {views.length ? (
        <div className="gx-seg gx-seg--sm" role="tablist" aria-label={`${shell.page.title} view`}>
          {views.map((v) => (
            <button key={v.id} type="button" role="tab" className="gx-seg-btn" aria-selected={current === v.id}
              onClick={() => (state.page === "rig" ? dispatch({ type: "patch", patch: { rigView: v.id as RigView } }) : setLibFilter(v.id as LibFilter))}>
              <span>{v.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {/* A phone shows the glyphs and keeps the words for the name (components/graphite/phone.css). */}
      {!shell.wide ? <button type="button" className="gx-hbtn gx-hbtn--glyph" aria-pressed={shell.libOpen} onClick={shell.toggleLibrary} data-testid="toggle-library"><span className="gx-hbtn-glyph" aria-hidden="true"><Glyph name="stack" size={18} /></span><span className="gx-hbtn-label">Library</span></button> : null}
      {/* Every width: lit while the panel is open. */}
      <button type="button" className="gx-hbtn gx-hbtn--glyph" aria-pressed={shell.wide ? shell.inspector : shell.inspOpen} aria-keyshortcuts="Meta+J" onClick={shell.toggleInspector} data-testid="toggle-inspector"><span className="gx-hbtn-glyph" aria-hidden="true"><Glyph name="info" size={18} /></span><span className="gx-hbtn-label">Inspector</span></button>
      {/* A Production agent page prices and runs its own steps; a second "Run stage" would be another agent path.
          Atomik › Tools & connections has its own controls, and the plan behind its old Skills page has nothing to run.
          A suite or page that ran only on the connected account has no stage to run.
          Business's own tools (Brand … Design) price and run their own steps, like the Production agent pages, and Setup is a list. */}
      {(shell.suite.id === "studio" && PRODUCTION_AGENT_PAGES.has(shell.page.id)) || (shell.suite.id === "atomik" && (shell.page.id === "skills" || shell.page.id === "memory" || shell.page.id === "saved-skills")) || (shell.suite.id === "business" && (isOwnPage(shell.page.id) || shell.page.id === "setup")) || (!owner && (isOwnerRunSuite(shell.suite.id) || isOwnerRunPage(shell.suite.id, shell.page.id))) ? null : (<>
      {!availability.enabled && availability.reason ? <span className="gx-reason" id="gx-action-reason" data-testid="primary-reason">{availability.reason}</span> : null}
      <button type="button" className="gx-primary" data-testid="primary-action" disabled={!availability.enabled} aria-describedby={availability.reason ? "gx-action-reason" : undefined} onClick={run} data-priced={price ? "" : undefined}>
        <span className="gx-go-act">{action.label}</span>{price ? <span className="gx-go-price"><span className="gx-go-sep">{" · "}</span>{price}</span> : null}
      </button>
      </>)}
    </div>
  );
}
