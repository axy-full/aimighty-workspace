/**
 * Tests only (ENGINE_MOCK=1): a mocked video job whose tag ends in `-queued` waits in its vendor's queue until it is cancelled,
 * one ending in `-running` is already being made, and one ending in `-cancelerror` waits but its vendor refuses to cancel it.
 * They let the queued cancel (lib/queuedCancel.ts) be walked end to end without a vendor. Nothing outside the mock reads them.
 * Self-contained on purpose (no import from lib/mock.ts): a mock id is `mock_<vendor>_<tag>_<time>`, and a real id is never one.
 */
export type MockQueueKind = "queued" | "running" | "cancelerror";

export function mockQueueKind(id: string): MockQueueKind | null {
  if (!id.startsWith("mock_")) return null;
  const parts = id.split("_");
  const tag = parts.length >= 4 ? parts.slice(2, -1).join("_") : "";
  return tag.endsWith("-queued") ? "queued" : tag.endsWith("-running") ? "running" : tag.endsWith("-cancelerror") ? "cancelerror" : null;
}
const cancelled = new Set<string>();
export const mockIsCancelled = (id: string): boolean => cancelled.has(id);
/** The vendor's answer to a cancel: it takes it while the job is queued, refuses once it is being made, and may fail. */
export function mockCancel(id: string): "cancelled" | "running" {
  const kind = mockQueueKind(id);
  if (kind === "cancelerror") throw new Error("The vendor could not be reached to cancel this job.");
  if (kind !== "queued") return "running";
  cancelled.add(id);
  return "cancelled";
}
