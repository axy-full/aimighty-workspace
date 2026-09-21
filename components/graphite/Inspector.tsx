"use client";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { INSPECTOR_BODIES, KIND_LABEL } from "@/components/workspace/inspector/registry";

/** Right, 320px (an overlay below 1280); ⌘J. The body follows the selection. */
export function Inspector({ scope, project, overlay }: { scope: string; project: Project | null; overlay: boolean }) {
  const { state } = useWorkspace();
  const shell = useShell();
  const Body = INSPECTOR_BODIES[state.selKind];
  return (
    <aside className={`gx-panel gx-inspector${overlay ? " gx-panel--overlay" : ""}`} aria-label="Inspector" data-testid="inspector">
      <div className="gx-insp-head">
        <span className="gx-panel-title">Inspector</span>
        <span className="gx-pill">{KIND_LABEL[state.selKind]}</span>
        {overlay ? <button type="button" className="gx-hbtn gx-panel-close" onClick={shell.closePanels} data-testid="close-inspector">Close</button> : null}
      </div>
      <div className="gx-insp-body gx-scroll">
        <div className="pxw gx-legacy"><div className="pxw-inspector-body"><Body state={state} scope={scope} project={project} /></div></div>
      </div>
    </aside>
  );
}
