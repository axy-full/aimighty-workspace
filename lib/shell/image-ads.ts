import { MARKETING_IMAGE_MODEL_ID, getModel } from "@/lib/models";
import type { DispatchRequest } from "@/lib/workspace/generate-submit";
import type { AdStill } from "./business";

/**
 * Business › Image ads, on Particl's API key for every workspace and every
 * member (FINAL_SPEC §2.2): Marketing Studio Image through the one
 * workspace-credit path (lib/workspace/generate-submit.ts → POST
 * /api/generate/quote, then POST /api/generate with the approved ceiling).
 * The price on the button is that quote — the provider's live estimate
 * through Particl's credit terms — said as an estimate.
 *
 * Pure: the builds the page offers, the composer's state, the provider's
 * rules in words, the request, and the preset catalogue grouped for the
 * picker. Every still is an original from this project's Library, sent by
 * its identity (never a URL); the server signs a short-lived link for the
 * provider, so client media stays in Particl's storage.
 */

/**
 * The builds of Marketing Studio Image, extensible by data: the 2.5 builds
 * join this list as entries carrying their `variant` and their own qualities
 * (the request carries `variant` only for a build that names one).
 */
export type ImageAdBuild = {
  id: string;
  label: string;
  model: string;
  qualities: readonly string[];
  /** The quality a preset (enhanced) take must run at on this build, when the build fixes one. */
  presetQuality: string | null;
  variant?: string;
};
export const IMAGE_AD_BUILDS: readonly ImageAdBuild[] = [
  { id: "alpha", label: "Image 2.0", model: MARKETING_IMAGE_MODEL_ID, qualities: ["low", "medium", "high"], presetQuality: "high" },
];
export const imageAdBuild = (id: string): ImageAdBuild => IMAGE_AD_BUILDS.find((b) => b.id === id) ?? IMAGE_AD_BUILDS[0];

const MODEL = getModel(MARKETING_IMAGE_MODEL_ID);
/** The aspects and sizes the model takes (lib/models.ts), in the order a person reads them. */
export const IMAGE_AD_ASPECTS: readonly string[] = MODEL.ratios;
export const IMAGE_AD_RESOLUTIONS: readonly string[] = ["1k", "2k", "4k"].filter((r) => MODEL.resolutions.includes(r));
/** Up to 16 stills; with a preset, the product still and one more at most (the provider's rule). */
export const IMAGE_AD_MAX = MODEL.maxReferenceImages;
export const PRESET_STILLS_MAX = 2;
export const IMAGE_AD_PROMPT_MAX = 5000;

export type ImageAdPreset = { id: string; name: string };
export type ImageAdState = {
  build: string;
  prompt: string;
  aspect: string;
  resolution: string;
  quality: string;
  /** A preset from the catalogue: the provider writes the ad around it (enhancement), starting from the product still. */
  preset: ImageAdPreset | null;
  /** The product, a still from this project's Library: always the first image sent. */
  productStill: AdStill | null;
  /** More stills, in the order sent. */
  medias: AdStill[];
};
export const INITIAL_IMAGE_AD: ImageAdState = { build: "alpha", prompt: "", aspect: "1:1", resolution: "2k", quality: "high", preset: null, productStill: null, medias: [] };

/** Every still the ad sends, in order: the product first, then the rest — each once. */
export function imageAdMedias(state: Pick<ImageAdState, "productStill" | "medias">): AdStill[] {
  const seen = new Set<string>();
  return [...(state.productStill ? [state.productStill] : []), ...state.medias].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}
/** How many more stills the well takes now. */
export function imageAdRoom(state: Pick<ImageAdState, "productStill" | "medias" | "preset">): number {
  const cap = state.preset ? PRESET_STILLS_MAX : IMAGE_AD_MAX;
  return Math.max(0, cap - (state.productStill ? 1 : 0) - state.medias.length);
}
/** The product still: never also in the well. */
export function withProductStill(state: ImageAdState, still: AdStill | null): ImageAdState {
  return { ...state, productStill: still, medias: still ? state.medias.filter((m) => m.id !== still.id) : state.medias };
}
/** A preset picked (or cleared): on a build that fixes the quality for presets, the quality moves to it. */
export function withPreset(state: ImageAdState, preset: ImageAdPreset | null): ImageAdState {
  const fixed = imageAdBuild(state.build).presetQuality;
  return { ...state, preset, quality: preset && fixed ? fixed : state.quality };
}
/** Whether a quality chip is off, and why (never hidden). */
export function qualityOff(state: Pick<ImageAdState, "build" | "preset">, quality: string): string | null {
  const fixed = imageAdBuild(state.build).presetQuality;
  return state.preset && fixed && quality !== fixed ? `A preset runs at ${fixed} quality on ${imageAdBuild(state.build).label}.` : null;
}

/** Why Generate image is off; null when it can run. */
export function imageAdBlock(state: ImageAdState, extra: { hasProject: boolean; saved: boolean }): string | null {
  if (!extra.hasProject) return "Open a project first.";
  if (!extra.saved) return "Save this project first.";
  if (!state.prompt.trim()) return "Write the prompt.";
  if (state.prompt.trim().length > IMAGE_AD_PROMPT_MAX) return `Keep the prompt under ${IMAGE_AD_PROMPT_MAX.toLocaleString("en-US")} characters.`;
  const stills = imageAdMedias(state).length;
  if (state.preset && !state.productStill) return "A preset starts from the product still. Add the product.";
  if (state.preset && stills > PRESET_STILLS_MAX) return "A preset takes the product still and one more still at most.";
  if (stills > IMAGE_AD_MAX) return `Up to ${IMAGE_AD_MAX} reference stills.`;
  if (!IMAGE_AD_ASPECTS.includes(state.aspect) || !IMAGE_AD_RESOLUTIONS.includes(state.resolution)) return "Choose a supported aspect and size.";
  if (!imageAdBuild(state.build).qualities.includes(state.quality) || qualityOff(state, state.quality)) return "Choose a supported quality.";
  return null;
}

/** The settings admission reads (lib/higgsfieldMarketing.ts › marketingSettings): a preset turns enhancement on. */
export function imageAdSettings(state: ImageAdState): Record<string, unknown> {
  const build = imageAdBuild(state.build);
  return {
    ...(build.variant ? { variant: build.variant } : {}),
    quality: state.preset && build.presetQuality ? build.presetQuality : state.quality,
    enhancePrompt: Boolean(state.preset),
    ...(state.preset ? { presetId: state.preset.id } : {}),
  };
}

/** The request the shared dispatch prices and sends: filed to the saved project (no shot), the stills by identity, product first. */
export function imageAdRequest(state: ImageAdState, project: { productionProjectId: string }): DispatchRequest {
  const build = imageAdBuild(state.build);
  return {
    endpoint: "/api/generate",
    input: {
      prompt: state.prompt.trim(),
      kind: "image",
      model: { id: build.model, marketing: true },
      mapping: { productionProjectId: project.productionProjectId },
      ratio: state.aspect,
      resolution: state.resolution,
      duration: 0,
      references: imageAdMedias(state).map((m) => ({ ...(m.origin === "upload" ? { uploadId: m.sourceId } : { genId: m.sourceId }), role: "reference_image" })),
      marketing: imageAdSettings(state),
    },
  };
}

/* ── The preset catalogue ─────────────────────────────────────────────── */
export type PresetItem = { id: string; name: string; type: string; cover?: string; group?: string; aspectRatio?: string };
const words = (value: string) => {
  const text = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
};
/** The shelf a preset sits on: the provider's own group ("Product shots", "Graphic ads"…), else its kind in words. */
export const presetGroup = (item: Pick<PresetItem, "group" | "type">) => item.group?.trim() || words(item.type) || "Other";
/** The catalogue as shelves, in the order the provider lists them; nothing is invented or re-ranked. */
export function presetShelves(items: readonly PresetItem[]): { group: string; items: PresetItem[] }[] {
  const shelves = new Map<string, PresetItem[]>();
  for (const item of items) {
    const group = presetGroup(item);
    const shelf = shelves.get(group);
    if (shelf) { if (!shelf.some((p) => p.id === item.id)) shelf.push(item); }
    else shelves.set(group, [item]);
  }
  return [...shelves].map(([group, list]) => ({ group, items: list }));
}
/** A catalogue page merged into what is loaded: each preset once, the order kept. */
export function mergePresets(loaded: readonly PresetItem[], page: readonly PresetItem[]): PresetItem[] {
  const seen = new Set(loaded.map((p) => p.id));
  return [...loaded, ...page.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))];
}

/* ── The draft, per project in this tab ───────────────────────────────── */
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const LIBRARY_ID = /^(upload|generation):[^\s]{1,200}$/;
const SAFE_URL = /^(\/(?!\/)|https:\/\/)\S{1,2048}$/;
const PRESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stillOf(value: unknown): AdStill | null {
  const v = obj(value);
  if (!v || typeof v.id !== "string" || !LIBRARY_ID.test(v.id) || typeof v.name !== "string" || typeof v.sourceId !== "string" || !v.sourceId || v.sourceId.length > 200 ||
      (v.origin !== "upload" && v.origin !== "generation") || typeof v.url !== "string" || !SAFE_URL.test(v.url)) return null;
  return { id: v.id, name: v.name.slice(0, 300), sourceId: v.sourceId, origin: v.origin, url: v.url };
}
/** What comes back from storage is read field by field; anything that does not read cleanly falls back to the default. */
export function restoreImageAd(value: unknown): ImageAdState | null {
  const v = obj(value);
  if (!v) return null;
  const build = IMAGE_AD_BUILDS.some((b) => b.id === v.build) ? String(v.build) : INITIAL_IMAGE_AD.build;
  const presetValue = obj(v.preset);
  const preset = presetValue && typeof presetValue.id === "string" && PRESET_ID.test(presetValue.id) && typeof presetValue.name === "string"
    ? { id: presetValue.id, name: presetValue.name.slice(0, 300) } : null;
  const state: ImageAdState = {
    build,
    prompt: typeof v.prompt === "string" ? v.prompt.slice(0, IMAGE_AD_PROMPT_MAX) : "",
    aspect: typeof v.aspect === "string" && IMAGE_AD_ASPECTS.includes(v.aspect) ? v.aspect : INITIAL_IMAGE_AD.aspect,
    resolution: typeof v.resolution === "string" && IMAGE_AD_RESOLUTIONS.includes(v.resolution) ? v.resolution : INITIAL_IMAGE_AD.resolution,
    quality: typeof v.quality === "string" && imageAdBuild(build).qualities.includes(v.quality) ? v.quality : INITIAL_IMAGE_AD.quality,
    preset: null,
    productStill: stillOf(v.productStill),
    medias: (Array.isArray(v.medias) ? v.medias : []).flatMap((m) => { const still = stillOf(m); return still ? [still] : []; }).slice(0, IMAGE_AD_MAX),
  };
  /* The provider's rules hold on the way back in too. */
  return withPreset(withProductStill(state, state.productStill), preset);
}
