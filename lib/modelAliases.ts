/**
 * Model ids Particl no longer offers, each moved to the nearest model it does
 * (owner, 8 October 2026). These cannot run when Particl calls the provider
 * directly: the fast and Pro variants, Claude 3 Haiku and the small open-weight
 * model are not served on a direct key, and the Pro models have no cached-input
 * price, so a direct quote refuses them.
 *
 * A saved choice naming one (a chat, an idea, a board agent's run, the platform's
 * routing, an env default) is read as its alias, before any check, so nothing
 * saved breaks and no database row is rewritten. The alias is the model that
 * runs, so it is also the model that is quoted and billed. Every target is an
 * offered text model with prices in lib/modelCatalog.json
 * (tests/unit/modelAliases.spec.ts).
 *
 * The dropped ids keep their lib/modelCatalog.json entries (catalogOffered
 * SNAPSHOT_CATALOG_IDS) so old ledger rows still have a price; they are on no
 * menu, no default and no Auto list.
 *
 * `node --env-file=<prod env> scripts/ops/model-references.mjs` counts the
 * saved values that still name one, without printing any of them.
 */
export const MODEL_ALIASES = {
  "anthropic/claude-opus-4.8-fast": "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-5-fast": "anthropic/claude-opus-5",
  "anthropic/claude-3-haiku": "anthropic/claude-haiku-4.5",
  "openai/gpt-5-pro": "openai/gpt-5",
  "openai/gpt-5.2-pro": "openai/gpt-5.2",
  "openai/gpt-5.4-pro": "openai/gpt-5.4",
  "openai/gpt-5.5-pro": "openai/gpt-5.5",
  /* The nearest small OpenAI model that is offered and quotes on a direct key. */
  "openai/gpt-oss-20b": "openai/gpt-5-nano",
  "openai/o3-pro": "openai/o3",
} as const satisfies Record<string, string>;

/**
 * Gemini models that left every menu when Gemini text went straight to Google (Vercel out; owner, 14 Oct 2026). Four have no direct model, so no route; the other three
 * (3.1 Flash-Lite, 3.5 Flash, 3.7 Flash) have one, but their price is not confirmed on Google's page, and a price that is not confirmed is never charged
 * (lib/textRoute.ts DIRECT_PRICE_TO_CONFIRM; owner, 14 Oct 23:35: "remove all SEVEN from the menus for now"). They return in a small PR when the price is confirmed.
 * A saved choice naming one (a chat, a board agent's run, the platform's routing, an env list) reads as Auto, with no error and nothing to say: Auto is the model
 * that is quoted, run and billed, so the price is Auto's own. Unlike the aliases above they have no nearest model: Auto is the default each place already has.
 * They keep their lib/modelCatalog.json entries so old ledger rows still have a price.
 */
export const AUTO_MODEL_IDS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-pro",
  "google/gemini-3.8-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.5-flash",
  "google/gemini-3.7-flash",
] as const;
export const readsAsAuto = (id: unknown): boolean => typeof id === "string" && (AUTO_MODEL_IDS as readonly string[]).includes(id);

export type DroppedModelId = keyof typeof MODEL_ALIASES;

export const DROPPED_MODEL_IDS = Object.keys(MODEL_ALIASES) as readonly DroppedModelId[];

export function isDroppedModel(id: unknown): id is DroppedModelId {
  return typeof id === "string" && Object.hasOwn(MODEL_ALIASES, id);
}

/** A dropped id as its alias (lib/modelAliases.ts, the table above), and nothing else: an id that reads as Auto stays as it is. */
export const aliasDropped = (id: string): string => (isDroppedModel(id) ? MODEL_ALIASES[id] : id);

/** The model a saved or requested id runs as: its alias when it was dropped, "auto" when it left with Gemini's gateway ids, else itself. */
export function aliasModel(id: string): string;
export function aliasModel(id: string | null | undefined): string | null | undefined;
export function aliasModel(id: string | null | undefined): string | null | undefined {
  if (readsAsAuto(id)) return "auto";
  return isDroppedModel(id) ? MODEL_ALIASES[id] : id;
}
