"use client";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { useWorkspace } from "@/lib/workspace/state";
import { RigAgentCard } from "./RigAgentCard";
import { RigGraph } from "./RigGraph";
import { RigList } from "./RigList";
import { useRig } from "./RigProvider";
import { TeamPresence } from "./TeamPresence";
import { RigImport } from "./RigImport";
import "./rig.css";

/** Rig: the shot list by default, the node graph as the advanced view; Atomik's run card above both. */
export function RigPage() {
  const { state } = useWorkspace();
  const rig = useRig();
  /* The Rig plan sends exactly these bodies; the plan never invents one. */
  usePlanRequest("shots", rig.planRequests);
  return (
    <>
      {/* An old board coming across (the old board's "Open in the new Rig"): what it is doing, and Try again. */}
      <RigImport />
      <TeamPresence />
      <RigAgentCard />
      {state.rigView === "graph" ? <RigGraph /> : <RigList />}
    </>
  );
}
