/**
 * A waiting take's place in its line, from what exists today (redesign plan
 * C1). Two lines can hold a take:
 *
 * - its workspace's own render slots: takes held for a slot (lib/held.ts,
 *   `params.held.why = "slots"`) start oldest first as slots free, so the
 *   place is 1 + the takes held for a slot before it;
 * - the platform's shared provider key (lib/providerPool.ts): the pool's own
 *   order (`servingOrder`, the order `poolVerdict` admits by: fewest takes in
 *   flight per workspace first, then longest waiting), so the place is 1 + the
 *   takes served before it. Only the number leaves, never another
 *   workspace's ids.
 *
 * A provider's own queue position is not known: fal returns one, but
 * lib/engines/fal.ts drops it, and keeping it would be an engine change
 * (follow-up). Pure (the server reads the rows: queuePosition.server.ts).
 */
import { servingOrder, type PoolState } from "../providerPool";

export type SlotWaiter = { id: string; createdAt: number; why?: string | null; pool?: string | null };

/** Place in the workspace's own slot line, per take held for a slot (not the shared pool's). */
export function slotLinePositions(held: readonly SlotWaiter[], poolMark: string): Map<string, number> {
  const line = held.filter((h) => h.why === "slots" && h.pool !== poolMark)
    .slice().sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(line.map((h, i) => [h.id, i + 1]));
}

/** Place in the shared pool's line for one of this workspace's waiting takes: 1 when it is served next. */
export function poolPosition(state: PoolState, take: { id: string; workspaceId: string; queuedAt: number }): number {
  return servingOrder(state, take).findIndex((p) => p.candidate) + 1;
}
