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

/**
 * Title (26/600) + hint; the page's view segment; on narrow widths the Library
 * and Inspector toggles; the primary action with its live quote. A blocked
 * primary says why beside the button — never a silent disabled button.
 */
export function PageHead({ project, onGenerate, generate }: { project: Project | null; onGenerate?: () => void; generate?: GenerateStatus }) {
  const shell = useShell();
  const { state, dispatch, setLibFilter } = useWorkspace();
  const atomik = useAtomik();
  const views = pageViews(state.page);
  const action = primaryAction(state.page);
  const availability = primaryAvailability(state, onGenerate, generate);
  const label = action.kind === "generate" && availability.enabled && generate?.quote ? `${action.label} · ${generate.quote}` : action.label;
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
      {!shell.wide ? (
        <>
          <button type="button" className="gx-hbtn" aria-pressed={shell.libOpen} onClick={shell.toggleLibrary} data-testid="toggle-library">Library</button>
          <button type="button" className="gx-hbtn" aria-pressed={shell.inspOpen} aria-keyshortcuts="Meta+J" onClick={shell.toggleInspector} data-testid="toggle-inspector">Inspector</button>
        </>
      ) : null}
      {!availability.enabled && availability.reason ? <span className="gx-reason" id="gx-action-reason" data-testid="primary-reason">{availability.reason}</span> : null}
      <button type="button" className="gx-primary" data-testid="primary-action" disabled={!availability.enabled} aria-describedby={availability.reason ? "gx-action-reason" : undefined} onClick={run}>
        {label}
      </button>
    </div>
  );
}
