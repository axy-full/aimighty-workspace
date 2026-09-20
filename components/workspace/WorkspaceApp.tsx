"use client";
import { useState, useSyncExternalStore } from "react";
import { createPlanBridge } from "@/lib/workspace/atomik-host";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { WorkspaceProvider } from "@/lib/workspace/state";
import { MOBILE_QUERY } from "@/lib/workspace/mobile";
import { MobileShell } from "./mobile/MobileShell";
import { RigProvider, RigSeams } from "./rig/RigProvider";
import { WorkspaceShell } from "./WorkspaceShell";

/**
 * Which shell /workspace renders. Below 768px — and on a touch phone held
 * landscape, which is a phone whatever its width says — it is the phone shell
 * (05-mobile); at 768px and up it is the desktop shell, unchanged.
 *
 * The switch-over gate on the OLD entry points still sends phones to
 * /workbench (lib/workspace/switchover.ts PHONE_QUERY); that redirect flips in
 * its own PR once the phone build is complete. This module decides only what
 * /workspace itself renders.
 */
export { MOBILE_QUERY };

const subscribe = (update: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
};
/* Undecided on the server: render nothing until the browser answers, so a
   phone never flashes the desktop shell and a desktop never flashes the phone's. */
const snapshot = () => (window.matchMedia(MOBILE_QUERY).matches ? "phone" : "desktop");
const serverSnapshot = () => "pending";

export default function WorkspaceApp({ scope, initialAccount }: { scope: string; initialAccount: WorkspaceAccount | null }) {
  const device = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  /* The live plan source: filled by the Atomik host once a project's engine exists. */
  const [bridge] = useState(createPlanBridge);
  if (device === "pending") return null;
  /* One state layer for both shells: the phone is a different shell over the
     same machine, so the provider (and `go`, and the selection repair) is the
     same on either side of the breakpoint. */
  return (
    <WorkspaceProvider initialSearch={window.location.search} plans={bridge.source}>
      {device === "phone" ? (
        <MobileShell scope={scope} initialAccount={initialAccount} planBridge={bridge} />
      ) : (
        <RigProvider scope={scope}>
          <RigSeams>{(seams) => <WorkspaceShell scope={scope} initialAccount={initialAccount} planBridge={bridge} seams={seams} />}</RigSeams>
        </RigProvider>
      )}
    </WorkspaceProvider>
  );
}
