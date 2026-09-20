"use client";
import type { Project } from "@/lib/workbench/studio";
import { useWorkspace } from "@/lib/workspace/state";
import { INSPECTOR_BODIES, KIND_LABEL } from "./inspector/registry";

/** 328px, flex:none. Header + kind pill; body by selection kind. */
export function Inspector({ scope, project }: { scope: string; project: Project | null }) {
  const { state } = useWorkspace();
  const Body = INSPECTOR_BODIES[state.selKind];
  return (
    <aside className="pxw-inspector" aria-label="Inspector" data-testid="inspector">
      <div className="pxw-inspector-head">
        <span className="pxw-panel-title">Inspector</span>
        <span className="pxw-kind-pill">{KIND_LABEL[state.selKind]}</span>
      </div>
      <div className="pxw-inspector-body">
        <Body state={state} scope={scope} project={project} />
      </div>
    </aside>
  );
}
