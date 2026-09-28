/** Public controls from the Higgsfield model documentation: a source of at
 * least 4 seconds (Particl refuses anything over 30 rather than let it be
 * trimmed), 1–8 still references, and for Object Swap a source frame of at
 * least 409,600 pixels. 1080p is offered because the provider's estimate
 * prices it; every quote is still that live estimate for the actual source.
 * Consumer-site limits and presets are not the developer API contract. */
export const GENJUTSU_VARIANTS = ["motion-transfer", "object-swap"] as const;
export type GenjutsuVariant = (typeof GENJUTSU_VARIANTS)[number];
export const GENJUTSU_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type GenjutsuResolution = (typeof GENJUTSU_RESOLUTIONS)[number];
export const GENJUTSU_LIMITS = {
  minSeconds: 4,
  maxSeconds: 30,
  minImages: 1,
  maxImages: 8,
  /** Object Swap needs at least this many pixels in each source frame (width × height). */
  minObjectSwapPixels: 409_600,
  // Particl's bounded creative-input limit; not a claimed provider limit.
  maxPromptChars: 5000,
} as const;
export const GENJUTSU_MODELS = {
  "motion-transfer": "higgsfield-genjutsu-motion-transfer",
  "object-swap": "higgsfield-genjutsu-object-swap",
} as const;
export const GENJUTSU_LABELS = {
  "motion-transfer": "Motion Transfer",
  "object-swap": "Object Swap",
} as const;
export const GENJUTSU_DESCRIPTIONS = {
  "motion-transfer": "Carry a clip’s movement into a new character, setting or visual style.",
  "object-swap": "Replace a character, product, outfit or prop while retaining the surrounding shot.",
} as const;
export function genjutsuVariantForModel(model: string): GenjutsuVariant | null {
  return GENJUTSU_VARIANTS.find(variant => GENJUTSU_MODELS[variant] === model) ?? null;
}
export const isGenjutsuModel = (model: string) => genjutsuVariantForModel(model) !== null;
