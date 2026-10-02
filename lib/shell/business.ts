/**
 * Business = Marketing Studio (FINAL_SPEC §2), after the Higgsfield sign-in
 * was retired (CLAUDE.md ground rule 10): Ads and Setup are the retired card
 * (components/graphite/OwnerRunCard.tsx), Image ads runs on Particl's API key
 * (lib/shell/image-ads.ts) and Business's own tools are Particl's
 * (lib/shell/business-own.ts). What is left here is shared: the setup item
 * types, a still from this project's Library, and the key Image ads keeps its
 * draft under.
 */

/** A still from this project's Library, by its Library id (`upload:<id>` or `generation:<id>`). */
export type AdStill = { id: string; name: string; sourceId: string; origin: "upload" | "generation"; url: string };

/* ── Setup ───────────────────────────────────────────────────────────── */
/** The setup item types Business names; Particl's own tools make products, brand kits and ad references (lib/shell/business-own.ts). */
export const SETUP_TYPES = [
  ["avatar", "Avatars"],
  ["product", "Products"],
  ["brand_kit", "Brand kits"],
  ["ad_reference", "Ad references"],
  ["hook", "Hooks"],
  ["setting", "Settings"],
  ["image_style", "Image styles"],
] as const;
export type SetupType = (typeof SETUP_TYPES)[number][0];
export type SetupItem = { id: string; type: SetupType; name: string; meta: string; previewUrl: string | null };

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
