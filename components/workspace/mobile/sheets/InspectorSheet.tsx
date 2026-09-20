"use client";
import { INSPECTOR_BODIES } from "../../inspector/registry";
import { useWorkspace } from "@/lib/workspace/state";
import type { MobileSheetBodyProps } from "./registry";

/**
 * The Inspector sheet (05-mobile "Sheets": Controls / Inputs / Versions — "the
 * desktop inspector, unchanged in content").
 *
 * Unchanged means unchanged: this renders the desktop registry's own body for
 * the current selection kind (components/workspace/inspector/registry.tsx),
 * over the same `state`, the same scope and the same project. The
 * Controls / Inputs / Versions control lives inside those bodies and reads
 * `state.inspTab`, so it is the same control — and an edit made here persists
 * exactly as it does on the desktop, because it goes through the same
 * useRig / draft-editor writes. The phone contributes the chrome and nothing
 * else.
 */
export function InspectorSheet({ scope, project }: MobileSheetBodyProps) {
  const { state } = useWorkspace();
  const Body = INSPECTOR_BODIES[state.selKind];
  return (
    <div className="pxw-inspector-body pxm-inspector" data-testid="mobile-inspector-body">
      <Body state={state} scope={scope} project={project} />
    </div>
  );
}
