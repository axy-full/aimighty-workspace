import type { ConsumerJob } from "./jobs";
import { parseConsumerVideoInput } from "./video-contract";
import {
  CONSUMER_GENJUTSU_MODELS,
  parseConsumerGenjutsuInput,
} from "./genjutsu-contract";
import { GENERATION_OUTPUT_KIND, parseConsumerGenerationInput } from "./generation-contract";
import { mediaKindForRole } from "./catalogue";
export type ConsumerOriginalKind = "video" | "image" | "audio" | "model";
export const CONSUMER_ORIGINAL_MIMES: Record<ConsumerOriginalKind, readonly string[]> = {
  video: ["video/mp4"],
  image: ["image/png", "image/jpeg", "image/webp"],
  audio: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/aac", "audio/flac"],
  model: ["model/gltf-binary", "application/zip"],
};
/** A retained connected-account original of any kind, identified by its params. */
export const isConsumerOriginalParams = (params: Record<string, unknown> | null | undefined) =>
  params?.task === "connected-generation" && params.consumerCreditUnit === "higgsfield_credits";
export const isConsumerVideoModel = (model: string) =>
  model === "marketing_studio_video" ||
  Object.values(CONSUMER_GENJUTSU_MODELS).includes(
    model as (typeof CONSUMER_GENJUTSU_MODELS)[keyof typeof CONSUMER_GENJUTSU_MODELS],
  );
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Derive retained media identity only from the immutable admitted workflow. */
export function consumerVideoIdentity(job: ConsumerJob) {
  const payload: unknown = JSON.parse(job.payloadJson);
  if (!object(payload)) throw Error("Invalid original payload.");
  if (job.workflow === "marketing-video") {
    const input = parseConsumerVideoInput(payload.input);
    return {
      model: "marketing_studio_video",
      kind: "video" as ConsumerOriginalKind,
      prompt: input.prompt,
      params: {
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
        ratio: input.aspectRatio,
        generateAudio: input.generateAudio,
      } as Record<string, unknown>,
    };
  }
  const provider = payload.params;
  if (job.workflow === "generation") {
    const input = parseConsumerGenerationInput(payload.input);
    if (!object(provider) || provider.model !== input.model)
      throw Error("The original model differs from its admission.");
    return {
      model: input.model,
      kind: GENERATION_OUTPUT_KIND[input.type],
      prompt: input.prompt,
      params: {
        task: "connected-generation",
        outputType: input.type,
        workbenchProjectId: job.draftId,
        settings: input.parameters,
        references: input.medias.map((media) => ({
          ...media.source,
          role: media.role,
          kind: mediaKindForRole(media.role),
        })),
      } as Record<string, unknown>,
    };
  }
  if (job.workflow !== "genjutsu" || !object(provider))
    throw Error("Invalid Genjutsu original payload.");
  const input = parseConsumerGenjutsuInput(payload.input),
    model = CONSUMER_GENJUTSU_MODELS[input.variant];
  if (provider.model !== model)
    throw Error("The original model differs from its admission.");
  const source = input.source,
    references = input.references.map((value) => ({
      ...value,
      role: "reference_image",
      kind: "image",
    }));
  return {
    model,
    kind: "video" as ConsumerOriginalKind,
    prompt: input.prompt,
    params: {
      task: "genjutsu",
      workbenchProjectId: job.draftId,
      resolution: input.resolution,
      ...(source.uploadId
        ? { sourceUploadId: source.uploadId }
        : { sourceGenId: source.genId }),
      references,
    } as Record<string, unknown>,
  };
}
