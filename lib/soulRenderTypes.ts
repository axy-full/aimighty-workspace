/**
 * Soul identity renders on the platform's API key (browser-safe: names and
 * shapes only, no prices). A trained identity carries the render family it was
 * trained for (`model_version` v1, v2 or cinema on the provider's
 * custom-reference API) and renders only with that family's model:
 * v1 → Soul Standard, v2 → Soul 2, cinema → Soul Cinema.
 */
export const SOUL_VERSIONS = ["v1", "v2", "cinema"] as const;
export type SoulVersion = (typeof SOUL_VERSIONS)[number];

/** The render model each trained family renders with, by Particl model id. */
export const SOUL_RENDER_MODELS: Readonly<Record<SoulVersion, string>> = {
  v1: "hf-soul-standard",
  v2: "hf-soul-2",
  cinema: "hf-soul-cinema",
};
/** What a person reads for each family. */
export const SOUL_VERSION_LABELS: Readonly<Record<SoulVersion, string>> = {
  v1: "Soul Standard",
  v2: "Soul 2",
  cinema: "Soul Cinema",
};
/** The provider's documented request limits, shared by the three families. */
export const SOUL_RENDER_BATCHES = [1, 4] as const;
export type SoulRenderBatch = (typeof SOUL_RENDER_BATCHES)[number];
export const SOUL_RENDER_RESOLUTIONS = ["720p", "1080p"] as const;
export const SOUL_RENDER_RATIOS = ["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"] as const;
/** Likeness strength: above zero (zero drops the identity), at most one. */
export const SOUL_RENDER_STRENGTHS = [1, 0.8, 0.6] as const;

export const isSoulVersion = (value: unknown): value is SoulVersion =>
  typeof value === "string" && (SOUL_VERSIONS as readonly string[]).includes(value);
export const isSoulRenderModel = (id: string): boolean =>
  Object.values(SOUL_RENDER_MODELS).includes(id);
/** The family a render model belongs to, or null for any other model. */
export function soulVersionOf(modelId: string): SoulVersion | null {
  return SOUL_VERSIONS.find((version) => SOUL_RENDER_MODELS[version] === modelId) ?? null;
}
export const isSoulRenderBatch = (value: unknown): value is SoulRenderBatch =>
  typeof value === "number" && (SOUL_RENDER_BATCHES as readonly number[]).includes(value);
