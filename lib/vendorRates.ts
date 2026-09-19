import type { TaskId } from "./tasks";
import { SOUL_CHARACTER_MODEL_ID, MARKETING_IMAGE_MODEL_ID } from "./models";

/** No published/current Soul Character price was verified. Operators must first
 * verify access and both rates using the authenticated estimate endpoint.
 * Private runtime configuration stays in the server's pricing layer. */
export function soulCharacterRates(): Record<string, number> | null {
  const low = Number(process.env.HF_SOUL_CHARACTER_USD_720P);
  const high = Number(process.env.HF_SOUL_CHARACTER_USD_1080P);
  return Number.isFinite(low) && low > 0 && Number.isFinite(high) && high > 0
    ? { "720p": low, "1080p": high } : null;
}

export function soulCharacterGenerationEnabled(): boolean {
  return process.env.HF_SOUL_CHARACTER_ENABLED === "1" && soulCharacterRates() !== null;
}

/**
 * What the vendors charge — in dollars, and never in a browser.
 *
 * These numbers used to live inside `MODELS` in lib/models.ts, which the
 * composer imports so it can reprice a duration change without a round trip.
 * That put the engines' real per-second rates into a PUBLIC static chunk:
 * `grep -o "withoutAudio:\\.[0-9]*" .next/static/chunks/*.js` returned
 * `.084`, `.112`, `.3`, `.5`. With the margin table — also a literal in the
 * bundle — a visitor could compute the platform's markup exactly, which §2 of
 * the scope of work says is never shown.
 *
 * So the catalogue and the rates are two files now. lib/models.ts describes
 * what a model IS and can go anywhere; this says what it COSTS and must not
 * leave the server.
 *
 * The enforcement is `tests/unit/bundle.spec.ts`, which greps the BUILT client
 * chunks for these numbers. That is deliberately not `import "server-only"`:
 * that throws in any plain Node context, so it would have made the very test
 * that compares the two pricing paths impossible to write — and a guard that
 * forbids checking the thing it guards is worse than the grep, which proves
 * the artifact rather than the intent.
 *
 * The browser is given lib/rateTable.ts instead — the same shape with every
 * figure already converted into the unit that workspace pays in.
 */

export type Tier = { resolutions: string[]; withoutVideo: number; withVideo: number };
export type SecondRate = { resolutions: string[]; withoutAudio: number; withAudio: number };

export type VendorRates = {
  tiers?: Tier[];
  secondRates?: SecondRate[];
  taskRates?: Partial<Record<TaskId, number>>;
  imagePricing?: Record<string, number>;
  imageRefInUsd?: number;
};

/** Keyed by model id. A model with no entry here cannot be priced. */
export const VENDOR_RATES: Record<string, VendorRates> = {
  // Live estimate only. An explicit empty table prevents the legacy image-price fallback.
  [MARKETING_IMAGE_MODEL_ID]: { imagePricing: {}, imageRefInUsd: 0 },
  get [SOUL_CHARACTER_MODEL_ID]() {
    return { imagePricing: soulCharacterGenerationEnabled() ? soulCharacterRates()! : {}, imageRefInUsd: 0 };
  },
  "dreamina-seedance-2-5-260628": {
    tiers: [{
      resolutions: ["480p", "720p"],
      withoutVideo: 10.7,
      withVideo: 6.4
    }, {
      resolutions: ["1080p"],
      withoutVideo: 11.7,
      withVideo: 7
    }]
  },
  "dreamina-seedance-2-0-260128": {
    tiers: [{
      resolutions: ["480p", "720p"],
      withoutVideo: 7,
      withVideo: 4.3
    }, {
      resolutions: ["1080p"],
      withoutVideo: 7.7,
      withVideo: 4.7
    }, {
      resolutions: ["4k"],
      withoutVideo: 4,
      withVideo: 2.4
    }]
  },
  "fal-ai/kling-video/v3/standard": {
    tiers: [],
    secondRates: [{
      resolutions: ["1080p"],
      withoutAudio: 0.084,
      withAudio: 0.126
    }],
    taskRates: {
      motion: 0.126
    }
  },
  "fal-ai/kling-video/v3/pro": {
    tiers: [],
    secondRates: [{
      resolutions: ["1080p"],
      withoutAudio: 0.112,
      withAudio: 0.168
    }],
    taskRates: {
      motion: 0.168
    }
  },
  "topaz/upscale/video/creative": {
    tiers: [],
    secondRates: [{
      resolutions: ["1080p"],
      withoutAudio: 0.3,
      withAudio: 0.3
    }, {
      resolutions: ["4k"],
      withoutAudio: 0.5,
      withAudio: 0.5
    }]
  },
  "fal-ai/luma-dream-machine/ray-2-flash/reframe": {
    tiers: [],
    secondRates: [{
      resolutions: ["adaptive"],
      withoutAudio: 0.06,
      withAudio: 0.06
    }]
  },
  // fal.ai/models/fal-ai/topaz/upscale/image, verified 14 September 2026.
  "fal-ai/topaz/upscale/image": { imagePricing: { "24MP": 0.08, "48MP": 0.16 }, imageRefInUsd: 0 },
  "fal-ai/bria/expand": {
    tiers: [],
    imagePricing: {
      adaptive: 0.04
    },
    imageRefInUsd: 0
  },
  "fal-ai/bria/background/remove": {
    tiers: [],
    imagePricing: {
      adaptive: 0.018
    },
    imageRefInUsd: 0
  },
  "gemini-3-pro-image": {
    tiers: [],
    imagePricing: {
      "1K": 0.1344,
      "2K": 0.1344,
      "4K": 0.24
    },
    imageRefInUsd: 0.0011
  },
  "gemini-3.1-flash-image": {
    tiers: [],
    imagePricing: {
      "512": 0.045,
      "1K": 0.067,
      "2K": 0.101,
      "4K": 0.151
    },
    imageRefInUsd: 0.0003
  },
  "fal-ai/flux-lora": {
    tiers: [],
    imagePricing: {
      "1K": 0.035
    },
    imageRefInUsd: 0
  },
};

export function ratesFor(modelId: string): VendorRates | null {
  return VENDOR_RATES[modelId] ?? null;
}

/**
 * ElevenLabs endpoints wired after the launch card, in the vendor's own
 * units (API pricing page, read 19 September 2026). Kept out of
 * `VENDOR_RATES`, which is keyed by catalogue models; the audio engine has
 * none. `lib/elevenlabs.ts` prices from these, never from a literal of its own.
 */
export const ELEVENLABS_RATES = {
  /** POST /v1/text-to-dialogue — model eleven_v3, at most 2,000 characters
   *  and 10 voices per request, billed per character like text-to-speech. */
  dialogue: { modelId: "eleven_v3", creditsPerChar: 1, maxChars: 2000, maxVoices: 10 },
  /** POST /v1/speech-to-speech/{voice_id} — model eleven_multilingual_sts_v2,
   *  $0.12 per minute of input audio. Facts only: the app does not call it
   *  until PR C2 verifies the contract (see docs/four-suites-v2-plan.md). */
  voiceChange: { modelId: "eleven_multilingual_sts_v2", usdPerMinute: 0.12 },
  /** POST /v1/dubbing — $0.33 to $2.20 per minute by tier, an asynchronous
   *  project with status and download calls. Not wired (PR C2). */
  dubbing: { usdPerMinuteMin: 0.33, usdPerMinuteMax: 2.2 },
} as const;
