import { isGenjutsuModel } from "./genjutsuTypes";

/**
 * Cinema Studio 4.0: Higgsfield's own text- and reference-to-video engine on
 * the commercial API key (`POST /higgsfield/cinema-studio/4.0`). Browser-safe
 * facts only; what it costs lives in lib/vendorRates.ts, which never reaches
 * a browser.
 */
export const CINEMA_STUDIO_MODEL_ID = "higgsfield-cinema-studio-4.0";
/** The provider's route for the model. */
export const CINEMA_STUDIO_PATH = "higgsfield/cinema-studio/4.0";
export const CINEMA_STUDIO_RESOLUTIONS = ["720p", "480p"] as const;
export const CINEMA_STUDIO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
/** The published input schema's limits. Audio references are not offered here. */
export const CINEMA_STUDIO_LIMITS = {
  minSeconds: 4,
  maxSeconds: 30,
  maxImages: 30,
  maxVideos: 10,
  /** Reference video is billed with the output; above this the provider normalizes it, so it is refused. */
  maxVideoSeconds: 30,
  maxReferences: 50,
} as const;

export const isCinemaStudioModel = (model: string) => model === CINEMA_STUDIO_MODEL_ID;
/** Higgsfield video on the commercial key: one acknowledged request, polled and collected the same way. */
export const isHiggsfieldVideoModel = (model: string) =>
  isGenjutsuModel(model) || isCinemaStudioModel(model);
