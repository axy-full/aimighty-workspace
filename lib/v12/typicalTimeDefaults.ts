/**
 * The one place the fallback render times live (redesign plan, decision 9).
 *
 * A render card says how long a take usually takes ("Seedance 2.5 · usually
 * 2–4 min · 1:12 so far"). The figure comes from real job history
 * (lib/v12/typicalTimes.server.ts, GET /api/v12/typical-times). Until an
 * engine has MIN_TYPICAL_SAMPLES finished takes to measure, these ranges
 * stand in. They are the prototype's placeholders (design/particl-prototype-12
 * README §A, "confirm"): change them here, nowhere else.
 *
 * Pure, with no imports: the server, the route and the browser read one copy.
 */

export type TypicalKind = "video" | "image" | "audio" | "other";
export type TypicalBounds = { lowMs: number; highMs: number };

/** Fewer finished takes than this, and history is not trusted: the fallback below is used. */
export const MIN_TYPICAL_SAMPLES = 10;

const S = 1_000;
const MIN = 60 * S;

/** Per engine (the take's `model` id), the prototype's placeholders. */
export const TYPICAL_DEFAULTS_BY_MODEL: Readonly<Record<string, TypicalBounds>> = {
  /* Seedance 2.5 · usually 2–4 min */
  "dreamina-seedance-2-5-260628": { lowMs: 2 * MIN, highMs: 4 * MIN },
  /* Kling 3.0 Standard · usually 1–2 min */
  "fal-ai/kling-video/v3/standard": { lowMs: 1 * MIN, highMs: 2 * MIN },
  /* Nano Banana 2 · usually 20–40 s */
  "gemini-3.1-flash-image": { lowMs: 20 * S, highMs: 40 * S },
};

/**
 * Per kind, for an engine with neither history nor a row above. Video and
 * stills take the prototype's two common engines' ranges; audio is its
 * ElevenLabs line ("~15 s"); anything else gets a wide video-like range.
 */
export const TYPICAL_DEFAULTS_BY_KIND: Readonly<Record<TypicalKind, TypicalBounds>> = {
  video: { lowMs: 2 * MIN, highMs: 4 * MIN },
  image: { lowMs: 20 * S, highMs: 40 * S },
  audio: { lowMs: 15 * S, highMs: 15 * S },
  other: { lowMs: 1 * MIN, highMs: 3 * MIN },
};

/** The fallback for one take: its engine's row, else its kind's. */
export function defaultTypical(model: string | null | undefined, kind: string | null | undefined): TypicalBounds {
  if (model && Object.hasOwn(TYPICAL_DEFAULTS_BY_MODEL, model)) return TYPICAL_DEFAULTS_BY_MODEL[model];
  const k: TypicalKind = kind === "video" || kind === "image" || kind === "audio" ? kind : "other";
  return TYPICAL_DEFAULTS_BY_KIND[k];
}
