import { estimateCostUsd, estimateImageCostUsd } from "./vendorPricing";
import { ENGINE_MODEL, type ShotEngine } from "./shotBuilder";

/**
 * What one take of a proposed shot costs, in the vendors' dollars.
 *
 * Test-only now: nothing in the app prices with it. The shot-draft route used
 * to send these dollars per take, and a credit workspace's page printed them
 * as credits; the page prices off the session's rate table instead
 * (lib/breakdownCost.ts). It stays as the independent vendor figure the unit
 * specs hold that table to (tests/unit/breakdownCost.spec.ts,
 * tests/unit/shotBuilder.spec.ts). Do not import it from a client component:
 * it pulls lib/vendorRates.ts, the engines' real rates, into a public chunk.
 */

export function shotCostUsd(engine: ShotEngine, planned: number | null): number {
  const secs = Math.max(5, planned ?? 5);
  if (engine === "nano-banana") return estimateImageCostUsd(ENGINE_MODEL["nano-banana"], "2K", 0)?.net ?? 0;
  return estimateCostUsd(ENGINE_MODEL[engine], "1080p", "16:9", secs, 0, false, { audio: engine === "seedance" })?.net ?? 0;
}
