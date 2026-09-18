/** Public controls verified against the Higgsfield model catalogue.
 * Consumer-site limits and presets are not the developer API contract. */
export const GENJUTSU_VARIANTS = ["motion-transfer", "object-swap"] as const;
export type GenjutsuVariant = (typeof GENJUTSU_VARIANTS)[number];
export const GENJUTSU_RESOLUTIONS = ["480p", "720p"] as const;
export type GenjutsuResolution = (typeof GENJUTSU_RESOLUTIONS)[number];
export const GENJUTSU_LIMITS = {
  minSeconds: 1,
  maxSeconds: 30,
  maxImages: 8,
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
