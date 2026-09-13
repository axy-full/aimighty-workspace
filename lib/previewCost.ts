import { estimateCostUsd } from "./vendorPricing";
import { previewItems, supportedDuration, type PreviewPlan } from "./previews";
import { billCreditsWith, multiplierFor, creditUsd } from "./creditTerms";
import { currentTenant } from "./tenant";

/**
 * The preview batch, priced in the vendors' dollars.
 *
 * Split out of lib/previews.ts because the admin console imports that module
 * for its lists of models, resolutions and durations — and importing it
 * pulled lib/vendorRates.ts in behind, which put the engines' real rates into
 * a public chunk.
 */
/** The batch, priced: the count times the catalogue's price for one clip, silent, 16:9, at the length the engine will really render. */
export function previewPlan(modelId: string, resolution: string, duration: number, internal = currentTenant()?.workspace?.internal === true): PreviewPlan {
  const items = previewItems();
  const d = supportedDuration(modelId, duration);
  const perClipUsd = estimateCostUsd(modelId, resolution, "16:9", d, 0, false, { audio: false })?.net ?? 0;
  /* Credits computed here, where the margin lives. The admin console is
     entitled to both figures — §7 says it shows margin — but it must be
     handed them by an authenticated route rather than converting in a
     browser, because converting needed the margin table to be in a chunk
     anyone could fetch by URL. */
  return {
    modelId, resolution, duration: d, items, count: items.length, perClipUsd,
    totalUsd: Math.round(perClipUsd * items.length * 100) / 100,
    /* At the multiplier of the workspace that renders them — cost when it is flagged internal (§7A guardrail 6),
       which the console's own workspace is — so the plan's figure is the figure its ledger bills. */
    perClipCredits: billCreditsWith(perClipUsd, multiplierFor(modelId, internal), creditUsd()),
    totalCredits: billCreditsWith(perClipUsd, multiplierFor(modelId, internal), creditUsd()) * items.length,
  };
}
