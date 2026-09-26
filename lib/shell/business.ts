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

/** A still from this project's Library, by its Library id (`upload:<id>` or `generation:<id>`). */
export type AdStill = { id: string; name: string; sourceId: string; origin: "upload" | "generation"; url: string };

export type AdsState = {
  prompt: string;
  mode: AdMode;
  productId: string | null;
  /** The product as a still from this project's Library: rides first among the reference stills. */
  productStill: AdStill | null;
  avatarId: string | null;
  hookId: string | null;
  settingId: string | null;
  /** The setting as a still from this project's Library, instead of a preset setting. */
  settingStill: AdStill | null;
  adReferenceId: string | null;
  aspect: (typeof AD_ASPECTS)[number];
  duration: number;
  resolution: (typeof AD_RESOLUTIONS)[number];
  audio: boolean;
  medias: { id: string; role: AdMediaRole; name: string; sourceId: string; origin: "upload" | "generation"; url: string }[];
};
export const INITIAL_ADS: AdsState = {
  prompt: "", mode: "ugc", productId: null, productStill: null, avatarId: null, hookId: null, settingId: null, settingStill: null, adReferenceId: null,
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
  return { ...state, ...patch, adReferenceId: patch.hookId || patch.settingId ? null : state.adReferenceId, settingStill: patch.settingId ? null : state.settingStill };
}
/** A named still (product or setting) from the Library: one of each, never the same still twice across the slots and the reference well. */
export function withStill(state: AdsState, slot: "product" | "setting", still: AdStill | null): AdsState {
  const other = slot === "product" ? state.settingStill : state.productStill;
  const next = { ...state, medias: still ? state.medias.filter((m) => m.id !== still.id) : state.medias };
  if (slot === "product") return { ...next, productStill: still, productId: still ? null : state.productId, settingStill: still && other?.id === still.id ? null : state.settingStill };
  return { ...next, settingStill: still, settingId: still ? null : state.settingId, productStill: still && other?.id === still.id ? null : state.productStill };
}
/** A product Particl made on the account, instead of a product still. */
export function withProductId(state: AdsState, productId: string | null): AdsState {
  return { ...state, productId, productStill: productId ? null : state.productStill };
}
/** Every still the ad sends, in order: the product, the setting, then the reference well — each once. */
export function adsMedias(state: AdsState): AdsState["medias"] {
  const named = [state.productStill, state.settingStill].filter((m): m is AdStill => Boolean(m)).map((m) => ({ ...m, role: "image" as AdMediaRole }));
  const seen = new Set<string>();
  return [...named, ...state.medias].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
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
  if (adsMedias(state).length > AD_MEDIA_MAX) return `Up to ${AD_MEDIA_MAX} reference stills.`;
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
/** The ad-formats section (FINAL_SPEC §2.2 › ad formats), on the account's template catalogue. */
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

/* ── Setup → Ads / Image ads ─────────────────────────────────────────── */
/**
 * Use in Ads / Use in Image ads: Setup leaves the pick in sessionStorage for
 * the page it names, which reads it once and clears it. A pick for the other
 * page is left for that page (a pick for one composer never lands in the
 * other), and any pick older than two minutes is spent, so a stale one never
 * pre-selects anything later. Image ads takes products, brand kits and
 * styles only on the DTC engine, so a pick of one switches to it; avatars
 * ride with Ads only.
 */
export const PRESET_KEY = "particl-business-preset";
export const PRESET_TTL_MS = 120_000;
export type BusinessPage = "ads" | "dtc";
export type SetupPreset = { page: BusinessPage; type: SetupType; id: string; name: string; at: number };
/** What each page can take from Setup. */
export const PRESET_TYPES: Record<BusinessPage, readonly SetupType[]> = {
  ads: ["avatar", "product", "hook", "setting", "ad_reference"],
  dtc: ["product", "brand_kit", "image_style"],
};
const PRESET_ID = /^[A-Za-z0-9_-]{1,200}$/;
export function presetFor(item: SetupItem, page: BusinessPage, now: number): SetupPreset {
  return { page, type: item.type, id: item.id, name: item.name, at: now };
}
/** The pick waiting for this page, or null (wrong page, stale, malformed or a type the page cannot take). */
export function parsePreset(raw: string | null, page: BusinessPage, now: number): SetupPreset | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<SetupPreset>;
  if (p.page !== page || typeof p.at !== "number" || !Number.isFinite(p.at) || now - p.at > PRESET_TTL_MS || p.at - now > 5_000) return null;
  if (typeof p.type !== "string" || !PRESET_TYPES[page].includes(p.type as SetupType)) return null;
  if (typeof p.id !== "string" || !PRESET_ID.test(p.id)) return null;
  return { page, type: p.type as SetupType, id: p.id, name: typeof p.name === "string" ? p.name.slice(0, 160) : p.id, at: p.at };
}
/** Whether this page should clear what is stored: its own pick (read now), a stale pick, or junk. Another page's fresh pick stays. */
export function presetSpent(raw: string | null, page: BusinessPage, now: number): boolean {
  if (!raw) return false;
  if (parsePreset(raw, page, now)) return true;
  const other: BusinessPage = page === "ads" ? "dtc" : "ads";
  return !parsePreset(raw, other, now);
}
/**
 * Setup's pick, added to the ad being built — never a fresh composer. A hook
 * or a setting moves a mode that cannot take one to UGC, the default.
 */
export function adsFromPreset(preset: SetupPreset | null, current: AdsState = INITIAL_ADS): AdsState {
  if (!preset || preset.page !== "ads") return current;
  const family = takesSetup(current.mode) ? current : withMode(current, "ugc");
  if (preset.type === "product") return withProductId(current, preset.id);
  if (preset.type === "avatar") return { ...current, avatarId: preset.id };
  if (preset.type === "hook") return withSetup(family, { hookId: preset.id });
  if (preset.type === "setting") return withSetup(family, { settingId: preset.id });
  if (preset.type === "ad_reference") return withAdReference(current, preset.id);
  return current;
}
/** Products, brand kits and ad styles ride on the DTC Ads engine, so a pick from Setup switches to it and keeps the rest. */
export function imageAdsFromPreset(preset: SetupPreset | null, current: ImageAdsState = INITIAL_IMAGE_ADS): ImageAdsState {
  if (!preset || preset.page !== "dtc") return current;
  const dtc = { ...current, engine: DTC_ADS_MODEL } as ImageAdsState;
  if (preset.type === "product") return { ...dtc, productIds: [preset.id, ...current.productIds.filter((id) => id !== preset.id)].slice(0, DTC_PRODUCTS_MAX) };
  if (preset.type === "brand_kit") return { ...dtc, brandKitId: preset.id };
  if (preset.type === "image_style") return { ...dtc, styleId: preset.id };
  return current;
}

/* ── Drafts ──────────────────────────────────────────────────────────── */
/**
 * The Ads and Image ads composers keep their draft per project in this tab,
 * so a trip to Setup, Cast or the Library and back finds the ad as it was.
 * What comes back from storage is checked field by field; anything that does
 * not read cleanly falls back to the default.
 */
export const DRAFT_KEY = "particl-business-draft";
export const draftKey = (scope: string, projectId: string, page: BusinessPage) => `${DRAFT_KEY}:${page}:${scope}:${projectId}`;
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
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
export function restoreAds(value: unknown): AdsState | null {
  const v = obj(value);
  if (!v) return null;
  const medias = (Array.isArray(v.medias) ? v.medias : []).flatMap((m) => {
    const still = stillOf(m), role = obj(m)?.role;
    return still && (AD_MEDIA_ROLES as readonly unknown[]).includes(role) ? [{ ...still, role: role as AdMediaRole }] : [];
  }).slice(0, AD_MEDIA_MAX);
  const state: AdsState = {
    prompt: typeof v.prompt === "string" ? v.prompt.slice(0, 5000) : "",
    mode: AD_MODES.some(([m]) => m === v.mode) ? (v.mode as AdMode) : INITIAL_ADS.mode,
    productId: setupIdOr(v.productId), productStill: stillOf(v.productStill), avatarId: setupIdOr(v.avatarId), hookId: setupIdOr(v.hookId),
    settingId: setupIdOr(v.settingId), settingStill: stillOf(v.settingStill), adReferenceId: setupIdOr(v.adReferenceId),
    aspect: typeof v.aspect === "string" && ASPECT.test(v.aspect) ? (v.aspect as AdsState["aspect"]) : INITIAL_ADS.aspect,
    duration: typeof v.duration === "number" && Number.isInteger(v.duration) && v.duration >= 4 && v.duration <= 120 ? v.duration : INITIAL_ADS.duration,
    resolution: typeof v.resolution === "string" && /^\d{3,4}p$/.test(v.resolution) ? (v.resolution as AdsState["resolution"]) : INITIAL_ADS.resolution,
    audio: typeof v.audio === "boolean" ? v.audio : INITIAL_ADS.audio,
    medias,
  };
  /* The server rules hold on the way back in too. */
  const ruled = state.adReferenceId ? withAdReference(withMode(state, state.mode), state.adReferenceId) : withMode(state, state.mode);
  return ruled.productStill && ruled.productStill.id === ruled.settingStill?.id ? { ...ruled, settingStill: null } : ruled;
}
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
export function pruneAds(state: AdsState, reads: SetupReads): AdsState {
  const next = {
    productId: listed(reads, "product", state.productId) ? state.productId : null,
    avatarId: listed(reads, "avatar", state.avatarId) ? state.avatarId : null,
    hookId: listed(reads, "hook", state.hookId) ? state.hookId : null,
    settingId: listed(reads, "setting", state.settingId) ? state.settingId : null,
    adReferenceId: listed(reads, "ad_reference", state.adReferenceId) ? state.adReferenceId : null,
  };
  return (Object.keys(next) as (keyof typeof next)[]).every((key) => next[key] === state[key]) ? state : { ...state, ...next };
}
export function pruneImageAds(state: ImageAdsState, reads: SetupReads): ImageAdsState {
  const styleId = listed(reads, "image_style", state.styleId) ? state.styleId : null;
  const brandKitId = listed(reads, "brand_kit", state.brandKitId) ? state.brandKitId : null;
  const productIds = state.productIds.filter((id) => listed(reads, "product", id));
  return styleId === state.styleId && brandKitId === state.brandKitId && productIds.length === state.productIds.length ? state : { ...state, styleId, brandKitId, productIds };
}
