"use client";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { INSPECTOR_BODIES, KIND_LABEL } from "@/components/workspace/inspector/registry";
import { AssetInspector } from "./AssetInspector";
import { ToolsInspector } from "./atomik/ToolsView";
import { MemoryInspector } from "./atomik/MemoryView";
import { SkillsInspector } from "./atomik/SkillsView";

/** Right, 320px (an overlay below 1280); ⌘J. The body follows the selection. `held`: a link to a take is still being checked, and nothing about the take shows until it resolves. */
export function Inspector({ scope, project, overlay, held = false }: { scope: string; project: Project | null; overlay: boolean; held?: boolean }) {
  const { state } = useWorkspace();
  const shell = useShell();
  /* The Cast stage edits its entries in place and selects nothing into the Inspector, so there it shows the stage. */
  const kind = held || (state.selKind === "cast" && shell.page.own && shell.page.id === "cast") ? "page" : state.selKind;
  const Body = INSPECTOR_BODIES[kind];
  /* Atomik › Tools & connections is the shell's own page; the legacy spec behind its page id (the old Skills registry) describes nothing on it. */
  const tools = kind === "page" && shell.page.own === true && shell.suite.id === "atomik" && shell.page.id === "skills";
  /* Atomik › Memory shares Agent's backing page; the Agent's spec describes nothing on it. */
  const memory = kind === "page" && shell.page.own === true && shell.suite.id === "atomik" && shell.page.id === "memory";
  /* Atomik › Skills shares Agent's backing page too. */
  const skills = kind === "page" && shell.page.own === true && shell.suite.id === "atomik" && shell.page.id === "saved-skills";
  return (
    <aside className={`gx-panel gx-inspector${overlay ? " gx-panel--overlay" : ""}`} aria-label="Inspector" data-testid="inspector">
      <div className="gx-insp-head">
        <span className="gx-panel-title">Inspector</span>
        <span className="gx-pill">{KIND_LABEL[kind]}</span>
        {/* × hides it at every width (⌘J and the page-head toggle are the other two ways). */}
        <button type="button" className="gx-hbtn gx-panel-close gx-insp-x" onClick={() => (overlay ? shell.closePanels() : shell.toggleInspector())} aria-label="Hide inspector" title="Hide inspector · ⌘J" data-testid="close-inspector">×</button>
      </div>
      <div className="gx-insp-body gx-scroll">
        {state.selKind === "take" && state.selId && !held ? <AssetInspector scope={scope} project={project} id={state.selId} /> : tools ? <ToolsInspector /> : memory ? <MemoryInspector /> : skills ? <SkillsInspector /> : (
          <div className="pxw gx-legacy"><div className="pxw-inspector-body"><Body state={kind === state.selKind ? state : { ...state, selKind: kind }} scope={scope} project={project} /></div></div>
        )}
      </div>
    </aside>
  );
}
