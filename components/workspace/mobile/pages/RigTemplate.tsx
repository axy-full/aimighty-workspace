"use client";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { useWorkspace } from "@/lib/workspace/state";
import { useRig } from "../../rig/RigProvider";
import { FlowPage } from "./FlowPage";
import { ShotListPage } from "./ShotListPage";

/**
 * Rig on the phone: the shot list by default, the flow as its second tab —
 * templates 1 and 2 of 05-mobile over one page, switched on `rigView`, the same
 * state the desktop page's segmented control sets.
 *
 * It publishes the Rig plan's request bodies exactly as the desktop RigPage
 * does, so the plan dispatches what the shots actually are rather than
 * something a second surface assembled.
 */
export function RigTemplate() {
  const { state } = useWorkspace();
  const rig = useRig();
  usePlanRequest("shots", rig.planRequests);
  return state.rigView === "graph" ? <FlowPage /> : <ShotListPage />;
}
