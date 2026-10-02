/**
 * An account original the Library still holds, known by its own record: the
 * generation's model and params, never the account's request contracts
 * (Particl no longer signs in to Higgsfield; CLAUDE.md ground rule 10). Pure,
 * so the take's charge line, its media type and Recreate read it alike.
 */
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
/** The account's Genjutsu models (Motion Transfer and Object Swap), as its collected originals name them. */
const CONSUMER_GENJUTSU_MODELS: readonly string[] = ["hf_mult_motion_control", "hf_mult_replace_object"];
export const isConsumerVideoModel = (model: string) =>
  model === "marketing_studio_video" || CONSUMER_GENJUTSU_MODELS.includes(model);
