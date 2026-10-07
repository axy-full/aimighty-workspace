"use client";
import { useSyncExternalStore } from "react";

/*
 * Whether a board is on screen. The board is the Rig's page in the new interface: the Rig's provider
 * (components/workspace/rig/RigProvider.tsx) reads this so it opens the project, follows its jobs and catches up
 * while the board shows, as it does on the Rig page, whatever the address's backing page is.
 */
let open = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Marks a board as on screen until the returned function runs (a mount effect's cleanup). */
export function markBoardOpen(): () => void {
  open += 1;
  notify();
  return () => { open -= 1; notify(); };
}

export function useBoardOpen(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => open > 0,
    () => false,
  );
}
