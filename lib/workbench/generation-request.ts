import type { Asset } from "./studio";
import { mediaReferenceIdentity } from "./media-reference-input";
import { uploadWorkbench } from "./upload";

/**
 * The image/video request body POST /api/generate (and POST /api/generate/quote)
 * receives from a Rig node. Extracted verbatim from GenerationDialog so the
 * dialog and the workspace Rig send one shape, built in one place.
 */

export type GenerationReference = ({ genId: string } | { uploadId: string }) & { role: string };

export type GenerationBodyInput = {
  prompt: string;
  kind: "image" | "video";
  model: { id: string; marketing?: boolean; soulIdentity?: boolean };
  mapping: { shotId: string; productionProjectId: string };
  ratio: string;
  resolution: string;
  duration: number;
  /** The approved credit ceiling. Omitted when the body is only being quoted. */
  maxCredits?: number;
  references: GenerationReference[];
  marketing?: unknown;
  /** The fingerprint of the quote being approved; POST /api/generate refuses a request whose price or inputs changed since. */
  quoteFingerprint?: string;
  firstFrameAssetId?: string;
  /** A trained identity (this workspace's own id), its likeness strength, and — for Soul Standard, Soul 2 and Soul Cinema — stills per request (1 or 4). */
  soul?: { soulIdentityId: string; soulStrength: number; workbenchProjectId: string; soulBatch?: number };
  /** The shot setup picked from the camera bank (Gen's film vocabulary), kept on the take so Recreate brings it back. */
  shotSpec?: Record<string, string> | null;
  /** One take of a batch (Gen's takes 2–4): admission stores both, and Takes shows the siblings as one strip. */
  batch?: { id: string; variation: number };
  /** Seedance 2.5 draft mode (lib/draftFinal.ts): a 480p watermarked draft whose 1080p final is made after. */
  draft?: boolean;
  /** Cinema Studio 4.0's creative controls (lib/cinemaStudioTypes.ts): only picked ones; none is every control on Auto. */
  cinema?: Record<string, string> | null;
  /** Cinema Studio 4.0's Sound switch: sent only when it is on. Absent, admission keeps the take silent. */
  generateAudio?: boolean;
};

export function generationRequestBody(input: GenerationBodyInput): Record<string, unknown> {
  const { model } = input;
  return {
    prompt: input.prompt,
    model: model.id,
    projectId: input.mapping.productionProjectId,
    shotId: input.mapping.shotId,
    ratio: input.ratio,
    resolution: input.resolution,
    ...(model.marketing ? {} : { duration: input.duration }),
    refine: false,
    ...(input.maxCredits === undefined ? {} : { maxCredits: input.maxCredits }),
    references: input.references,
    ...(model.marketing ? { marketing: input.marketing, quoteFingerprint: input.quoteFingerprint } : input.quoteFingerprint ? { quoteFingerprint: input.quoteFingerprint } : {}),
    ...(input.kind === "video" ? { firstFrameAssetId: input.firstFrameAssetId ?? "" } : {}),
    ...(model.soulIdentity && input.soul ? input.soul : {}),
    ...(input.shotSpec && Object.keys(input.shotSpec).length ? { shotSpec: input.shotSpec } : {}),
    ...(input.batch ? { batchId: input.batch.id, variation: input.batch.variation } : {}),
    ...(input.draft && input.kind === "video" ? { draft: true } : {}),
    ...(input.cinema && Object.keys(input.cinema).length ? { cinema: input.cinema } : {}),
    ...(input.generateAudio === true && input.kind === "video" ? { generateAudio: true } : {}),
  };
}

/**
 * The body POST /api/generate (and its quote) receives for a draft's 1080p
 * final: the draft, and nothing else — its words, references, length and
 * shape are the draft's, and the server reads them from there
 * (lib/generationAdmission.ts). `maxCredits` and `quoteFingerprint` are the
 * approval of a fresh quote, as for any take.
 */
export function draftFinalBody(input: { modelId: string; draftId: string; maxCredits?: number; quoteFingerprint?: string }): Record<string, unknown> {
  return {
    model: input.modelId,
    finalOf: input.draftId,
    refine: false,
    ...(input.maxCredits === undefined ? {} : { maxCredits: input.maxCredits }),
    ...(input.quoteFingerprint ? { quoteFingerprint: input.quoteFingerprint } : {}),
  };
}

/**
 * Bound reference assets as request references. An asset already saved as an
 * upload or a generation is cited by id; a project file served from this app
 * is uploaded first (and `onAsset` records its new upload id); anything else
 * must be uploaded from the device before it can be used.
 */
export async function resolveGenerationReferences(
  refs: Asset[],
  roleFor: (asset: Asset) => string,
  options: { scope: string; onAsset: (id: string, fields: Partial<Asset>) => void },
): Promise<GenerationReference[]> {
  const references: GenerationReference[] = [];
  for (const a of refs) {
    const role = roleFor(a);
    const identity = mediaReferenceIdentity(a);
    if (identity) references.push({ ...identity, role });
    else if (a.url.startsWith("/campaign/") || a.url.startsWith("/api/workbench/media/")) {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error("Cannot load reference " + a.name);
      const blob = await res.blob();
      const uploaded = await uploadWorkbench(new File([blob], a.name, { type: a.mime || blob.type || "image/webp" }), undefined, options.scope);
      options.onAsset(a.id, { uploadId: uploaded.id });
      references.push({ uploadId: uploaded.id, role });
    } else throw new Error("Upload " + a.name + " from your device before using it as generation input.");
  }
  return references;
}
