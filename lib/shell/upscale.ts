import { ASTRA_MODEL, DEFAULT_ASTRA, type AstraSettings } from "@/lib/astra";
import { DEFAULT_TOPAZ_IMAGE, TOPAZ_IMAGE_MODEL, type TopazImageSettings } from "@/lib/topaz";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * Make › Upscale (the graphite Make frames (deleted in redesign C3; Make is now docs/redesign/inventory.md § 5.12): the third quick tool beside Motion transfer and Object swap):
 * the request bodies the two existing upscale panels send (components/make/AstraUpscale.tsx for a clip,
 * components/make/TopazImageUpscale.tsx for a still) through the existing quote and send routes
 * (POST /api/generate/quote, POST /api/generate). Pure; nothing here prices anything, the server's quote does.
 */

/** Sources are written in the library's own words: a take or an upload, by the id the route takes. */
export type UpscaleSource = {
  /** The library id (`generation:<id>` / `upload:<id>`), what the Library's `+` and a right-click hand over. */
  id: string;
  sourceId: string;
  origin: "generation" | "upload";
  kind: "video" | "image";
  name: string;
  url: string;
};

/** What a person may upscale: a finished picture or clip in the project's Library (never one still rendering, held or failed). */
export function upscaleSource(entry: LibraryEntry): UpscaleSource | null {
  if (!entry.url || (entry.media !== "video" && entry.media !== "image")) return null;
  if (entry.asset.origin === "generation") {
    const status = entry.take.status;
    if (status !== "review" && status !== "picked" && status !== "approved" && status !== "changes") return null;
    if (entry.asset.value.kind === "model") return null;
  }
  return { id: entry.take.id, sourceId: entry.take.sourceId, origin: entry.asset.origin, kind: entry.media, name: entry.take.name, url: entry.url };
}

export const upscaleSources = (items: readonly LibraryEntry[]): UpscaleSource[] => items.flatMap((entry) => upscaleSource(entry) ?? []);

/** A clip: Topaz Astra 2 (the model's own name), creative upscale to 4K at the chosen frame rate. */
export function videoUpscaleBody(source: Pick<UpscaleSource, "origin" | "sourceId"> | null, productionProjectId: string | null, settings: AstraSettings = DEFAULT_ASTRA): Record<string, unknown> {
  return {
    projectId: productionProjectId,
    model: ASTRA_MODEL,
    task: "upscale",
    prompt: "",
    refine: false,
    sourceGenId: source?.origin === "generation" ? source.sourceId : undefined,
    sourceUploadId: source?.origin === "upload" ? source.sourceId : undefined,
    resolution: "4k",
    fps60: settings.fps === 60,
    astra: settings,
    references: [],
  };
}

/** A still: Topaz image upscale at the chosen scale. */
export function imageUpscaleBody(source: Pick<UpscaleSource, "origin" | "sourceId"> | null, productionProjectId: string | null, settings: TopazImageSettings = DEFAULT_TOPAZ_IMAGE): Record<string, unknown> {
  return {
    projectId: productionProjectId,
    model: TOPAZ_IMAGE_MODEL,
    task: "generate",
    prompt: "",
    resolution: "24MP",
    ratio: "adaptive",
    refine: false,
    topaz: settings,
    references: source ? [source.origin === "upload" ? { uploadId: source.sourceId, role: "reference_image" } : { genId: source.sourceId, role: "reference_image" }] : [],
  };
}

/** The paid action's own storage name for each: the same one the existing panels use, so a saved request is recovered by either. */
export const upscaleSurface = (kind: "video" | "image", projectId: string | null) => `gen:${kind === "video" ? "astra-2-upscale" : "topaz-image-upscale"}${projectId ? `:${projectId}` : ""}`;

/** The scales a still offers (the model's own: the output is the source's size times it, up to its limit). */
export const IMAGE_SCALES = [2, 4] as const;
export const FRAME_RATES = [30, 60] as const;

/** The model's name, as the panel's engine line reads it. */
export const upscaleModel = (kind: "video" | "image") => (kind === "video" ? "Topaz Astra 2" : "Topaz image upscale");
