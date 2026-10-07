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

/*
 * The plan card's latest model, shared with the Inspector's body for the same run, so the steps are quoted once (the
 * Inspector would otherwise ask the server for every step's price a second time). A store of its own: publishing
 * never makes the board lay its cards out again.
 */
const models = new Map<string, { json: string; model: unknown }>();
const modelListeners = new Set<() => void>();
let modelVersion = 0;

export function publishPlanModel<T>(runId: string, model: T | null): void {
  const json = model === null ? "" : JSON.stringify(model);
  if (model === null ? !models.has(runId) : models.get(runId)?.json === json) return;
  if (model === null) models.delete(runId);
  else models.set(runId, { json, model });
  modelVersion += 1;
  for (const listener of modelListeners) listener();
}
const subscribeModels = (listener: () => void) => { modelListeners.add(listener); return () => { modelListeners.delete(listener); }; };
export function usePublishedPlanModel<T>(runId: string): T | null {
  useSyncExternalStore(subscribeModels, () => modelVersion, () => 0);
  return (models.get(runId)?.model as T | undefined) ?? null;
}
