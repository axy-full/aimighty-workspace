/**
 * Model catalog + pricing — Seedance 2.x.
 *
 * Rates transcribed from the ModelArk pricing page (read 2026-08-25):
 * https://docs.byteplus.com/en/docs/ModelArk/1544106
 *
 * Two things the flat-rate version got wrong and this one gets right:
 *   1. Rates are TIERED BY OUTPUT RESOLUTION (2.5 at 1080p is 11.70, not 10.70).
 *   2. Rates differ depending on whether the INPUT includes video.
 *      We only do text-to-video today, so `withoutVideo` is what gets used —
 *      `withVideo` is carried for when reference/extend modes are added.
 *
 * Official token formula, same page:
 *   tokens = (input video duration + output duration) × w × h × fps / 1024
 * Billing uses `usage.completion_tokens` returned by the API. Failed
 * generations are not charged.
 */

/** Negotiated account discount with ByteDance. Applied to every list rate. */
export const ACCOUNT_DISCOUNT = 0.20;

/**
 * NOTE: BytePlus also runs public time-limited promos (e.g. 1080p on Seedance
 * 2.5 at 72% of list until 17 Sep 2026). Whether those stack with an account
 * discount is unconfirmed, so they are deliberately NOT applied here — the
 * figures below are list × (1 − ACCOUNT_DISCOUNT) and may be conservative.
 */

export type ParamStyle = "flags" | "fields";

export type RateTier = {
  resolutions: string[];
  withoutVideo: number;
  withVideo: number;
};

export type ModelDef = {
  id: string;
  label: string;
  short: string;
  family: string;
  paramStyle: ParamStyle;
  tiers: RateTier[];
  resolutions: string[];
  ratios: string[];
  durations: number[];
  supportsAudio: boolean;
  supportsCameraFixed: boolean;
  /** Max images in omni reference-to-video mode. */
  maxReferenceImages: number;
  note?: string;
};

export const MODELS: ModelDef[] = [
  {
    id: "dreamina-seedance-2-5-260628",
    label: "Seedance 2.5",
    short: "SD 2.5",
    family: "seedance-2",
    paramStyle: "fields",
    tiers: [
      { resolutions: ["480p", "720p"], withoutVideo: 10.7, withVideo: 6.4 },
      { resolutions: ["1080p"],        withoutVideo: 11.7, withVideo: 7.0 },
    ],
    resolutions: ["480p", "720p", "1080p"],
    ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
    supportsAudio: true,
    supportsCameraFixed: false,
    maxReferenceImages: 30,
    note: "Up to 30s, native audio. Highest fidelity.",
  },
  {
    id: "dreamina-seedance-2-0-260128",
    label: "Seedance 2.0",
    short: "SD 2.0",
    family: "seedance-2",
    paramStyle: "fields",
    tiers: [
      { resolutions: ["480p", "720p"], withoutVideo: 7.0, withVideo: 4.3 },
      { resolutions: ["1080p"],        withoutVideo: 7.7, withVideo: 4.7 },
      { resolutions: ["4k"],           withoutVideo: 4.0, withVideo: 2.4 },
    ],
    resolutions: ["480p", "720p", "1080p", "4k"],
    ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    durations: [4, 5, 6, 8, 10, 12],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 9,
    note: "Cheaper per token. 4K tier is listed but untested — verify before relying on it.",
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function getModel(id: string): ModelDef {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}

/** Undiscounted published rate, USD per million tokens. */
export function listRate(
  modelId: string, resolution: string, hasVideoInput = false
): number | null {
  let m: ModelDef;
  try { m = getModel(modelId); } catch { return null; }
  const tier = m.tiers.find((t) => t.resolutions.includes(resolution.toLowerCase()));
  if (!tier) return null;
  return hasVideoInput ? tier.withVideo : tier.withoutVideo;
}

/** What we actually pay: list rate less the account discount. */
export function effectiveRate(
  modelId: string, resolution: string, hasVideoInput = false
): number | null {
  const list = listRate(modelId, resolution, hasVideoInput);
  return list == null ? null : list * (1 - ACCOUNT_DISCOUNT);
}

export function costUsd(totalTokens: number, usdPerMillionTokens: number): number {
  return (totalTokens / 1_000_000) * usdPerMillionTokens;
}

/* ---------------------------------------------------------------------------
 * Token estimation. Verified against the published price examples:
 *   864×480  @24fps ×5s = 48,600 tokens
 *   1920×1088@24fps ×5s = 244,800 tokens
 * "adaptive" ratio returns null — frame size isn't known until render time.
 * ------------------------------------------------------------------------- */

const DEFAULT_FPS = 24;
const up16 = (n: number) => Math.ceil(n / 16) * 16;

export function dimensionsFor(resolution: string, ratio: string): { w: number; h: number } | null {
  const base = { "480p": 480, "720p": 720, "1080p": 1080, "2k": 1440, "4k": 2160 }[
    resolution.toLowerCase()
  ];
  if (!base) return null;
  const m = ratio.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return { h: up16(base), w: up16((base * Number(m[1])) / Number(m[2])) };
}

export function estimateTokens(
  resolution: string, ratio: string, duration: number, fps = DEFAULT_FPS
): number | null {
  const d = dimensionsFor(resolution, ratio);
  if (!d) return null;
  return Math.round((d.w * d.h * fps * duration) / 1024);
}

export function estimateCostUsd(
  modelId: string, resolution: string, ratio: string, duration: number
): { list: number; net: number } | null {
  const tokens = estimateTokens(resolution, ratio, duration);
  const list = listRate(modelId, resolution);
  if (tokens == null || list == null) return null;
  return {
    list: costUsd(tokens, list),
    net: costUsd(tokens, list * (1 - ACCOUNT_DISCOUNT)),
  };
}
