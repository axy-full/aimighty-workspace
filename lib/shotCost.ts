import { estimateCostUsd, estimateImageCostUsd } from "./vendorPricing";
import { ENGINE_MODEL, type ShotEngine } from "./shotBuilder";

/**
 * What a render cost, in the vendors' dollars.
 *
 * Split out of shotBuilder.ts because that module is imported by client
 * components for its types and its state helpers — and importing it pulled
 * lib/vendorRates.ts in behind, which put the engines' real rates into a
 * public chunk. The dollars stay on the server; the browser prices from the
 * table in lib/rateTable.ts.
 */

export function shotCostUsd(engine: ShotEngine, planned: number | null): number {
  const secs = Math.max(5, planned ?? 5);
  if (engine === "nano-banana") return estimateImageCostUsd(ENGINE_MODEL["nano-banana"], "2K", 0)?.net ?? 0;
  return estimateCostUsd(ENGINE_MODEL[engine], "1080p", "16:9", secs, 0, false, { audio: engine === "seedance" })?.net ?? 0;
}
