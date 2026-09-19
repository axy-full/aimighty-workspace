"use client";
import { suiteHref } from "@/lib/suites";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageBodyProps } from "../pages/registry";
import { RigList } from "./RigList";
import { useRig } from "./RigProvider";
import "./rig.css";

/** Rig: the shot list by default, the node graph as the advanced view. */
export function RigPage({ project }: PageBodyProps) {
  const { state } = useWorkspace();
  const rig = useRig();
  /* The Rig plan sends exactly these bodies; the plan never invents one. */
  usePlanRequest("shots", rig.planRequests);
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
