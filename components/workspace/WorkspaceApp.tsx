"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { WorkspaceProvider } from "@/lib/workspace/state";
import { WorkspaceShell } from "./WorkspaceShell";

/**
 * Phones keep the existing phone surface: below 760px, and on a touch phone
 * held landscape (short and coarse-pointed), /workspace hands over to
 * /workbench with the same project instead of rendering the desktop shell.
 */
export const PHONE_QUERY = "(max-width: 759px), (hover: none) and (pointer: coarse) and (max-height: 500px)";

const subscribe = (update: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
};
/* Undecided on the server: render nothing until the browser answers, so a
   phone never flashes the desktop shell. */
const snapshot = () => (window.matchMedia(PHONE_QUERY).matches ? "phone" : "desktop");
const serverSnapshot = () => "pending";

export function phoneSurfaceHref(search: string) {
  const project = new URLSearchParams(search).get("project");
  return "/workbench" + (project ? "?" + new URLSearchParams({ project }) : "");
}

export default function WorkspaceApp({ scope, initialAccount }: { scope: string; initialAccount: WorkspaceAccount | null }) {
  const device = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    if (device === "phone") window.location.replace(phoneSurfaceHref(window.location.search));
  }, [device]);
  if (device !== "desktop") return null;
  return (
    <WorkspaceProvider initialSearch={window.location.search}>
      <WorkspaceShell scope={scope} initialAccount={initialAccount} />
    </WorkspaceProvider>
  );
}
