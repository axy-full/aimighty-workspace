import { DEFAULT_MODEL_ID, MODELS, AUDIO_LABELS, displayModelName, type ModelDef } from "../models";

/**
 * Engines as the Rig names and constrains them.
 *
 * Browser-safe: reads only the public catalogue in lib/models.ts (never
 * lib/vendorRates.ts). Model ids stay what they are, because an id is what is
 * sent to the engine.
 *
 * Every long name comes from `displayModelName` (lib/models.ts), the product's
 * one display-name function — so a directly integrated engine reads under its
 * real name (owner decision, 20 September 2026). This module adds only the
 * Rig's narrow ENGINE column, which abbreviates rather than renames.
 */

export type EngineLabel = {
  /** The Rig's ENGINE column, abbreviated to fit: "2.5", "2.0", "NB 2". */
  short: string;
  /** Everywhere else, the real name: "Seedance 2.5", "Nano Banana 2". */
  long: string;
};

const FIXED: Record<string, EngineLabel> = {
  "dreamina-seedance-2-5-260628": { short: "2.5", long: "Seedance 2.5" },
  "dreamina-seedance-2-0-260128": { short: "2.0", long: "Seedance 2.0" },
  "fal-ai/kling-video/v3/standard": { short: "K 3.0", long: "Kling 3.0" },
  "fal-ai/kling-video/v3/pro": { short: "K 3.0 Pro", long: "Kling 3.0 Pro" },
  "topaz/upscale/video/creative": { short: "Upscale", long: "Topaz Astra 2" },
  "fal-ai/luma-dream-machine/ray-2-flash/reframe": { short: "Reframe", long: "Luma Ray 2" },
  "fal-ai/topaz/upscale/image": { short: "Upscale", long: "Topaz Image Upscale" },
  "fal-ai/bria/expand": { short: "Expand", long: "Bria Expand" },
  "fal-ai/bria/background/remove": { short: "Cutout", long: "Bria Cutout" },
  "gemini-3-pro-image": { short: "NB Pro", long: "Nano Banana Pro" },
  "gemini-3.1-flash-image": { short: "NB 2", long: "Nano Banana 2" },
  /* Connected-account surfaces keep neutral names (rule 2 in lib/vendorNames.ts). */
  "higgsfield-genjutsu-motion-transfer": { short: "Transfer", long: "Motion transfer" },
  "higgsfield-genjutsu-object-swap": { short: "Swap", long: "Object swap" },
  "higgsfield/marketing-studio-image": { short: "Marketing", long: "Marketing image" },
  marketing_studio_video: { short: "Marketing", long: "Marketing video" },
  "hf-soul-character": { short: "Identity", long: "Identity render" },
  "fal-ai/flux-lora": { short: "Identity", long: "Flux · Identity" },
};

/** Sound engines: the column abbreviates by capability, the long name is the
 *  engine's own. */
function audioLabel(modelId: string): EngineLabel | null {
  if (!AUDIO_LABELS[modelId]) return null;
  const short = modelId === "eleven_sfx" ? "SFX" : modelId === "eleven_music" ? "Music" : "Voice";
  return { short, long: displayModelName(modelId) };
}

/** A label for any model id; unknown or retired ids never leak their raw id. */
export function engineLabel(modelId: string | null | undefined): EngineLabel {
  const id = modelId ?? "";
  const fixed = FIXED[id];
  if (fixed) return { short: fixed.short, long: displayModelName(id) };
  const known = audioLabel(id);
  if (known) return known;
  /* Retired dated Seedance builds keep their family's name. */
  if (/seedance-2-5/.test(id)) return FIXED["dreamina-seedance-2-5-260628"];
  if (/seedance-2-0/.test(id)) return FIXED["dreamina-seedance-2-0-260128"];
  const model = MODELS.find((m) => m.id === id);
  if (model?.kind === "image") return { short: "Image", long: "Image engine" };
  return { short: "Engine", long: "Video engine" };
}

/** Engines a shot may render with: generation engines from the public catalogue, not tools. */
export function shotEngines(models: ModelDef[] = MODELS): ModelDef[] {
  return models.filter((m) => !m.hidden && !m.stillTask && (m.supportsTasks ?? ["generate"]).includes("generate"));
}

export const DEFAULT_SHOT_ENGINE = DEFAULT_MODEL_ID;
export const DEFAULT_SHOT_SECONDS = 5;
export const DEFAULT_SHOT_RESOLUTION = "720p";

export function shotEngine(modelId: string | null | undefined): ModelDef | null {
  return shotEngines().find((m) => m.id === modelId) ?? null;
}

/** The engine's real allowed seconds, or null for engines with no duration (stills). */
export function durationRange(model: ModelDef): { min: number; max: number } | null {
  if (model.kind !== "video" || !model.durations.length) return null;
  return { min: Math.min(...model.durations), max: Math.max(...model.durations) };
}

/**
 * Clamp a requested length onto what the engine accepts: into its range, then
 * to the nearest listed second. Absent or non-finite → the engine's default.
 * Stills have no duration and always return undefined.
 */
export function clampShotSeconds(model: ModelDef, seconds: number | null | undefined): number | undefined {
  if (!durationRange(model)) return undefined;
  if (seconds == null || !Number.isFinite(seconds)) return defaultShotSeconds(model);
  return model.durations.reduce((best, d) => (Math.abs(d - seconds) < Math.abs(best - seconds) ? d : best), model.durations[0]);
}

export function defaultShotSeconds(model: ModelDef): number | undefined {
  if (!durationRange(model)) return undefined;
  return model.durations.includes(DEFAULT_SHOT_SECONDS) ? DEFAULT_SHOT_SECONDS : model.durations[0];
}

export function defaultShotRatio(model: ModelDef, projectAspect?: string): string {
  if (projectAspect && model.ratios.includes(projectAspect)) return projectAspect;
  return model.ratios.includes("16:9") ? "16:9" : model.ratios[0];
}

export function defaultShotResolution(model: ModelDef): string {
  return model.resolutions.includes(DEFAULT_SHOT_RESOLUTION) ? DEFAULT_SHOT_RESOLUTION : model.resolutions[0];
}

export type ShotSettings = { engine: string; durationS?: number; ratio: string; resolution: string };

/**
 * The settings a shot actually renders with: stored values where the engine
 * supports them, otherwise the engine's defaults. `null` when the engine is
 * not a shot engine (retired or a tool).
 */
export function resolveShotSettings(
  stored: { engine?: string; durationS?: number; ratio?: string; resolution?: string },
  projectAspect?: string,
): ShotSettings | null {
  const model = shotEngine(stored.engine ?? DEFAULT_SHOT_ENGINE);
  if (!model) return null;
  return {
    engine: model.id,
    durationS: clampShotSeconds(model, stored.durationS),
    ratio: stored.ratio && model.ratios.includes(stored.ratio) ? stored.ratio : defaultShotRatio(model, projectAspect),
    resolution: stored.resolution && model.resolutions.includes(stored.resolution) ? stored.resolution : defaultShotResolution(model),
  };
}
