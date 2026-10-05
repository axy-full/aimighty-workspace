"use client";
import { useSession } from "@/lib/session";

/**
 * Whether this workspace sees the new interface (the per-workspace switch, lib/shell/new-interface-model.ts). The
 * server reads it once per page load (lib/shell/new-interface.server.ts › newInterfaceEnabled) and puts one boolean
 * on the session, so this is a plain read: no request, no flicker, and the list of workspaces never reaches a browser.
 * Off for a visitor and on every page that is not the Suites shell.
 */
export function useNewInterface(): boolean {
  return useSession().workspace?.newInterface === true;
}
