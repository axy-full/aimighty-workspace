"use client";

import { useSession } from "@/lib/session";

/** A suspended workspace says so on every screen; rendering is paused, reading is not. */
export default function SuspendedBar() {
  const { workspace } = useSession();
  if (!workspace?.suspended) return null;
  return (
    <div className="suspended-bar" role="status">
      This workspace is suspended{workspace.suspendedReason ? ` — ${workspace.suspendedReason}` : ""}. Rendering is paused; everything already made is still here. Contact the platform.
    </div>
  );
}
