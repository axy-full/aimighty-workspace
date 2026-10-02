/** A saved original, by its identity only (never a URL). */
export type MediaIdentity = { genId: string } | { uploadId: string };

/**
 * The transform body POST /api/generate (and POST /api/generate/quote) takes
 * for Motion Transfer and Object Swap on the API key: one source video apart,
 * then 1–8 ordered stills, each a `reference_image`, filed to the saved
 * project with no shot. The source decides the shape and length, so no ratio,
 * duration or first frame is sent — exactly the body the Subatomik studio
 * sends, which admission's transform checks were written for. Pure, so the
 * Viral composer (lib/workbench/generation-request.ts) and the page's Atomik
 * plan (lib/workspace/plans.ts) build it the same way.
 */
export function genjutsuBody(input: {
  model: string;
  prompt: string;
  resolution: string;
  source: MediaIdentity;
  references: readonly MediaIdentity[];
  /** The production project the take files to. */
  projectId: string;
  /** The person's own draft of it: admission checks it is theirs and linked to that project. */
  workbenchProjectId: string;
  maxCredits?: number;
  quoteFingerprint?: string;
}): Record<string, unknown> {
  return {
    model: input.model,
    task: "genjutsu",
    ...("uploadId" in input.source ? { sourceUploadId: input.source.uploadId } : { sourceGenId: input.source.genId }),
    references: input.references.map((reference) => ({ ...("uploadId" in reference ? { uploadId: reference.uploadId } : { genId: reference.genId }), role: "reference_image" })),
    resolution: input.resolution,
    prompt: input.prompt,
    projectId: input.projectId,
    workbenchProjectId: input.workbenchProjectId,
    refine: false,
    ...(input.maxCredits === undefined ? {} : { maxCredits: input.maxCredits }),
    ...(input.quoteFingerprint ? { quoteFingerprint: input.quoteFingerprint } : {}),
  };
}

/** An identity read from a page's published request: exactly one saved id, never anything else. */
export function mediaIdentity(value: unknown): MediaIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const id = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(x);
  if (id(v.uploadId) === id(v.genId)) return null;
  return id(v.uploadId) ? { uploadId: v.uploadId } : { genId: v.genId as string };
}
