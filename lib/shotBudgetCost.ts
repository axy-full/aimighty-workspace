import { estimateCostUsd } from "./vendorPricing";
import { DEFAULT_MODEL_ID } from "./models";
import { MIN_BILLED_SECONDS } from "./shotBudget";

/**
 * What a planned shot would cost, in the vendors' dollars.
 *
 * Split out of lib/shotBudget.ts because the wall imports `plannedLine` from
 * there for one sentence — "no takes yet · 5s planned · 40 cr a take" — and
 * that one import was pulling the estimator, and with it the engines' real
 * per-second rates, into the bundle of every screen that lists takes.
 *
 * The sentence stays client-safe and is handed its price. This is the half
 * that reads the vendor.
 */
export function plannedTakeUsd(planned: number | null | undefined, modelId: string = DEFAULT_MODEL_ID): number {
  const seconds = Math.max(MIN_BILLED_SECONDS, Number(planned) || MIN_BILLED_SECONDS);
  return estimateCostUsd(modelId, "1080p", "16:9", seconds)?.net ?? 0;
}
