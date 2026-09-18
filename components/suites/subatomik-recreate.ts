import {
  GENJUTSU_LIMITS,
  genjutsuVariantForModel,
  type GenjutsuResolution,
} from "@/lib/genjutsuTypes";
import type { Generation } from "@/lib/jobs";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function identity(value: Record<string, unknown>) {
  if (id(value.genId) === id(value.uploadId))
    throw Error("A saved reference has an ambiguous identity.");
  return id(value.genId)
    ? `generation:${value.genId}`
    : `upload:${value.uploadId}`;
}

/** Restore recorded controls only. Missing references are not equivalent to an empty reference list. */
export function recreationSettings(take: Generation) {
  const variant = genjutsuVariantForModel(take.model),
    params = take.params;
  if (
    !variant ||
    !record(params) ||
    !Array.isArray(params.references) ||
    params.references.length > GENJUTSU_LIMITS.maxImages + 1 ||
    !["480p", "720p"].includes(String(params.resolution))
  )
    throw Error(
      "The original source, reference order or quality settings were not retained for this take.",
    );
  const sourceGenId = params.sourceGenId ?? take.sourceGenId,
    sourceUploadId = params.sourceUploadId;
  if (id(sourceGenId) === id(sourceUploadId))
    throw Error("The original source identity was not retained for this take.");
  if (
    id(params.sourceGenId) &&
    id(take.sourceGenId) &&
    params.sourceGenId !== take.sourceGenId
  )
    throw Error("The saved source identities do not agree.");
  const source = id(sourceGenId)
    ? `generation:${sourceGenId}`
    : `upload:${sourceUploadId}`;
  const references: string[] = [];
  for (const reference of params.references) {
    if (!record(reference)) throw Error("A saved reference is incomplete.");
    const key = identity(reference);
    if (
      reference.role === "reference_video" &&
      key === source &&
      reference.kind === "video"
    )
      continue;
    if (
      reference.role !== "reference_image" ||
      reference.kind !== "image" ||
      references.includes(key)
    )
      throw Error("The saved image reference order could not be verified.");
    references.push(key);
  }
  if (references.length > GENJUTSU_LIMITS.maxImages)
    throw Error(
      "This take uses more image references than the connected API supports.",
    );
  const prompt =
    typeof params.rawPrompt === "string" ? params.rawPrompt : take.prompt;
  if (
    typeof prompt !== "string" ||
    prompt.length > GENJUTSU_LIMITS.maxPromptChars
  )
    throw Error("The original prompt was not retained for this take.");
  return {
    variant,
    source,
    references,
    prompt,
    resolution: params.resolution as GenjutsuResolution,
  };
}

export function recreationProblem(take: Generation) {
  try {
    recreationSettings(take);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Saved generation settings are unavailable.";
  }
}
