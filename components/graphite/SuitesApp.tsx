"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { createPlanBridge } from "@/lib/workspace/atomik-host";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { WorkspaceProvider } from "@/lib/workspace/state";
import { RigProvider, RigSeams } from "@/components/workspace/rig/RigProvider";
import { ShellProvider, shellParams, SUITES_PATH } from "@/lib/shell/state";
import { normalize } from "@/lib/shell/ia";
import { fromMakeLink } from "@/lib/shell/make";
import { route, tracksParams } from "@/lib/shell/screens";
import { useNewInterface } from "@/lib/shell/new-interface";
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
     and each of those writes updates useSearchParams too. An old link in the
     design file's spelling is read in the app's (lib/shell/ia.ts › normalize). */
  const search = useSearchParams().toString();
  /* …and an old Gen or Viral quick-tool address is Make's own (lib/shell/make.ts), for the state layer as for the shell. */
  const on = useNewInterface();
  const [initialSearch] = useState(() => {
    const spelled = normalize(search);
    /* The screen registry's rows too (lib/shell/screens.ts), which the server has already applied to a signed-in request: with the
       switch on, every landed screen's; with it off, the board's alone (it shows for everyone). */
    return tracksParams(on) ? route(search, on) : fromMakeLink(spelled) ?? spelled;
  });
  /* The params the shell keeps across its own address writes: today's, plus the new screens' own with the switch on. */
  const keep = useMemo(() => shellParams(on), [on]);
  /* The same element every time, so a URL change re-renders this component
     alone and not every provider below it. */
  const tree = useMemo(() => (
    <WorkspaceProvider initialSearch={initialSearch} plans={bridge.source} path={SUITES_PATH} keep={keep}>
      <ShellProvider initialSearch={initialSearch}>
        <RigProvider scope={scope}>
          <RigSeams>{(seams) => <SuitesShell scope={scope} initialAccount={initialAccount} planBridge={bridge} seams={seams} />}</RigSeams>
        </RigProvider>
      </ShellProvider>
    </WorkspaceProvider>
  ), [initialSearch, bridge, scope, initialAccount, keep]);
  if (phase === "pending") return null;
  return tree;
}
