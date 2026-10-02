import type { Reference, VideoParams } from "./ark";
import { HiggsfieldHttpError } from "./higgsfield";
import { engineMock } from "./mock";
import { imagePath, videoPath, uploadPath, usingBlob, presignedReadUrl } from "./storage";
import { estimateCostUsd, listRate } from "./vendorPricing";
import { costUsd } from "./models";
import type { PricingWatch } from "./higgsfieldPricingWatch";
import { cinemaSoundPricing, cinemaSoundUsd } from "./cinemaSoundPricing";
/** The deploy-time switch, beside the engine it switches (defined with the rates in lib/vendorRates.ts). */
export { cinemaStudioEnabled } from "./vendorRates";
import {
  CINEMA_STUDIO_LIMITS,
  CINEMA_STUDIO_MODEL_ID,
  CINEMA_STUDIO_PATH,
  CINEMA_STUDIO_RATIOS,
  CINEMA_STUDIO_RESOLUTIONS,
  isCinemaStudioAudioMime,
  readCinemaControls,
} from "./cinemaStudioTypes";

type QuoteParams = Pick<VideoParams, "resolution" | "ratio" | "duration" | "hasVideoInput" | "inputSeconds" | "generateAudio">;

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
 * (billedFrame), so it is priced through the same estimateCostUsd and the
 * existing credit terms. The provider does not publish the exact frame for
 * each aspect, and its estimate endpoint states the formula but returns no
 * figure, so this is an APPROXIMATE quote: the take settles on its delivered
 * output (cinemaStudioSettlementUsd). Admission keeps the quote on the take
 * and dispatch refuses to send if the settings no longer price the same.
 * Null means no price: the settings or reference seconds are outside the
 * engine's contract.
 *
 * The creative controls (camera, lens, aperture, movement, era, genre, light,
 * pacing, palette) and sound references are not in the formula: the published
 * text counts only seconds and pixels and says image and audio references do
 * not count as video input. So they are not read here, and choosing them
 * leaves the quote and the dispatch re-price exactly where they were. Should
 * the published text change, the pricing watch below flags it.
 *
 * The Sound switch (generate_audio) is not in the published text either. A take
 * asked for with sound adds what the provider's measured charge for sound says
 * (lib/cinemaSoundPricing.ts), on the generated seconds; until that is set it
 * adds nothing, and only the house workspace may ask for sound at all.
 */
export function cinemaStudioQuoteUsd(params: QuoteParams): number | null {
  if (settingsProblem(params)) return null;
  const inputSeconds = params.hasVideoInput ? Number(params.inputSeconds) : 0;
  if (!Number.isFinite(inputSeconds) || inputSeconds < 0 || inputSeconds > CINEMA_STUDIO_LIMITS.maxVideoSeconds ||
      (params.hasVideoInput && !(inputSeconds > 0)))
    return null;
  const estimate = estimateCostUsd(CINEMA_STUDIO_MODEL_ID, params.resolution, params.ratio, params.duration,
    inputSeconds, Boolean(params.hasVideoInput));
  if (!estimate || !Number.isFinite(estimate.net) || !(estimate.net > 0)) return null;
  if (!params.generateAudio) return estimate.net;
  const output = estimateCostUsd(CINEMA_STUDIO_MODEL_ID, params.resolution, params.ratio, params.duration, 0, Boolean(params.hasVideoInput));
  if (!output || !Number.isFinite(output.net)) return null;
  return estimate.net + cinemaSoundUsd(cinemaSoundPricing(), { seconds: params.duration, outputUsd: output.net });
}

/**
 * What the provider bills for a delivered take: the same published formula on
 * the output's measured frame and length, plus the quoted reference seconds,
 * at the rate the clip input set, and, for a take made with sound, what sound
 * adds on the delivered seconds. Null when the output cannot be measured.
 */
export function cinemaStudioDeliveredUsd(delivered: {
  resolution: string; width: number; height: number; seconds: number;
  hasVideoInput?: boolean; inputSeconds?: number; generateAudio?: boolean;
}): number | null {
  if (![delivered.width, delivered.height, delivered.seconds].every(n => Number.isFinite(n) && n > 0)) return null;
  const inputSeconds = delivered.hasVideoInput ? Number(delivered.inputSeconds) : 0;
  if (!Number.isFinite(inputSeconds) || inputSeconds < 0) return null;
  const rate = listRate(CINEMA_STUDIO_MODEL_ID, delivered.resolution, Boolean(delivered.hasVideoInput));
  if (rate == null) return null;
  const tokens = Math.ceil(((inputSeconds + delivered.seconds) * delivered.width * delivered.height * 24) / 1024);
  const usd = costUsd(tokens, rate);
  if (!delivered.generateAudio) return usd;
  const outputUsd = costUsd(Math.ceil((delivered.seconds * delivered.width * delivered.height * 24) / 1024), rate);
  return usd + cinemaSoundUsd(cinemaSoundPricing(), { seconds: delivered.seconds, outputUsd });
}

/**
 * The settled cost: the provider's own charge for the job when it states one,
 * else the delivered-output figure. Either is used only within half to three
 * times the quote; outside that band a unit or measurement mistake is assumed
 * and the quote stands, so a take can never bill far past what was shown.
 */
export function cinemaStudioSettlementUsd(quoteUsd: number, deliveredUsd: number | null, reportedUsd?: number | null): number {
  const sane = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= quoteUsd * 0.5 && value <= quoteUsd * 3;
  if (sane(reportedUsd)) return reportedUsd;
  if (sane(deliveredUsd)) return deliveredUsd;
  return quoteUsd;
}

/** The published pricing this engine is priced from, watched for change (lib/higgsfieldPricingWatch.ts). */
export const CINEMA_STUDIO_PRICING_WATCH: PricingWatch = {
  model: CINEMA_STUDIO_MODEL_ID,
  path: CINEMA_STUDIO_PATH,
  body: { prompt: "A quiet harbour at dawn", duration: 5, resolution: "720p" },
  expectedSha256: "5ed5f27b50e0d72e5e721a3db6ba994c57dbed6e80f285519ba56cee26f76f78",
  formulaUsd: () => cinemaStudioQuoteUsd({ resolution: "720p", ratio: "16:9", duration: 5 }),
};

/**
 * Particl cites attached media as @Image1 / @Video1 / @Audio1; the provider
 * reads <<<image_1>>> / <<<video_1>>> / <<<audio_1>>>, and each token must
 * name an attached item of that kind. A citation of media that is not
 * attached is left as written.
 */
export function cinemaStudioPrompt(prompt: string, images: number, videos: number, audios = 0): string {
  return prompt.replace(/@(image|video|audio)(\d+)\b/gi, (token, kind: string, n: string) => {
    const k = kind.toLowerCase(), index = Number(n);
    const count = k === "image" ? images : k === "video" ? videos : audios;
    return index >= 1 && index <= count ? `<<<${k}_${index}>>>` : token;
  });
}

/**
 * The request body, built only from the schema's own parameters. Only
 * admission's authorized, retained originals reach this; never a client URL.
 * Sound references are WAV uploads of this workspace (the provider documents
 * WAV as its audio input); a generated sound (MP3) never gets here. The
 * creative controls are checked again against the documented values and sent
 * only when picked: a control on Auto is left out, so the model chooses it.
 */
export async function cinemaStudioInput(prompt: string, params: VideoParams, references: Reference[]) {
  if (typeof prompt !== "string" || !/\S/.test(prompt) || prompt.length > 10000 || settingsProblem(params))
    throw new HiggsfieldHttpError(422, "Cinema Studio needs a prompt, 4–30 seconds, 480p or 720p and a supported aspect ratio.");
  const controls = readCinemaControls(params.cinema);
  if (!controls.ok) throw new HiggsfieldHttpError(422, controls.error);
  const images = references.filter(ref => ref.kind === "image");
  const videos = references.filter(ref => ref.kind === "video");
  const audios = references.filter(ref => ref.kind === "audio");
  if (images.length + videos.length + audios.length !== references.length ||
      images.some(ref => ref.role !== "reference_image") || videos.some(ref => ref.role !== "reference_video") ||
      audios.some(ref => ref.role !== "reference_audio" || ref.fromGeneration) ||
      images.length > CINEMA_STUDIO_LIMITS.maxImages || videos.length > CINEMA_STUDIO_LIMITS.maxVideos ||
      audios.length > CINEMA_STUDIO_LIMITS.maxAudios || references.length > CINEMA_STUDIO_LIMITS.maxReferences)
    throw new HiggsfieldHttpError(422, "Cinema Studio takes up to 30 reference stills, 10 reference clips and 10 sound references, cited in the prompt. It has no first or last frame.");
  if (audios.some(ref => !isCinemaStudioAudioMime(ref.mime)))
    throw new HiggsfieldHttpError(422, "Cinema Studio takes sound references as WAV files.");
  if (references.some(ref => !/^[A-Za-z0-9_-]{1,160}$/.test(ref.id) || !/^[A-Za-z0-9]+$/.test(ref.ext)))
    throw new HiggsfieldHttpError(422, "A Cinema Studio reference identity is invalid.");
  if (!engineMock() && references.length && !usingBlob())
    throw new HiggsfieldHttpError(422, "Cinema Studio references require deployed private media storage.");
  const signed = (ref: Reference) => {
    const path = ref.fromGeneration ? (ref.kind === "video" ? videoPath(ref.id) : imagePath(ref.id)) : uploadPath(ref.id, ref.ext);
    return engineMock() ? `https://fixtures.particl.invalid/${path}` : presignedReadUrl(path, 0.25, ref.storedUrl);
  };
  const [imageUrls, videoUrls, audioUrls] = await Promise.all([
    Promise.all(images.map(signed)), Promise.all(videos.map(signed)), Promise.all(audios.map(signed)),
  ]);
  return {
    prompt: cinemaStudioPrompt(prompt, images.length, videos.length, audios.length),
    duration: params.duration,
    resolution: params.resolution,
    aspect_ratio: params.ratio,
    /* Always said, never left out: the provider's own default is sound on, and a take is silent unless its
       Sound switch was on. A sound reference does not turn it on. */
    generate_audio: Boolean(params.generateAudio),
    ...(imageUrls.length ? { image_urls: imageUrls } : {}),
    ...(videoUrls.length ? { video_urls: videoUrls } : {}),
    ...(audioUrls.length ? { audio_urls: audioUrls } : {}),
    ...controls.controls,
  };
}

export const cinemaStudioPreflightError = () => new HiggsfieldHttpError(422,
  "The Cinema Studio settings, connection or price changed or could not be verified. Nothing was submitted; review a fresh quote.");
