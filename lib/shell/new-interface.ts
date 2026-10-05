"use client";
/* LOCAL STUB (stream 9, never committed): stream 1 owns lib/shell/new-interface.ts. Same name and type as its plan;
   locally the cookie `s09_new_interface=1` stands in for the per-workspace rollout. */
import { useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";

const noop = () => () => {};
const cookieOn = () => document.cookie.split(/;\s*/).includes("s09_new_interface=1");
export function useNewInterface(): boolean {
  const session = useSession() as { workspace?: { newInterface?: boolean } | null };
  const local = useSyncExternalStore(noop, cookieOn, () => false);
  return session.workspace?.newInterface === true || local;
}
