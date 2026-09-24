"use client";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { useWorkspace } from "@/lib/workspace/state";
import { RigGraph } from "./RigGraph";
import { RigList } from "./RigList";
import { useRig } from "./RigProvider";
import { TeamPresence } from "./TeamPresence";
import "./rig.css";

/** Rig: the shot list by default, the node graph as the advanced view. */
export function RigPage() {
  const { state } = useWorkspace();
  const rig = useRig();
  /* The Rig plan sends exactly these bodies; the plan never invents one. */
  usePlanRequest("shots", rig.planRequests);
  return (
    <>
      <TeamPresence />
      {state.rigView === "graph" ? <RigGraph /> : <RigList />}
    </>
  );
}
