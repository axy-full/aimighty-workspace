/**
 * Tests only (ENGINE_MOCK=1): mocked video jobs that wait in their vendor's queue, so the queued cancel (lib/queuedCancel.ts) can
 * be walked end to end without a vendor. A mock id is `mock_<vendor>_<tag>_<time>`; a tag ending in
 *  - `-queued`: waits in the queue until cancelled, then the vendor says so (Ark: status cancelled; fal: an explicit cancelled error);
 *  - `-running`: is already being made, and refuses a cancel;
 *  - `-cancelerror`: waits, but the vendor cannot be reached to cancel it;
 *  - `-turnsrunning`: waits, the vendor accepts the cancel (fal's 202 is the same either way) and the job then reads running;
 *  - `-silentgone`: waits, the vendor accepts the cancel, and afterwards no longer knows the request, with no word of a cancellation.
 * Nothing outside the mock reads them. Self-contained on purpose (no import from lib/mock.ts): a real id is never `mock_…`.
 */
export type MockQueueKind = "queued" | "running" | "cancelerror" | "turnsrunning" | "silentgone";
const KINDS: readonly MockQueueKind[] = ["queued", "running", "cancelerror", "turnsrunning", "silentgone"];

export function mockQueueKind(id: string): MockQueueKind | null {
  if (!id.startsWith("mock_")) return null;
  const parts = id.split("_");
  const tag = parts.length >= 4 ? parts.slice(2, -1).join("_") : "";
  return KINDS.find((kind) => tag.endsWith(`-${kind}`)) ?? null;
}

/** What the vendor says of a job after it accepted a cancel. */
export type MockAftermath = "cancelled" | "running" | "gone";
const after = new Map<string, MockAftermath>();
export const mockAftermath = (id: string): MockAftermath | null => after.get(id) ?? null;

/** The vendor's answer to a cancel: it accepts while the job is queued, refuses once it is being made, and may fail. */
export function mockCancel(id: string): "accepted" | "running" {
  const kind = mockQueueKind(id);
  if (kind === "cancelerror") throw new Error("The vendor could not be reached to cancel this job.");
  if (kind === null || kind === "running") return "running";
  after.set(id, kind === "turnsrunning" ? "running" : kind === "silentgone" ? "gone" : "cancelled");
  return "accepted";
}
