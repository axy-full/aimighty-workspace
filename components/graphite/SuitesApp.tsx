"use client";
import { useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { createPlanBridge } from "@/lib/workspace/atomik-host";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { WorkspaceProvider } from "@/lib/workspace/state";
import { RigProvider, RigSeams } from "@/components/workspace/rig/RigProvider";
import { SHELL_PARAMS, ShellProvider, SUITES_PATH } from "@/lib/shell/state";
import { SuitesShell } from "./SuitesShell";

const subscribe = () => () => {};
/* The shell reads the URL and the viewport, which only the browser has. */
const snapshot = () => "ready";
const serverSnapshot = () => "pending";

export default function SuitesApp({ scope, initialAccount }: { scope: string; initialAccount: WorkspaceAccount | null }) {
  const phase = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [bridge] = useState(createPlanBridge);
  /* The opening URL as the router has it. Arriving by a link from another
     page (a statement's "← Statements"), window.location still holds the page
     being left while this first renders, and the link's view and tab were lost. */
  const search = useSearchParams().toString();
  if (phase === "pending") return null;
  return (
    <WorkspaceProvider initialSearch={search} plans={bridge.source} path={SUITES_PATH} keep={SHELL_PARAMS}>
      <ShellProvider initialSearch={search}>
        <RigProvider scope={scope}>
          <RigSeams>{(seams) => <SuitesShell scope={scope} initialAccount={initialAccount} planBridge={bridge} seams={seams} />}</RigSeams>
        </RigProvider>
      </ShellProvider>
    </WorkspaceProvider>
  );
}
