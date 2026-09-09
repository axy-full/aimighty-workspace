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

  /** Engines that bill by the SECOND of output (Kling, Topaz on fal), by
   *  resolution tier, with and without audio. Present instead of tiers. */
  /**
   * HOW this model is billed — not how much, which lives in lib/vendorRates.ts
   * and never reaches a browser. The composer needs the shape (does a token
   * count apply?) without needing the rate, and this is that shape.
   */
  billing: "second" | "token" | "image";
  /** Per-second rates for tasks priced apart from generation (motion control). */

  /** The fal endpoint family the engine is served at (see lib/falVideo.ts). */
  falEndpoint?: string;
  /** A still tool rather than a still engine: works on one still of ours (see lib/falImage.ts). */
  stillTask?: "outpaint" | "cutout";
  paramStyle: ParamStyle;

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
  /** One line on what the engine is for, next to it in the composer's menu. */
  use?: string;
};

export const MODELS: ModelDef[] = [
  {
    id: "dreamina-seedance-2-5-260628",
    billing: "token",
    use: "Standard video. Highest fidelity, native audio.",
    label: "Seedance 2.5",
    supportsTasks: ["generate", "edit", "extend"],
    short: "SD 2.5",
    family: "seedance-2",
    provider: "byteplus",
    kind: "video",
    paramStyle: "fields",
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
    billing: "token",
    use: "Cheaper drafts and roughs.",
    label: "Seedance 2.0",
    short: "SD 2.0",
    family: "seedance-2",
    provider: "byteplus",
    kind: "video",
    paramStyle: "fields",
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
    billing: "second",
    use: "Water, cloth, physics-heavy motion.",
    label: "Kling 3.0",
    short: "KLING 3",
    family: "kling-3",
    provider: "fal",
    kind: "video",
    supportsTasks: ["generate", "motion"],
    falEndpoint: "fal-ai/kling-video/v3/standard",
    paramStyle: "fields",
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
    billing: "second",
    use: "The same motion, steadier, for finals.",
    label: "Kling 3.0 Pro",
    short: "KLING 3 PRO",
    family: "kling-3",
    provider: "fal",
    kind: "video",
    supportsTasks: ["generate", "motion"],
    falEndpoint: "fal-ai/kling-video/v3/pro",
    paramStyle: "fields",
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
    billing: "second",
    use: "Upscale a finished clip to 4K.",
    label: "Topaz Astra",
    short: "ASTRA",
    family: "topaz",
    provider: "fal",
    kind: "video",
    supportsTasks: ["upscale"],
    falEndpoint: "topaz/upscale/video/creative",
    paramStyle: "fields",
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
  /* ── Luma Ray 2 Flash Reframe, on fal.ai ─────────────────────────────
   * Luma's reframe: a finished clip re-cut to another aspect, the missing
   * regions painted in. $0.06 a second, read off fal's model page on
   * 7 September 2026. Its one task is Reframe; the ratios are the seven
   * the endpoint accepts.
   * ------------------------------------------------------------------ */
  {
    id: "fal-ai/luma-dream-machine/ray-2-flash/reframe",
    billing: "second",
    use: "Re-cut a finished clip to 9:16 or 1:1.",
    label: "Luma Ray 2",
    short: "RAY2",
    family: "luma-ray-2",
    provider: "fal",
    kind: "video",
    supportsTasks: ["reframe"],
    falEndpoint: "fal-ai/luma-dream-machine/ray-2-flash/reframe",
    paramStyle: "fields",
    resolutions: ["adaptive"],
    ratios: ["9:16", "1:1", "16:9", "4:3", "3:4", "21:9", "9:21"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 300,
    note: "Luma's Ray 2 Flash reframe on fal — a finished clip re-cut to another aspect, the new frame's edges painted in. $0.06 a second.",
  },
  /* ── Bria on fal.ai: the still post tools (brief 1.2) ───────────────
   * Flat per image, read off fal's model pages on 7 September 2026:
   * Expand $0.04, RMBG 2.0 $0.018. Hidden from the Images menu — each is
   * reached from a still in the theatre, never asked to draw from nothing.
   * ------------------------------------------------------------------ */
  {
    id: "fal-ai/bria/expand",
    billing: "image",
    use: "Outpaint a still to another aspect.",
    label: "Bria Expand",
    short: "EXPAND",
    family: "bria",
    provider: "fal",
    kind: "image",
    hidden: true,
    stillTask: "outpaint",
    falEndpoint: "fal-ai/bria/expand",
    paramStyle: "fields",
    resolutions: ["adaptive"],
    ratios: ["9:16", "1:1", "16:9", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 1,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "Bria's Expand on fal — a still extended to another aspect, the new frame painted in. $0.04 an image.",
  },
  {
    id: "fal-ai/bria/background/remove",
    billing: "image",
    use: "Cut a still's subject out of its background.",
    label: "Bria Cutout",
    short: "CUTOUT",
    family: "bria",
    provider: "fal",
    kind: "image",
    hidden: true,
    stillTask: "cutout",
    falEndpoint: "fal-ai/bria/background/remove",
    paramStyle: "fields",
    resolutions: ["adaptive"],
    ratios: ["adaptive"],
    durations: [],
    supportsAudio: false,
    supportsCameraFixed: false,
    maxReferenceImages: 1,
    maxReferenceVideos: 0,
    maxVideoSecondsTotal: 0,
    note: "Bria's RMBG 2.0 on fal — the subject lifted off its background, transparent behind it. $0.018 an image.",
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
    billing: "image",
    use: "Stills with legible text; up to 14 refs.",
    gatewayId: "google/gemini-3-pro-image",
    label: "Nano Banana Pro",
    short: "NB PRO",
    family: "nano-banana",
    provider: "google",
    kind: "image",
    paramStyle: "fields",
    // Per image, from the gateway catalogue (identical to Google's list).
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
    billing: "image",
    use: "Quick stills at half the price.",
    gatewayId: "google/gemini-3.1-flash-image",
    label: "Nano Banana 2",
    short: "NB 2",
    family: "nano-banana",
    provider: "google",
    kind: "image",
    paramStyle: "fields",
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
    billing: "image",
    use: "A trained face, from the Studio.",
    label: "Flux · Identity",
    short: "FLUX ID",
    family: "flux",
    provider: "fal",
    kind: "image",
    hidden: true,
    paramStyle: "fields",
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
  if (rw >= rh) return { h: base, w: Math.round((base * rw) / rh) };
  return { w: base, h: Math.round((base * rh) / rw) };
}

/**
 * The frame the vendor BILLS, which is the frame above rounded up to the
 * next multiple of sixteen on each side — the grid a codec works in. It is
 * why 1080p costs what 1088 costs, and why the two numbers differ: the file
 * is 1920×1080, the meter counts 1920×1088.
 */
export function billedFrame(resolution: string, ratio: string): { w: number; h: number } | null {
  const d = dimensionsFor(resolution, ratio);
  return d ? { w: up16(d.w), h: up16(d.h) } : null;
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
  const d = billedFrame(resolution, ratio);
  if (!d) return null;
  return Math.round((d.w * d.h * fps * (duration + inputSeconds)) / 1024);
}

/** USD per second of output for a per-second engine, or null for the others. */


/* ---------------------------------------------------------------------------
 * Image engines (Gemini / Nano Banana Pro) bill flat per image, not by
 * frame-tokens. Google's ledger figures, not ours:
 *   output 1K/2K = 1120 tokens ($0.134) · 4K = 2000 tokens ($0.24)
 *   each reference image in = 560 tokens ($0.0011)
 * ------------------------------------------------------------------------- */

export const IMAGE_OUT_TOKENS: Record<string, number> = { "1K": 1120, "2K": 1120, "4K": 2000 };
export const IMAGE_REF_IN_TOKENS = 560;


export function imageTokens(size: string, refImages = 0): number | null {
  const out = IMAGE_OUT_TOKENS[size.toUpperCase()];
  if (out == null) return null;
  return out + refImages * IMAGE_REF_IN_TOKENS;
}

/**
 * How a model is billed — the shape, never the rate.
 *
 * The composer needs to know whether a frame-token count applies before it
 * can decide what to show; it does not need to know what a token costs. It
 * used to answer this by looking for `secondRates` on the model def, which is
 * why the rates had to be there.
 */
export function billingOf(modelId: string): ModelDef["billing"] {
  try { return getModel(modelId).billing; } catch { return "token"; }
}

/**
 * A model id as a person would say it.
 *
 * Here rather than in lib/enhance.ts, where it used to live: the theatre
 * imports it to name the prompt writer on a take, and enhance.ts reaches
 * getPlatformLayer → seedStarterProduction → the demo takes → the vendors'
 * dollars. A string formatter was dragging the platform's seeding stack, and
 * the engines' real per-second rates, into every wall in the product.
 */
export function prettyModel(id: string): string {
  const bare = id.split("/").pop() ?? id;
  if (/claude-opus-5/.test(bare)) return "Claude Opus 5";
  if (/claude-sonnet-5/.test(bare)) return "Claude Sonnet 5";
  if (/claude-haiku-4/.test(bare)) return "Claude Haiku 4.5";
  if (/gemini-3\.1-pro/.test(bare)) return "Gemini 3.1 Pro";
  if (/dola-seed-2-1/.test(bare)) return "Seed 2.1 Turbo";
  if (/seed-2-0-pro/.test(bare)) return "Seed 2.0 Pro";
  return bare;
}
