/**
 * Explainer / faceless-video style presets on the connected account (slice F6),
 * READ-ONLY. `get_explainer_presets` is a free listing; this module keeps only
 * each preset's id, title and aspect. Preview media URLs are dropped (nothing
 * from the provider's CDN is loaded) and so is the preset's `prompt`, which is
 * provider-authored instruction text, not product copy.
 *
 * Generation is deliberately NOT wired: the explainer jobs (`video_explainer`,
 * `explainer_video`) are absent from the connected catalogue captured on
 * 19 September 2026 (`tests/fixtures/connected-models.json`), so there is no
 * catalogue-declared contract to validate against and no `get_cost` price
 * path this product accepts. `resolve_explainer_preset` imports media into
 * the connected account (a remote mutation) and is never called here.
 *
 * Pure (no database, no network) so the browser and the server share it.
 */
export const EXPLAINER_PRESETS_TOOL = "get_explainer_presets";
/** The catalogue ids a future priced explainer path would need. */
export const EXPLAINER_MODELS = Object.freeze(["video_explainer", "explainer_video"]);
export const EXPLAINER_ASPECTS = ["9:16", "16:9"] as const;
export const EXPLAINER_LIMITS = Object.freeze({ presets: 200 });
export type ExplainerPreset = { id: string; title: string; aspect: (typeof EXPLAINER_ASPECTS)[number] | null };
export type ExplainerPresets = { presets: ExplainerPreset[]; fetchedAt: number };
export class ExplainerPresetsError extends Error {
  readonly code = "invalid_presets";
  readonly status = 502;
  constructor() {
    super("The connected account returned an unusable explainer style list.");
    this.name = "ExplainerPresetsError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function parseExplainerPresets(raw: unknown, fetchedAt = Date.now()): ExplainerPresets {
  const items = object(raw) ? raw.items : Array.isArray(raw) ? raw : null;
  if (!Array.isArray(items) || items.length > EXPLAINER_LIMITS.presets) throw new ExplainerPresetsError();
  const seen = new Set<string>(), presets: ExplainerPreset[] = [];
  for (const item of items) {
    if (!object(item) || typeof item.id !== "string" || !UUID.test(item.id) || seen.has(item.id.toLowerCase())) continue;
    seen.add(item.id.toLowerCase());
    const title = typeof item.title === "string" ? item.title.replace(/\p{Cc}/gu, "").trim().slice(0, 120) : "";
    presets.push({
      id: item.id.toLowerCase(),
      title: title || "Untitled style",
      aspect: EXPLAINER_ASPECTS.includes(item.aspect as ExplainerPreset["aspect"] & string) ? (item.aspect as ExplainerPreset["aspect"]) : null,
    });
  }
  return { presets, fetchedAt };
}
/** Which explainer job ids the connected catalogue lists today. Empty means
 * there is no catalogue contract, hence no price path, for explainer videos. */
export function explainerModelsListed(catalogue: { models: readonly { id: string }[] }) {
  return EXPLAINER_MODELS.filter((id) => catalogue.models.some((model) => model.id === id));
}
