import type { TenantWorkspace } from "./tenant";
import { isHouseWorkspace } from "./houseWorkspace";

/**
 * What Cinema Studio 4.0's Sound switch (`generate_audio`) costs, and where it is offered.
 *
 * The provider's published pricing for this model counts pixels and seconds and names no charge for sound, its free
 * estimate returns that text rather than a figure, and its job status states no charge. So the cost of sound is
 * measured from the provider's own bill and set privately, in the environment, never in the code:
 *
 *   HF_CINEMA_STUDIO_SOUND_PRICING = a JSON object in the provider's dollars, before Particl's credit terms:
 *     multiplier    the generated seconds' token cost is multiplied by this (1 = no change; reference-clip
 *                   seconds are not multiplied); from 1 to 4
 *     perSecondUsd  added for each generated second; from 0 to 1
 *     perTakeUsd    added once per take; from 0 to 10
 *   Any one or more of the three; one left out changes nothing. Anything else (a key it does not know, a value out
 *   of range or not a number, malformed JSON, an empty object) counts as unset, and is logged once without its value.
 *
 * Unset, the switch is not offered and admission refuses a take asked for with sound, before anything is reserved or
 * sent, except in the house workspace (lib/houseWorkspace.ts, named by its id, never by the legacy flag). That one is
 * metered at cost and never billed in credits, so there sound may still be asked for (and costs what the provider
 * bills), which is how its charge is measured.
 *
 * Set, the switch is offered everywhere, and the sound cost is part of the take's price wherever the price is made:
 * the quote and the credit ceiling approved on Generate, the re-price before dispatch, and the settlement on the
 * delivered output (lib/cinemaStudio.ts). It goes through the same credit terms as every other provider cost.
 */
export const CINEMA_SOUND_PRICING_ENV = "HF_CINEMA_STUDIO_SOUND_PRICING";
export const CINEMA_SOUND_UNAVAILABLE = "Sound isn't available for Cinema Studio yet.";

export type CinemaSoundPricing = { multiplier: number; perSecondUsd: number; perTakeUsd: number };

const RANGES: Readonly<Record<keyof CinemaSoundPricing, readonly [number, number]>> = {
  multiplier: [1, 4],
  perSecondUsd: [0, 1],
  perTakeUsd: [0, 10],
};

/** The sound pricing a value states, or null: strict, so anything it does not fully understand counts as unset. */
export function parseCinemaSoundPricing(raw: unknown): CinemaSoundPricing | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  const pricing: CinemaSoundPricing = { multiplier: 1, perSecondUsd: 0, perTakeUsd: 0 };
  for (const [key, n] of entries) {
    if (!Object.hasOwn(RANGES, key)) return null;
    const [min, max] = RANGES[key as keyof CinemaSoundPricing];
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return null;
    pricing[key as keyof CinemaSoundPricing] = n;
  }
  return pricing;
}

let reported: string | undefined;
/** The sound pricing in force for this process, read from the environment each time. */
export function cinemaSoundPricing(): CinemaSoundPricing | null {
  const raw = process.env[CINEMA_SOUND_PRICING_ENV];
  const pricing = parseCinemaSoundPricing(raw);
  if (!pricing && raw?.trim() && raw !== reported) {
    reported = raw;
    console.warn(JSON.stringify({ level: "warn", event: "cinema.sound_pricing_invalid", env: CINEMA_SOUND_PRICING_ENV }));
  }
  return pricing;
}

/**
 * Whether this workspace may ask Cinema Studio for sound: anywhere once sound is priced, and always in the house
 * workspace (lib/houseWorkspace.ts: by its id; a workspace that only carries the legacy flag is not the house).
 */
export function cinemaSoundOffered(ws: Pick<TenantWorkspace, "id"> | null | undefined): boolean {
  return cinemaSoundPricing() != null || isHouseWorkspace(ws);
}

/**
 * What sound adds to one take, in the provider's dollars: nothing until it is priced. `outputUsd` is the token cost of
 * the generated seconds alone, at the take's rate; `seconds` is how many were generated.
 */
export function cinemaSoundUsd(pricing: CinemaSoundPricing | null, take: { seconds: number; outputUsd: number }): number {
  if (!pricing) return 0;
  return (pricing.multiplier - 1) * take.outputUsd + pricing.perSecondUsd * take.seconds + pricing.perTakeUsd;
}
