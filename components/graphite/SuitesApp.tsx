"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
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
     being left while this first renders, and the link's view and tab were lost.
     Only the first value is used: the shell writes view, tab and sp itself,
     and each of those writes updates useSearchParams too. */
  const search = useSearchParams().toString();
  const [initialSearch] = useState(search);
  /* The same element every time, so a URL change re-renders this component
     alone and not every provider below it. */
  const tree = useMemo(() => (
    <WorkspaceProvider initialSearch={initialSearch} plans={bridge.source} path={SUITES_PATH} keep={SHELL_PARAMS}>
      <ShellProvider initialSearch={initialSearch}>
        <RigProvider scope={scope}>
          <RigSeams>{(seams) => <SuitesShell scope={scope} initialAccount={initialAccount} planBridge={bridge} seams={seams} />}</RigSeams>
        </RigProvider>
      </ShellProvider>
    </WorkspaceProvider>
  ), [initialSearch, bridge, scope, initialAccount]);
  if (phase === "pending") return null;
  return tree;
}
