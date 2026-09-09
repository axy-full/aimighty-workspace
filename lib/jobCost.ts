import { estimateCostUsd, estimateImageCostUsd } from "./vendorPricing";
import type { Row } from "./jobState";

/**
 * What a take costs before it has finished, in the vendors' dollars.
 *
 * Split out of lib/jobState.ts because that module is imported by the wall,
 * the theatre and the queue strip for its state helpers — and importing it
 * pulled lib/vendorRates.ts in behind, which put the engines' real rates into
 * a public chunk. The dollars stay here; the browser prices from the table in
 * lib/rateTable.ts.
 */

/** What a take costs, before it has finished: the held figure when it is held, else the catalogue's estimate. */
export function estimateForRow(r: Row): number | null {
  const p = (r.params ?? {}) as Record<string, unknown>;
  const held = p.held as { estUsd?: number } | undefined;
  if (held && typeof held.estUsd === "number") return held.estUsd;
  if (!r.model) return null;
  if (r.kind === "image") return estimateImageCostUsd(r.model, String(p.resolution ?? "1K"), Array.isArray(p.references) ? (p.references as unknown[]).length : 0)?.net ?? null;
  if (r.kind === "audio") return null;
  return estimateCostUsd(r.model, String(p.resolution ?? "1080p"), String(p.ratio ?? "16:9"), Number(p.duration ?? 0), 0, Boolean(p.hasVideoInput), { audio: Boolean(p.generateAudio), task: p.task as string | undefined, fps60: Boolean(p.fps60) })?.net ?? null;
}
