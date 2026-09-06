import type { TaskId } from "./tasks";
/**
 * Model catalog + pricing — Seedance 2.x.
 *
 * Rates transcribed from the ModelArk pricing page (read 2026-08-25):
 * https://docs.byteplus.com/en/docs/ModelArk/1544106
 *
 * Two things the flat-rate version got wrong and this one gets right:
 *   1. Rates are TIERED BY OUTPUT RESOLUTION (2.5 at 1080p is 11.70, not 10.70).
 *   2. Rates differ depending on whether the INPUT includes video. Both
 *      tiers are live: edit and extend send a source video, and syncGeneration
 *      passes `hasVideoInput` so those renders price at the cheaper rate.
 *
 * Official token formula, same page:
 *   tokens = (input video duration + output duration) × w × h × fps / 1024
 * We do NOT use that formula, and should not: ModelArk's own docs say the
 * returned `usage.completion_tokens` is authoritative, and that where a
 * render falls under the per-model minimum the field already reports the
 * minimum that was actually billed. Computing tokens ourselves would miss
 * that floor. Failed generations are not charged.
 */

/**
 * Account-level discount off ModelArk list rates.
 *
 * Set to 0 on 2026-08-25: the introductory 20% no longer applies, so the
 * workspace now bills at list. Historical generations are unaffected —
 * each one snapshots the rate it was actually charged at.
 */
export const ACCOUNT_DISCOUNT = 0;

/**
 * PROMOTIONS — known to exist, deliberately NOT applied.
 *
 * BytePlus advertises time-limited discounts that no list-rate table carries.
 * The one that touches us is 1080p on Seedance 2.5, running 14 Aug to
 * 17 Oct 2026. (Two others cover Seedance 2.0 mini and 2.0 fast at 480p and
 * 720p, 7 Aug to 7 Oct — neither model is in this catalogue, so they are
 * noted only so nobody wonders later.)
 *
 * Two reasons it stays unapplied rather than being guessed at:
 *
 *   1. Nobody has confirmed it lands on THIS account. A promotion advertised
 *      publicly is not necessarily one your contract gets.
 *   2. The size is genuinely ambiguous. The English page reads "28% off",
 *      which is the shape of a mistranslated 折 — in Chinese pricing 2.8折
 *      means 28% OF list, i.e. 72% off. Those two readings differ by a
 *      factor of two and a half, and picking wrong is worse than not
 *      applying it at all.
 *
 * The answer is not to guess but to measure: record what the console says
 * (Usage › the vendor card › "Match it to the console") and the drift will
 * show both whether a discount applies and how big it really is. Only then
 * add it here, with its end date, so it stops on its own rather than
 * silently under-reporting from 17 Oct.
 *
 * There is no API that returns the billed cost of a single generation — the
 * task response carries tokens and nothing about money — so a computed
 * figure reconciled against the console is the best available, by design
 * rather than for want of trying.
 */

/**
 * Every whole second between two bounds.
 *
 * ModelArk documents `duration` as an interval — "[4, 30] or -1", "in whole
 * seconds" — not as a set of blessed values. Where only some integers in a
 * range are legal it says so plainly, as it does for `frames`: "All integer
 * values in the range [29, 289] that fit the format 25 + 4n". Nothing of the
 * sort qualifies duration, their own code samples use 11 and 20, and billing
 * is a continuous function of it.
 *
 * The old hand-picked lists were a guess at a set that was never a set, and
 * they withheld working lengths — including three seconds at the top of
 * Seedance 2.0, whose real ceiling is 15 rather than the 12 we offered.
 */
const seconds = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

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
  /** Which third-party API serves it. See lib/providers.ts. */
  provider: string;
  /** What the engine produces. Image engines skip duration/audio/refine. */
  kind: "video" | "image";
  /** Not offered in the composer's model menu — reached from its own screen. */
  hidden?: boolean;
  /** Which tasks this engine can be asked for. Absent means generate only.
   *  Editing and extension are Seedance 2.5 features: 2.0's own ceilings
   *  (three reference videos, fifteen seconds combined) show it was never
   *  meant for them, and lib/tasks.ts is transcribed wholly from the 2.5
   *  guide. Declaring it here keeps the model id honest — an id is what is
   *  SENT to the vendor, so a synthetic "…:edit" id would be sent verbatim
   *  and rejected. */
  supportsTasks?: TaskId[];
  /** The model's id on Vercel AI Gateway, when it is also served there. */
  gatewayId?: string;
  /** Still engines bill per image by size (USD), plus a little per reference in. */
  imagePricing?: Record<string, number>;
  imageRefInUsd?: number;
  /** Engines that bill by the SECOND of output (Kling, Topaz on fal), by
   *  resolution tier, with and without audio. Present instead of tiers. */
  secondRates?: { resolutions: string[]; withoutAudio: number; withAudio: number }[];
  /** Per-second rates for tasks priced apart from generation (motion control). */
  taskRates?: Partial<Record<TaskId, number>>;
  /** The fal endpoint family the engine is served at (see lib/falVideo.ts). */
  falEndpoint?: string;
  paramStyle: ParamStyle;
  tiers: RateTier[];
  resolutions: string[];
  ratios: string[];
  durations: number[];
  supportsAudio: boolean;
  supportsCameraFixed: boolean;
  /** Max images in omni reference-to-video mode. */
  maxReferenceImages: number;
  /** Max reference videos, and their combined duration ceiling (seconds). */
  maxReferenceVideos: number;
  maxVideoSecondsTotal: number;
  note?: string;
};

export const MODELS: ModelDef[] = [
  {
    id: "dreamina-seedance-2-5-260628",
    label: "Seedance 2.5",
    supportsTasks: ["generate", "edit", "extend"],
    short: "SD 2.5",
    family: "seedance-2",
    provider: "byteplus",
    kind: "video",
    paramStyle: "fields",
    tiers: [
      { resolutions: ["480p", "720p"], withoutVideo: 10.7, withVideo: 6.4 },
      { resolutions: ["1080p"],        withoutVideo: 11.7, withVideo: 7.0 },
    ],
    resolutions: ["480p", "720p", "1080p"],
    ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    // "Dreamina Seedance 2.5: Default -1; supports [4, 30] or -1."
    durations: seconds(4, 30),
    supportsAudio: true,
    supportsCameraFixed: false,
    maxReferenceImages: 30,
    maxReferenceVideos: 10,
    maxVideoSecondsTotal: 30,
    note: "Up to 30s, native audio. Highest fidelity.",
  },
  {
    id: "dreamina-seedance-2-0-260128",
    label: "Seedance 2.0",
    short: "SD 2.0",
    family: "seedance-2",
    provider: "byteplus",
    kind: "video",
    paramStyle: "fields",
    tiers: [
      { resolutions: ["480p", "720p"], withoutVideo: 7.0, withVideo: 4.3 },
      { resolutions: ["1080p"],        withoutVideo: 7.7, withVideo: 4.7 },
      { resolutions: ["4k"],           withoutVideo: 4.0, withVideo: 2.4 },
    ],
    resolutions: ["480p", "720p", "1080p", "4k"],
    ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    // "Dreamina Seedance 2.0 series: Default 5; supports [4, 15] or -1."
    durations: seconds(4, 15),
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxVideoSecondsTotal: 15,
    note: "Cheaper per token. 4K tier is listed but untested — verify before relying on it.",
  },
  /* ── Kling 3.0, on fal.ai ─────────────────────────────────────────────
   * Kuaishou's engine, billed per second of output: $0.084 without audio and
   * $0.126 with on Standard, $0.112 / $0.168 on Pro (fal, read 6 Sep 2026).
   * Text-to-video as it stands; a first-frame image makes it image-to-video
   * and a second image sets the last frame. Motion control is its locked
   * task: a still of a character plus a clip whose movement it borrows.
   * ------------------------------------------------------------------ */
  {
    id: "fal-ai/kling-video/v3/standard",
    label: "Kling 3.0",
    short: "KLING 3",
    family: "kling-3",
    provider: "fal",
    kind: "video",
    supportsTasks: ["generate", "motion"],
    falEndpoint: "fal-ai/kling-video/v3/standard",
    paramStyle: "fields",
    tiers: [],
    secondRates: [{ resolutions: ["1080p"], withoutAudio: 0.084, withAudio: 0.126 }],
    taskRates: { motion: 0.126 },
    resolutions: ["1080p"],
    ratios: ["16:9", "9:16", "1:1"],
    durations: seconds(3, 15),
    supportsAudio: true,
    supportsCameraFixed: false,
    maxReferenceImages: 2,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "Kuaishou's Kling 3.0 on fal — native audio, 3–15s, priced per second. A first-frame image turns it into image-to-video.",
  },
  {
    id: "fal-ai/kling-video/v3/pro",
    label: "Kling 3.0 Pro",
    short: "KLING 3 PRO",
    family: "kling-3",
    provider: "fal",
    kind: "video",
    supportsTasks: ["generate", "motion"],
    falEndpoint: "fal-ai/kling-video/v3/pro",
    paramStyle: "fields",
    tiers: [],
    secondRates: [{ resolutions: ["1080p"], withoutAudio: 0.112, withAudio: 0.168 }],
    taskRates: { motion: 0.168 },
    resolutions: ["1080p"],
    ratios: ["16:9", "9:16", "1:1"],
    durations: seconds(3, 15),
    supportsAudio: true,
    supportsCameraFixed: false,
    maxReferenceImages: 2,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "The Pro tier: more detail and steadier motion, a third more per second.",
  },
  /* ── Topaz Astra, on fal.ai ───────────────────────────────────────────
   * Topaz Labs' creative video upscale (Astra 2): $0.30 a second up to
   * 1080p, $0.50 at 4K, doubled at 60 fps. It only ever works on a finished
   * clip, so its one task is Upscale and the composer reaches it that way.
   * ------------------------------------------------------------------ */
  {
    id: "topaz/upscale/video/creative",
    label: "Topaz Astra",
    short: "ASTRA",
    family: "topaz",
    provider: "fal",
    kind: "video",
    supportsTasks: ["upscale"],
    falEndpoint: "topaz/upscale/video/creative",
    paramStyle: "fields",
    tiers: [],
    secondRates: [
      { resolutions: ["1080p"], withoutAudio: 0.30, withAudio: 0.30 },
      { resolutions: ["4k"],    withoutAudio: 0.50, withAudio: 0.50 },
    ],
    resolutions: ["1080p", "4k"],
    ratios: ["adaptive"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 300,
    note: "Topaz Labs' Astra 2 — a creative upscale to 1080p or 4K that reimagines fine detail. Works on a finished clip.",
  },
  {
    // Google's Nano Banana Pro — stills, on the Gemini API (its own key).
    // Pricing read off ai.google.dev/gemini-api/docs/pricing on 2026-08-27:
    // image out $120/M tokens (1K & 2K = 1120 tok = $0.134, 4K = 2000 tok =
    // $0.24), each reference image in = 560 tok = $0.0011. SynthID watermark
    // is always embedded; the model "thinks" before drawing (built in).
    // Retired once for Google's moderation locks; back by request, with
    // refusals surfaced in Google's own words and never charged.
    id: "gemini-3-pro-image",
    gatewayId: "google/gemini-3-pro-image",
    label: "Nano Banana Pro",
    short: "NB PRO",
    family: "nano-banana",
    provider: "google",
    kind: "image",
    paramStyle: "fields",
    tiers: [],
    // Per image, from the gateway catalogue (identical to Google's list).
    imagePricing: { "1K": 0.1344, "2K": 0.1344, "4K": 0.24 },
    imageRefInUsd: 0.0011,
    resolutions: ["1K", "2K", "4K"],
    ratios: ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 14,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "Google's studio still-image model — up to 4K, legible text, up to 14 refs.",
  },
  {
    // Nano Banana 2 (Gemini 3.1 Flash Image): the fast, cheaper still engine.
    // Prices per image from the gateway catalogue, read 2026-09-03.
    id: "gemini-3.1-flash-image",
    gatewayId: "google/gemini-3.1-flash-image",
    label: "Nano Banana 2",
    short: "NB 2",
    family: "nano-banana",
    provider: "google",
    kind: "image",
    paramStyle: "fields",
    tiers: [],
    imagePricing: { "512": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 },
    imageRefInUsd: 0.0003,
    resolutions: ["512", "1K", "2K", "4K"],
    ratios: ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 14,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "Google's quick still engine — half the price of Pro, up to 4K, up to 14 refs.",
  },
  {
    // Flux with a trained identity's LoRA — what an Identity renders through.
    // Reached from the Studio's identity screen, never the composer: the
    // prompt has to carry the identity's trigger, which that screen adds.
    // Price per megapixel from fal's listing; a 1K frame is ~1 MP.
    id: "fal-ai/flux-lora",
    label: "Flux · Identity",
    short: "FLUX ID",
    family: "flux",
    provider: "fal",
    kind: "image",
    hidden: true,
    paramStyle: "fields",
    tiers: [],
    imagePricing: { "1K": 0.035 },
    imageRefInUsd: 0,
    resolutions: ["1K"],
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "A trained identity, rendered by Flux. Made from the Studio.",
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function getModel(id: string): ModelDef {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}

/** Engines that render sound rather than pictures live outside the video
 *  catalogue but still need names on the ledger. */
export const AUDIO_LABELS: Record<string, { label: string; short: string }> = {
  eleven_v3:              { label: "Eleven v3",              short: "11 v3" },
  eleven_multilingual_v2: { label: "Eleven Multilingual v2", short: "11 ML" },
  eleven_flash_v2_5:      { label: "Eleven Flash v2.5",      short: "11 FLASH" },
  eleven_turbo_v2_5:      { label: "Eleven Turbo v2.5",      short: "11 TURBO" },
  eleven_sfx:             { label: "Eleven Sound Effects",   short: "11 SFX" },
  eleven_music:           { label: "Eleven Music",           short: "11 MUSIC" },
};

/** A readable name for any model id, catalogue or not. */
export function modelLabel(modelId: string): string {
  return MODELS.find((m) => m.id === modelId)?.label ?? AUDIO_LABELS[modelId]?.label ?? modelId;
}

/** Short badge label for any model id — safe on retired/unknown ids. */
export function shortLabel(modelId: string): string {
  return MODELS.find((m) => m.id === modelId)?.short
    ?? AUDIO_LABELS[modelId]?.short
    ?? (modelId.includes("2-5") ? "SD 2.5" : modelId.includes("2-0") ? "SD 2.0"
      : modelId.includes("flash-image") ? "NB 2" : modelId.includes("image") ? "NB PRO" : modelId);
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
  const [rw, rh] = [Number(m[1]), Number(m[2])];
  // The resolution names the SHORT side. Treating it as the height regardless
  // of orientation made a 9:16 portrait look like 416×720 instead of 720×1280
  // — a cost estimate ~2.8× under what ByteDance actually bills.
  if (rw >= rh) return { h: up16(base), w: up16((base * rw) / rh) };
  return { w: up16(base), h: up16((base * rh) / rw) };
}

/**
 * Official formula: tokens = (input video duration + output duration) ×
 * output w × h × fps / 1024. Reference-video seconds are billed as if they
 * were output frames at the output resolution — at the cheaper with-video rate.
 */
export function estimateTokens(
  resolution: string, ratio: string, duration: number,
  inputSeconds = 0, fps = DEFAULT_FPS
): number | null {
  const d = dimensionsFor(resolution, ratio);
  if (!d) return null;
  return Math.round((d.w * d.h * fps * (duration + inputSeconds)) / 1024);
}

/** USD per second of output for a per-second engine, or null for the others. */
export function perSecondRate(
  modelId: string, resolution: string,
  opts: { audio?: boolean; task?: TaskId | string; fps60?: boolean } = {}
): number | null {
  const m = MODELS.find((x) => x.id === modelId);
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

/* ---------------------------------------------------------------------------
 * Image engines (Gemini / Nano Banana Pro) bill flat per image, not by
 * frame-tokens. Google's ledger figures, not ours:
 *   output 1K/2K = 1120 tokens ($0.134) · 4K = 2000 tokens ($0.24)
 *   each reference image in = 560 tokens ($0.0011)
 * ------------------------------------------------------------------------- */

export const IMAGE_OUT_USD: Record<string, number> = { "1K": 0.134, "2K": 0.134, "4K": 0.24 };
export const IMAGE_OUT_TOKENS: Record<string, number> = { "1K": 1120, "2K": 1120, "4K": 2000 };
export const IMAGE_REF_IN_USD = 0.0011;
export const IMAGE_REF_IN_TOKENS = 560;

export function estimateImageCostUsd(
  modelId: string, size: string, refImages = 0
): { list: number; net: number } | null {
  const m = MODELS.find((x) => x.id === modelId);
  const table = m?.imagePricing ?? IMAGE_OUT_USD;
  const out = table[size.toUpperCase()] ?? table[size];
  if (out == null) return null;
  const total = out + refImages * (m?.imageRefInUsd ?? IMAGE_REF_IN_USD);
  return { list: total, net: total };
}

export function imageTokens(size: string, refImages = 0): number | null {
  const out = IMAGE_OUT_TOKENS[size.toUpperCase()];
  if (out == null) return null;
  return out + refImages * IMAGE_REF_IN_TOKENS;
}
