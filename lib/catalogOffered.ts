import { ATOMIK_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS } from "./atomikModelPolicy";
import { ENHANCER_MODELS } from "./shell/enhancer";
import { DEFAULT_TEXT_MODELS } from "./platformLayer";
import { ASTRA_BLENDER_MODEL } from "./astra-blender/scene";
import { MODELS } from "./models";

/**
 * The catalogue ids Particl offers, for lib/modelCatalog.json
 * (scripts/ops/snapshot-catalog.mjs) and its price-presence test.
 */
const unique = (ids: Iterable<string>): string[] => [...new Set(ids)];

/** Text ids that must carry input and output prices: without one, the feature that picks them has nothing to quote. */
export const PRICED_TEXT_IDS: readonly string[] = unique([
  ...ATOMIK_MODEL_IDS,
  ...Object.values(ENHANCER_MODELS).flat(),
  ...Object.values(DEFAULT_TEXT_MODELS),
  ASTRA_BLENDER_MODEL,
]);

/** Nano Banana, GPT Image and Grok Imagine stills, by catalogue id. */
export const STILL_CATALOG_IDS: readonly string[] = unique(MODELS
  .filter((m) => m.kind === "image" && ["nano-banana", "gpt-image", "grok-imagine"].includes(m.family) && m.gatewayId)
  .map((m) => m.gatewayId as string));

export const OFFERED_CATALOG_IDS: readonly string[] = unique([
  ...VERIFIED_TEXT_MODEL_IDS, ...PRICED_TEXT_IDS, ...STILL_CATALOG_IDS,
]);
