/**
 * Business = Marketing Studio (FINAL_SPEC §2), after the Higgsfield sign-in
 * was retired (lib/higgsfield-consumer/retired.ts): Ads and Setup are the
 * retired card (components/graphite/OwnerRunCard.tsx), Image ads runs on
 * Particl's API key (lib/shell/image-ads.ts) and Business's own tools are
 * Particl's (lib/shell/business-own.ts). What is left here is shared: the
 * account's Marketing Studio model ids and setup item types, which its history
 * still names (lib/higgsfield-consumer/marketing-records.ts,
 * marketing-setup.ts), a still from this project's Library, and the key Image
 * ads keeps its draft under.
 */

/** The account's Marketing Studio engines, as its history names them. */
export const ADS_MODEL = "marketing_studio_video";
export const IMAGE_ADS_MODEL = "marketing_studio_image";
export const DTC_ADS_MODEL = "ms_image";

/** A still from this project's Library, by its Library id (`upload:<id>` or `generation:<id>`). */
export type AdStill = { id: string; name: string; sourceId: string; origin: "upload" | "generation"; url: string };

/* ── Setup ───────────────────────────────────────────────────────────── */
/**
 * The setup item types, and whose they are. `owned` items are the connected
 * account's own library (its products, brand kits, ad references): Particl is
 * a standalone platform, so only what Particl made there is ever listed or
 * sent (lib/higgsfield-consumer/marketing-records.ts). `catalogue` items are
 * the engine's shared presets (preset avatars, hooks, settings, ad styles),
 * listed unless the account marks one as its user's own — plus any Particl
 * made.
 */
export const SETUP_TYPES = [
  ["avatar", "Avatars", "catalogue"],
  ["product", "Products", "owned"],
  ["brand_kit", "Brand kits", "owned"],
  ["ad_reference", "Ad references", "owned"],
  ["hook", "Hooks", "catalogue"],
  ["setting", "Settings", "catalogue"],
  ["image_style", "Image styles", "catalogue"],
] as const;
export type SetupType = (typeof SETUP_TYPES)[number][0];
export type SetupItem = { id: string; type: SetupType; name: string; meta: string; previewUrl: string | null };
export const OWNED_SETUP_TYPES: readonly SetupType[] = SETUP_TYPES.filter((t) => t[2] === "owned").map((t) => t[0]);
export const isOwnedSetup = (type: SetupType) => OWNED_SETUP_TYPES.includes(type);

/* ── Drafts ──────────────────────────────────────────────────────────── */
/**
 * Image ads keeps its draft per project in this tab, so a trip to Cast or the
 * Library and back finds the ad as it was (lib/shell/image-ads.ts reads it
 * back field by field). Its page keeps the name `dtc`, so a draft made before
 * still loads.
 */
export type BusinessPage = "ads" | "dtc";
export const DRAFT_KEY = "particl-business-draft";
export const draftKey = (scope: string, projectId: string, page: BusinessPage) => `${DRAFT_KEY}:${page}:${scope}:${projectId}`;
