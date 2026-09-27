"use client";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { INSPECTOR_BODIES, KIND_LABEL } from "@/components/workspace/inspector/registry";
import { AssetInspector } from "./AssetInspector";
import { ToolsInspector } from "./atomik/ToolsView";

/** Right, 320px (an overlay below 1280); ⌘J. The body follows the selection. */
export function Inspector({ scope, project, overlay }: { scope: string; project: Project | null; overlay: boolean }) {
  const { state } = useWorkspace();
  const shell = useShell();
  /* The Cast stage edits its entries in place and selects nothing into the Inspector, so there it shows the stage. */
  const kind = state.selKind === "cast" && shell.page.own && shell.page.id === "cast" ? "page" : state.selKind;
  const Body = INSPECTOR_BODIES[kind];
  /* Atomik › Tools & connections is the shell's own page; the legacy spec behind its page id (the old Skills registry) describes nothing on it. */
  const tools = kind === "page" && shell.page.own === true && shell.suite.id === "atomik" && shell.page.id === "skills";
  return (
    <aside className={`gx-panel gx-inspector${overlay ? " gx-panel--overlay" : ""}`} aria-label="Inspector" data-testid="inspector">
      <div className="gx-insp-head">
        <span className="gx-panel-title">Inspector</span>
        <span className="gx-pill">{KIND_LABEL[kind]}</span>
        {/* × hides it at every width (⌘J and the page-head toggle are the other two ways). */}
        <button type="button" className="gx-hbtn gx-panel-close gx-insp-x" onClick={() => (overlay ? shell.closePanels() : shell.toggleInspector())} aria-label="Hide inspector" title="Hide inspector · ⌘J" data-testid="close-inspector">×</button>
      </div>
      <div className="gx-insp-body gx-scroll">
        {state.selKind === "take" && state.selId ? <AssetInspector scope={scope} project={project} id={state.selId} /> : tools ? <ToolsInspector /> : (
          <div className="pxw gx-legacy"><div className="pxw-inspector-body"><Body state={kind === state.selKind ? state : { ...state, selKind: kind }} scope={scope} project={project} /></div></div>
        )}
      </div>
    </aside>
  );
}
