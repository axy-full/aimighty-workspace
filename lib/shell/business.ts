/**
 * Business = Marketing Studio (FINAL_SPEC §2). Pure: the modes and their
 * labels, the two server rules (hooks and settings only for the UGC family,
 * never with an ad reference; products or web products, never both), the
 * composer's state → the exact parameters the connected account takes, and
 * what blocks Generate, in the prototype's words.
 *
 * Source of truth for the parameter names: the connected catalogue's own
 * entry for `marketing_studio_video` (tests/fixtures/connected-models.json,
 * read live at quote time), which is the CLI's `model get` shape.
 */
export const ADS_MODEL = "marketing_studio_video";
export const IMAGE_ADS_MODEL = "marketing_studio_image";

export const AD_MODES = [
  ["ugc", "UGC"], ["ugc_how_to", "Tutorial"], ["ugc_unboxing", "Unboxing"], ["product_showcase", "Product showcase"],
  ["product_review", "Product review"], ["tv_spot", "TV spot"], ["wild_card", "Wild card"], ["ugc_virtual_try_on", "UGC try-on"], ["virtual_try_on", "Pro try-on"],
] as const;
export type AdMode = (typeof AD_MODES)[number][0];
/** The modes that take a hook and a setting (references/marketing-modes.md). */
export const SETUP_MODES: readonly AdMode[] = ["ugc", "ugc_how_to", "ugc_unboxing", "product_review", "ugc_virtual_try_on"];
export const takesSetup = (mode: AdMode) => SETUP_MODES.includes(mode);

export const AD_ASPECTS = ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const AD_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
/** The two presets; the schema's range decides the cap. */
export const AD_DURATIONS = [15, 30] as const;
export const AD_MEDIA_ROLES = ["image", "start_image", "end_image"] as const;
export type AdMediaRole = (typeof AD_MEDIA_ROLES)[number];
export const AD_MEDIA_MAX = 14;

/**
 * Not on this path: Click-to-Ad (`product: { url }`), `web_product_ids`,
 * `specific_mode` / `storyboard_id` and `enhance_prompt` are the CLI's REST
 * gateway parameters (FINAL_SPEC §2.1); the account's `generate` tool
 * declares none of them for `marketing_studio_video`, and the server refuses
 * a parameter the schema does not name. They return with the developer-API
 * grant (`lib/higgsfield-consumer/developer-api.ts`), where products are
 * fetched by URL as setup items first. `avatar_ids` (a plain UUID array) is
 * this path's shape; `avatars: [{ id, type }]` is the gateway's.
 */
export const NOT_ON_THIS_PATH = ["product.url", "web_product_ids", "specific_mode", "storyboard_id", "enhance_prompt"] as const;

export const WHY = {
  hookMode: "Hooks are valid only for UGC-family modes and never with an ad reference.",
  settingMode: "Settings are valid only for UGC-family modes and never with an ad reference.",
  adReference: "Clear the hook and setting first.",
  webProduct: "Choose a saved product or a web product, not both.",
};

export type AdsState = {
  prompt: string;
  mode: AdMode;
  productId: string | null;
  avatarId: string | null;
  hookId: string | null;
  settingId: string | null;
  adReferenceId: string | null;
  aspect: (typeof AD_ASPECTS)[number];
  duration: number;
  resolution: (typeof AD_RESOLUTIONS)[number];
  audio: boolean;
  medias: { id: string; role: AdMediaRole; name: string; sourceId: string; origin: "upload" | "generation"; url: string }[];
};
export const INITIAL_ADS: AdsState = {
  prompt: "", mode: "ugc", productId: null, avatarId: null, hookId: null, settingId: null, adReferenceId: null,
  aspect: "9:16", duration: 15, resolution: "720p", audio: true, medias: [],
};

/** Choosing a mode outside the family, or an ad reference, clears what cannot ride with it (never silently later). */
export function withMode(state: AdsState, mode: AdMode): AdsState {
  return takesSetup(mode) ? { ...state, mode } : { ...state, mode, hookId: null, settingId: null };
}
export function withAdReference(state: AdsState, adReferenceId: string | null): AdsState {
  return adReferenceId ? { ...state, adReferenceId, hookId: null, settingId: null } : { ...state, adReferenceId: null };
}
export function withSetup(state: AdsState, patch: { hookId?: string | null; settingId?: string | null }): AdsState {
  return { ...state, ...patch, adReferenceId: patch.hookId || patch.settingId ? null : state.adReferenceId };
}

/** Which chips are off, and why — shown at 40 % with the reason, never hidden. */
export function adsChipState(state: AdsState) {
  const family = takesSetup(state.mode);
  const refUsed = Boolean(state.adReferenceId);
  const blocks = Boolean(state.hookId || state.settingId);
  return {
    hook: { disabled: !family || refUsed, why: !family ? `Hooks are not for ${state.mode}.` : refUsed ? WHY.hookMode : null },
    setting: { disabled: !family || refUsed, why: !family ? `Settings are not for ${state.mode}.` : refUsed ? WHY.settingMode : null },
    adReference: { disabled: blocks, why: blocks ? WHY.adReference : null },
  };
}

/** Why Generate ad is off; null when it can run. Prototype copy. */
export function adsBlock(state: AdsState, extra: { connected: boolean; hasProject: boolean }): string | null {
  if (!extra.hasProject) return "Open a project first.";
  if (!extra.connected) return "Connect the account in Workspace › Engines.";
  if (!state.prompt.trim()) return "Write the prompt.";
  if ((state.hookId || state.settingId) && !takesSetup(state.mode)) return WHY.hookMode;
  if ((state.hookId || state.settingId) && state.adReferenceId) return WHY.adReference;
  if (state.medias.length > AD_MEDIA_MAX) return `Up to ${AD_MEDIA_MAX} reference stills.`;
  return null;
}

/**
 * The connected account's parameters for this state — only what is set, in
 * the catalogue's names. The server validates every one against the live
 * schema and refuses unknown or out-of-range values before anything is quoted.
 */
export function adsParameters(state: AdsState, durationRange?: { min: number; max: number } | null): Record<string, string | number | boolean | string[]> {
  const duration = durationRange ? Math.min(Math.max(state.duration, durationRange.min), durationRange.max) : state.duration;
  return {
    mode: state.mode,
    aspect_ratio: state.aspect,
    duration,
    resolution: state.resolution,
    generate_audio: state.audio,
    ...(state.productId ? { product_ids: [state.productId] } : {}),
    ...(state.avatarId ? { avatar_ids: [state.avatarId] } : {}),
    ...(state.hookId && takesSetup(state.mode) && !state.adReferenceId ? { hook_id: state.hookId } : {}),
    ...(state.settingId && takesSetup(state.mode) && !state.adReferenceId ? { setting_id: state.settingId } : {}),
    ...(state.adReferenceId ? { ad_reference_id: state.adReferenceId } : {}),
  };
}
/** The clamped value the person sees when the schema moved their pick. */
export function clampedDuration(state: AdsState, durationRange?: { min: number; max: number } | null): number | null {
  const sent = adsParameters(state, durationRange).duration as number;
  return sent === state.duration ? null : sent;
}

/* ── Image ads ───────────────────────────────────────────────────────── */
export const IMAGE_AD_RESOLUTIONS = ["1k", "2k", "4k"] as const;
/**
 * The two image engines the account offers for ads (FINAL_SPEC §2.2): Marketing
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
  /** DTC only. */
  styleId: string | null; brandKitId: string | null; quality: (typeof DTC_QUALITIES)[number]; batch: number; productIds: string[];
};
export const INITIAL_IMAGE_ADS: ImageAdsState = { engine: IMAGE_ADS_MODEL, prompt: "", aspect: "1:1", resolution: "1k", medias: [], styleId: null, brandKitId: null, quality: "low", batch: 1, productIds: [] };
export const isDtc = (state: Pick<ImageAdsState, "engine">) => state.engine === DTC_ADS_MODEL;
export function imageAdsBlock(state: ImageAdsState, extra: { connected: boolean; hasProject: boolean }): string | null {
  if (!extra.hasProject) return "Open a project first.";
  if (!extra.connected) return "Connect the account in Workspace › Engines.";
  if (!state.prompt.trim() && !state.medias.length) return "Write the prompt or add a reference.";
  if (state.aspect === "auto" && !state.medias.length) return "Aspect auto needs a reference still.";
  if (state.medias.length > AD_MEDIA_MAX) return `Up to ${AD_MEDIA_MAX} reference stills.`;
  if (isDtc(state)) {
    if (!state.styleId) return "Pick a style — the ad format. DTC Ads has no default.";
    if (!Number.isInteger(state.batch) || state.batch < DTC_BATCH.min || state.batch > DTC_BATCH.max) return `Batch is ${DTC_BATCH.min}–${DTC_BATCH.max} images per job.`;
    if (state.productIds.length > DTC_PRODUCTS_MAX) return `Up to ${DTC_PRODUCTS_MAX} products.`;
  }
  return null;
}
/** The DTC Ads Engine (`dtc-ads generate`) is a CLI flow the connected account's tools do not carry (checked against its advertised toolset). */
export const DTC_COPY = "DTC Ads runs on the account’s ms_image engine: a style (the ad format) is required and has no default; a completed brand kit folds its logo, colours, fonts and tone into the prompt; up to four products; 1–20 images per job, cost scaling with the batch and the quality tier.";
/** The ad-formats section (FINAL_SPEC §2.2 › ad formats), on the account's template catalogue. */
export const AD_FORMATS_COPY = { title: "Ad formats", line: "The account’s Marketing Studio templates — UGC, product shots, motion, ads, posters, marketplace. Pick one, then create with it at the price the account quotes." } as const;

/* ── Setup ───────────────────────────────────────────────────────────── */
export const SETUP_TYPES = [
  ["product", "Products", "products fetch --url · products create"],
  ["avatar", "Avatars", "avatars list · avatars create"],
  ["hook", "Hooks", "hooks list"],
  ["setting", "Settings", "settings list"],
  ["ad_reference", "Ad references", "ad-references create --video-input"],
  ["brand_kit", "Brand kits", "brand-kits fetch --url"],
  ["image_style", "Image styles", "ad-formats list"],
] as const;
export type SetupType = (typeof SETUP_TYPES)[number][0];
export type SetupItem = { id: string; type: SetupType; name: string; meta: string; previewUrl: string | null };

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
