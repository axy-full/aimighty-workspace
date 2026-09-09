import { ratesFor } from "./vendorRates";
import { estimateTokens, costUsd, ACCOUNT_DISCOUNT } from "./models";
import type { TaskId } from "./tasks";

/**
 * What a job costs the PLATFORM, in the vendors' dollars.
 *
 * Server-side only, and structurally so: it reads lib/vendorRates.ts, which
 * is the file the browser must never be given. Every one of these used to
 * live in lib/models.ts beside the catalogue — which the composer imports —
 * so the engines' real per-second rates went into a public static chunk and
 * the platform's markup was one division away.
 *
 * The browser is served lib/rateTable.ts instead: the same arithmetic over a
 * table the server already converted into the unit that workspace pays in.
 * tests/unit/rateTable.spec.ts asserts the two agree across the catalogue, so
 * this stays the one definition of what a render costs and the other stays a
 * view of it.
 */

export function listRate(
  modelId: string, resolution: string, hasVideoInput = false
): number | null {
  const m = ratesFor(modelId);
  if (!m?.tiers) return null;
  const tier = m.tiers.find((t) => t.resolutions.includes(resolution.toLowerCase()));
  if (!tier) return null;
  return hasVideoInput ? tier.withVideo : tier.withoutVideo;
}

export function perSecondRate(
  modelId: string, resolution: string,
  opts: { audio?: boolean; task?: TaskId | string; fps60?: boolean } = {}
): number | null {
  const m = ratesFor(modelId);
  if (!m?.secondRates?.length) return null;
  const tier = m.secondRates.find((t) => t.resolutions.includes(resolution.toLowerCase())) ?? m.secondRates[0];
  const taskRate = opts.task && opts.task !== "generate" ? m.taskRates?.[opts.task as TaskId] : undefined;
  const base = taskRate ?? (opts.audio ? tier.withAudio : tier.withoutAudio);
  return base * (opts.fps60 ? 2 : 1);
}

export function estimateCostUsd(
  modelId: string, resolution: string, ratio: string, duration: number,
  inputSeconds = 0, hasVideoInput = false,
  opts: { audio?: boolean; task?: TaskId | string; fps60?: boolean } = {}
): { list: number; net: number } | null {
  /* Per-second engines: the rate times the seconds, and nothing to guess. */
  const perSecond = perSecondRate(modelId, resolution, opts);
  if (perSecond != null) {
    if (!(duration > 0)) return null;
    const c = Math.round(perSecond * duration * 10_000) / 10_000;
    return { list: c, net: c };
  }
  const tokens = estimateTokens(resolution, ratio, duration, inputSeconds);
  const list = listRate(modelId, resolution, hasVideoInput);
  if (tokens == null || list == null) return null;
  return {
    list: costUsd(tokens, list),
    net: costUsd(tokens, list * (1 - ACCOUNT_DISCOUNT)),
  };
}

export function estimateImageCostUsd(
  modelId: string, size: string, refImages = 0
): { list: number; net: number } | null {
  const m = ratesFor(modelId);
  const table = m?.imagePricing ?? IMAGE_OUT_USD;
  const out = table[size.toUpperCase()] ?? table[size];
  if (out == null) return null;
  const total = out + refImages * (m?.imageRefInUsd ?? IMAGE_REF_IN_USD);
  return { list: total, net: total };
}

export const IMAGE_OUT_USD: Record<string, number> = { "1K": 0.134, "2K": 0.134, "4K": 0.24 };

export const IMAGE_REF_IN_USD = 0.0011;

/** What we actually pay: list rate less the account discount. */
export function effectiveRate(
  modelId: string, resolution: string, hasVideoInput = false
): number | null {
  const list = listRate(modelId, resolution, hasVideoInput);
  return list == null ? null : list * (1 - ACCOUNT_DISCOUNT);
}
