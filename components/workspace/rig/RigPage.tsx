"use client";
import { suiteHref } from "@/lib/suites";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageBodyProps } from "../pages/registry";
import { RigList } from "./RigList";
import "./rig.css";

/** Rig: the shot list by default, the node graph as the advanced view. */
export function RigPage({ project }: PageBodyProps) {
  const { state } = useWorkspace();
  if (state.rigView === "graph") {
    return (
      <div className="pxw-rig-graph-pending" data-testid="rig-graph">
        <p>The graph is the advanced view of the same shots. Everything here can be done from the shot list.</p>
        <a href={suiteHref("particl", project?.id ?? state.projectId, "canvas")}>Open the node graph</a>
      </div>
    );
  }
  return <RigList />;
}
