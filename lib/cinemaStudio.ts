import type { Reference, VideoParams } from "./ark";
import { HiggsfieldHttpError } from "./higgsfield";
import { engineMock } from "./mock";
import { imagePath, videoPath, uploadPath, usingBlob, presignedReadUrl } from "./storage";
import { estimateCostUsd } from "./vendorPricing";
import {
  CINEMA_STUDIO_LIMITS,
  CINEMA_STUDIO_MODEL_ID,
  CINEMA_STUDIO_RATIOS,
  CINEMA_STUDIO_RESOLUTIONS,
} from "./cinemaStudioTypes";

type QuoteParams = Pick<VideoParams, "resolution" | "ratio" | "duration" | "hasVideoInput" | "inputSeconds">;

const oneOf = (values: readonly string[], value: unknown) => typeof value === "string" && values.includes(value);
function settingsProblem(params: Pick<VideoParams, "resolution" | "ratio" | "duration">): boolean {
  return !oneOf(CINEMA_STUDIO_RESOLUTIONS, params.resolution) || !oneOf(CINEMA_STUDIO_RATIOS, params.ratio) ||
    !Number.isInteger(params.duration) || params.duration < CINEMA_STUDIO_LIMITS.minSeconds || params.duration > CINEMA_STUDIO_LIMITS.maxSeconds;
}

/**
 * The provider's published formula: billable video tokens = (input video
 * seconds + generated seconds) × output width × output height × 24 / 1024,
 * at the with-video rate once any reference clip is sent (stills and sound do
 * not count as video input). That is the Seedance token formula
 * (lib/models.ts › estimateTokens) on the frame the meter counts
 * (billedFrame), so it is priced through the same estimateCostUsd, from the
 * operator's private rates. The provider's estimate endpoint states the
 * formula but returns no figure, so this is the quote; admission freezes it
 * on the take and the dispatch refuses to send if it no longer holds.
 * Null means no price: the engine is disabled, or the settings or reference
 * seconds are outside its contract.
 */
export function cinemaStudioQuoteUsd(params: QuoteParams): number | null {
  if (settingsProblem(params)) return null;
  const inputSeconds = params.hasVideoInput ? Number(params.inputSeconds) : 0;
  if (!Number.isFinite(inputSeconds) || inputSeconds < 0 || inputSeconds > CINEMA_STUDIO_LIMITS.maxVideoSeconds ||
      (params.hasVideoInput && !(inputSeconds > 0)))
    return null;
  const estimate = estimateCostUsd(CINEMA_STUDIO_MODEL_ID, params.resolution, params.ratio, params.duration,
    inputSeconds, Boolean(params.hasVideoInput));
  return estimate && Number.isFinite(estimate.net) && estimate.net > 0 ? estimate.net : null;
}

/**
 * Particl cites attached media as @Image1 / @Video1; the provider reads
 * <<<image_1>>> / <<<video_1>>>, and each token must name an attached item of
 * that kind. A citation of media that is not attached is left as written.
 */
export function cinemaStudioPrompt(prompt: string, images: number, videos: number): string {
  return prompt.replace(/@(image|video)(\d+)\b/gi, (token, kind: string, n: string) => {
    const index = Number(n), count = kind.toLowerCase() === "image" ? images : videos;
    return index >= 1 && index <= count ? `<<<${kind.toLowerCase()}_${index}>>>` : token;
  });
}

/** Only admission's authorized, retained originals reach this; never a client URL. */
export async function cinemaStudioInput(prompt: string, params: VideoParams, references: Reference[]) {
  if (typeof prompt !== "string" || !/\S/.test(prompt) || prompt.length > 10000 || settingsProblem(params))
    throw new HiggsfieldHttpError(422, "Cinema Studio needs a prompt, 4–30 seconds, 480p or 720p and a supported aspect ratio.");
  const images = references.filter(ref => ref.kind === "image");
  const videos = references.filter(ref => ref.kind === "video");
  if (images.some(ref => ref.role !== "reference_image") || videos.some(ref => ref.role !== "reference_video") ||
      images.length > CINEMA_STUDIO_LIMITS.maxImages || videos.length > CINEMA_STUDIO_LIMITS.maxVideos ||
      references.length > CINEMA_STUDIO_LIMITS.maxReferences)
    throw new HiggsfieldHttpError(422, "Cinema Studio takes up to 30 reference stills and 10 reference clips, cited in the prompt. It has no first or last frame.");
  if (references.some(ref => !/^[A-Za-z0-9_-]{1,160}$/.test(ref.id) || !/^[A-Za-z0-9]+$/.test(ref.ext)))
    throw new HiggsfieldHttpError(422, "A Cinema Studio reference identity is invalid.");
  if (!engineMock() && references.length && !usingBlob())
    throw new HiggsfieldHttpError(422, "Cinema Studio references require deployed private media storage.");
  const signed = (ref: Reference) => {
    const path = ref.fromGeneration ? (ref.kind === "video" ? videoPath(ref.id) : imagePath(ref.id)) : uploadPath(ref.id, ref.ext);
    return engineMock() ? `https://fixtures.particl.invalid/${path}` : presignedReadUrl(path, 0.25, ref.storedUrl);
  };
  const [imageUrls, videoUrls] = await Promise.all([Promise.all(images.map(signed)), Promise.all(videos.map(signed))]);
  return {
    prompt: cinemaStudioPrompt(prompt, images.length, videos.length),
    duration: params.duration,
    resolution: params.resolution,
    aspect_ratio: params.ratio,
    generate_audio: Boolean(params.generateAudio),
    ...(imageUrls.length ? { image_urls: imageUrls } : {}),
    ...(videoUrls.length ? { video_urls: videoUrls } : {}),
  };
}

export const cinemaStudioPreflightError = () => new HiggsfieldHttpError(422,
  "The Cinema Studio settings, connection or price changed or could not be verified. Nothing was submitted; review a fresh quote.");
