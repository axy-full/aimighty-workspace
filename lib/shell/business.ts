/**
 * Business, pure: the catalogue ids of the Marketing Studio engines, the
 * setup item types, the composer drafts and the connected catalogue's read
 * rules. Business › Ads (the `marketing_studio_video` composer) was removed
 * (design/particl-graphite/README.md › What this design removes); its model
 * id stays, because past jobs and the account's records still name it.
 */
export const ADS_MODEL = "marketing_studio_video";
export const IMAGE_ADS_MODEL = "marketing_studio_image";

export const AD_MEDIA_MAX = 14;

/** A still from this project's Library, by its Library id (`upload:<id>` or `generation:<id>`). */
export type AdStill = { id: string; name: string; sourceId: string; origin: "upload" | "generation"; url: string };

/* ── Image ads ───────────────────────────────────────────────────────── */
export const IMAGE_AD_RESOLUTIONS = ["1k", "2k", "4k"] as const;
/**
 * The two image engines the account offers for ads: Marketing
 * Studio Image, and the DTC Ads Engine (`ms_image`), whose entry requires a
 * style — the ad format, picked from `show_marketing_studio type=image_style`
 * — and takes a brand kit (must be completed), a quality tier, up to four
 * products and a batch of 1–20 images per job.
 */
export const DTC_ADS_MODEL = "ms_image";
export const IMAGE_AD_ENGINES = [[IMAGE_ADS_MODEL, "Marketing Studio Image"], [DTC_ADS_MODEL, "DTC Ads"]] as const;
export const DTC_QUALITIES = ["low", "medium", "high"] as const;
export const DTC_BATCH = { min: 1, max: 20 } as const;
export const DTC_PRODUCTS_MAX = 4;
export type ImageAdsState = {
  engine: (typeof IMAGE_AD_ENGINES)[number][0];
  prompt: string; aspect: string; resolution: (typeof IMAGE_AD_RESOLUTIONS)[number]; medias: { id: string; name: string }[];
  /** The product as a still from this project's Library: rides first among the references. */
  productStill: AdStill | null;
  /** DTC only. */
  styleId: string | null; brandKitId: string | null; quality: (typeof DTC_QUALITIES)[number]; batch: number; productIds: string[];
};
export const INITIAL_IMAGE_ADS: ImageAdsState = { engine: IMAGE_ADS_MODEL, prompt: "", aspect: "1:1", resolution: "1k", medias: [], productStill: null, styleId: null, brandKitId: null, quality: "low", batch: 1, productIds: [] };
export const isDtc = (state: Pick<ImageAdsState, "engine">) => state.engine === DTC_ADS_MODEL;
/** Every reference the image ad sends: the product still first, then the well — each once. */
export function imageAdsMedias(state: Pick<ImageAdsState, "medias" | "productStill">): { id: string; name: string }[] {
  const seen = new Set<string>();
  return [...(state.productStill ? [{ id: state.productStill.id, name: state.productStill.name }] : []), ...state.medias].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}
/** The product still for an image ad: never also in the reference well. */
export function withImageStill(state: ImageAdsState, still: AdStill | null): ImageAdsState {
  return { ...state, productStill: still, medias: still ? state.medias.filter((m) => m.id !== still.id) : state.medias };
}
/** `styles`: how many ad styles the account lists, once read (DTC cannot run without one). */
export function imageAdsBlock(state: ImageAdsState, extra: { connected: boolean; hasProject: boolean; styles?: number | null }): string | null {
  if (!extra.hasProject) return "Open a project first.";
  if (!extra.connected) return "Connect the account in Workspace › Engines.";
  const medias = imageAdsMedias(state);
  if (!state.prompt.trim() && !medias.length) return "Write the prompt or add a reference.";
  if (state.aspect === "auto" && !medias.length) return "Aspect auto needs a reference still.";
  if (medias.length > AD_MEDIA_MAX) return `Up to ${AD_MEDIA_MAX} reference stills.`;
  if (isDtc(state)) {
    if (!state.styleId && extra.styles === 0) return "The connected account lists no ad styles, so DTC Ads cannot run.";
    if (!state.styleId) return "Pick a style — the ad format. DTC Ads has no default.";
    if (!Number.isInteger(state.batch) || state.batch < DTC_BATCH.min || state.batch > DTC_BATCH.max) return `Batch is ${DTC_BATCH.min}–${DTC_BATCH.max} images per job.`;
    if (state.productIds.length > DTC_PRODUCTS_MAX) return `Up to ${DTC_PRODUCTS_MAX} products.`;
  }
  return null;
}
/** The DTC Ads Engine (`dtc-ads generate`) is a CLI flow the connected account's tools do not carry (checked against its advertised toolset). */
export const DTC_COPY = "DTC Ads runs on the account’s ms_image engine: a style (the ad format) is required and has no default; a completed brand kit folds its logo, colours, fonts and tone into the prompt; up to four products; 1–20 images per job, cost scaling with the batch and the quality tier.";
/** The ad-formats section, on the account's template catalogue. */
export const AD_FORMATS_COPY = { title: "Ad formats", line: "The account’s Marketing Studio templates — UGC, product shots, motion, ads, posters, marketplace. Pick one, then create with it at the price the account quotes." } as const;

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
 * The Image ads composer keeps its draft per project in this tab, so a trip
 * to Setup, Cast or the Library and back finds the ad as it was.
 * What comes back from storage is checked field by field; anything that does
 * not read cleanly falls back to the default.
 */
export const DRAFT_KEY = "particl-business-draft";
/** The Business pages that hold a composer draft. */
export type BusinessPage = "dtc";
export const draftKey = (scope: string, projectId: string, page: BusinessPage) => `${DRAFT_KEY}:${page}:${scope}:${projectId}`;
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const PRESET_ID = /^[A-Za-z0-9_-]{1,200}$/;
const setupIdOr = (value: unknown): string | null => (typeof value === "string" && PRESET_ID.test(value) ? value : null);
const LIBRARY_ID = /^(upload|generation):[^\s]{1,200}$/;
const SAFE_URL = /^(\/(?!\/)|https:\/\/)\S{1,2048}$/;
function stillOf(value: unknown): AdStill | null {
  const v = obj(value);
  if (!v || typeof v.id !== "string" || !LIBRARY_ID.test(v.id) || typeof v.name !== "string" || typeof v.sourceId !== "string" || !v.sourceId || v.sourceId.length > 200 ||
      (v.origin !== "upload" && v.origin !== "generation") || typeof v.url !== "string" || !SAFE_URL.test(v.url)) return null;
  return { id: v.id, name: v.name.slice(0, 300), sourceId: v.sourceId, origin: v.origin, url: v.url };
}
const ASPECT = /^(auto|\d{1,2}:\d{1,2})$/;
export function restoreImageAds(value: unknown): ImageAdsState | null {
  const v = obj(value);
  if (!v) return null;
  const medias = (Array.isArray(v.medias) ? v.medias : []).flatMap((m) => {
    const o = obj(m);
    return o && typeof o.id === "string" && LIBRARY_ID.test(o.id) && typeof o.name === "string" ? [{ id: o.id, name: o.name.slice(0, 300) }] : [];
  }).slice(0, AD_MEDIA_MAX);
  return {
    engine: IMAGE_AD_ENGINES.some(([e]) => e === v.engine) ? (v.engine as ImageAdsState["engine"]) : INITIAL_IMAGE_ADS.engine,
    prompt: typeof v.prompt === "string" ? v.prompt.slice(0, 5000) : "",
    aspect: typeof v.aspect === "string" && ASPECT.test(v.aspect) ? v.aspect : INITIAL_IMAGE_ADS.aspect,
    resolution: (IMAGE_AD_RESOLUTIONS as readonly unknown[]).includes(v.resolution) ? (v.resolution as ImageAdsState["resolution"]) : INITIAL_IMAGE_ADS.resolution,
    medias, productStill: stillOf(v.productStill),
    styleId: setupIdOr(v.styleId), brandKitId: setupIdOr(v.brandKitId),
    quality: (DTC_QUALITIES as readonly unknown[]).includes(v.quality) ? (v.quality as ImageAdsState["quality"]) : INITIAL_IMAGE_ADS.quality,
    batch: typeof v.batch === "number" && Number.isInteger(v.batch) && v.batch >= DTC_BATCH.min && v.batch <= DTC_BATCH.max ? v.batch : INITIAL_IMAGE_ADS.batch,
    productIds: (Array.isArray(v.productIds) ? v.productIds : []).flatMap((id) => (setupIdOr(id) ? [id as string] : [])).slice(0, DTC_PRODUCTS_MAX),
  };
}

/** The setup reads a page holds, by type (lib/shell/use-business.ts). */
export type SetupReads = Partial<Record<SetupType, { items: readonly SetupItem[] }>>;
const listed = (reads: SetupReads, type: SetupType, id: string | null) => !id || !reads[type] || reads[type]!.items.some((item) => item.id === id);
/**
 * Once a type has been read, a pick Setup no longer lists — the account
 * dropped it, or it is not Particl's — is cleared rather than sent. Answers
 * the same object when nothing changed.
 */
export function pruneImageAds(state: ImageAdsState, reads: SetupReads): ImageAdsState {
  const styleId = listed(reads, "image_style", state.styleId) ? state.styleId : null;
  const brandKitId = listed(reads, "brand_kit", state.brandKitId) ? state.brandKitId : null;
  const productIds = state.productIds.filter((id) => listed(reads, "product", id));
  return styleId === state.styleId && brandKitId === state.brandKitId && productIds.length === state.productIds.length ? state : { ...state, styleId, brandKitId, productIds };
}

/* ── The connected catalogue ─────────────────────────────────────────── */

export type CatalogueStatus = "idle" | "loading" | "ready" | "error";
/** What each composer calls its catalogue model when the account does not offer it. */
export const CATALOGUE_LABEL: Record<string, string> = {
  [ADS_MODEL]: "Marketing Studio video",
  [IMAGE_ADS_MODEL]: "Marketing Studio Image",
  [DTC_ADS_MODEL]: "DTC Ads",
};
/**
 * Why a composer cannot use its catalogue model yet, or null when it can (or
 * when the account is not connected — that has its own line). A read that
 * failed says so, and one that succeeded without the model says the account
 * does not offer it: never "Reading…" for ever.
 */
export function catalogueBlock(input: { connected: boolean; status: CatalogueStatus; error: string | null; offered: boolean; model: string }): string | null {
  if (input.offered || !input.connected) return null;
  if (input.status === "error") return input.error ?? "The connected catalogue could not be read.";
  if (input.status === "ready") return `The connected account does not offer ${CATALOGUE_LABEL[input.model] ?? input.model}.`;
  return "Reading the connected catalogue…";
}
/** Waits before asking the account again after a failed read or quote: 5 s, 15 s, 45 s, then every minute. */
export const retryAfterMs = (failures: number) => Math.min(60_000, 5000 * 3 ** Math.max(0, failures - 1));
/** How many failed reads or quotes in a row are asked again on their own; after that the page waits for Try again. */
export const AUTO_RETRIES = 3;
/** Refusals that pass on their own (the account busy, its preflight down); every other code refuses the input itself. */
const TRANSIENT_CODES = new Set(["connection_busy", "preflight_unavailable"]);
/**
 * When to quote again on its own after the `failures`-th failure in a row, or
 * null when only the user should: a network failure (status null), a rate
 * limit or an unavailable account is asked again a few times; an input the
 * account refuses (parameter_invalid, model_unknown, reconnect_required…)
 * would be refused again, and every quote imports the references again.
 */
export function autoRetryMs(failure: { status: number | null; code?: string }, failures: number): number | null {
  const transient = failure.status === null || failure.status === 429 || (failure.status >= 502 && failure.status <= 504)
    || (failure.code !== undefined && TRANSIENT_CODES.has(failure.code));
  return transient && failures <= AUTO_RETRIES ? retryAfterMs(failures) : null;
}

/** A quote is taken again this long before the account says it expires. */
export const QUOTE_MARGIN_MS = 20_000;
/**
 * The moment, on this device's clock, after which a quote received at
 * `receivedAt` is too close to expiry to submit. It uses the account's
 * lifetime for the quote (its expiry less its creation, both on the server's
 * clock), never the server's timestamp read against this clock, which may run
 * fast or slow.
 */
export function quoteUsableUntil(job: { quoteExpiresAt: number; createdAt: number }, receivedAt: number): number {
  return receivedAt + Math.max(0, job.quoteExpiresAt - job.createdAt) - QUOTE_MARGIN_MS;
}
