import { useSyncExternalStore } from "react";

/*
 * Whether the plan card's steps are unfolded, per run, on this device only. The board lays a card out from its
 * size before it renders, and the unfolded card is taller, so the choice lives here, where both the card and the
 * layout read it (plan/derive.ts puts it in the card's data). A convenience; nothing is saved.
 */
const open = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export const planStepsOpen = (runId: string): boolean => open.has(runId);

export function setPlanStepsOpen(runId: string, value: boolean): void {
  if (open.has(runId) === value) return;
  if (value) open.add(runId);
  else open.delete(runId);
  version += 1;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Changes whenever any plan's steps are folded or unfolded: the board re-derives its cards on it. */
export const usePlanUiVersion = (): number => useSyncExternalStore(subscribe, () => version, () => 0);
