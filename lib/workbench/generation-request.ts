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
  soul?: { soulIdentityId: string; soulStrength: number; workbenchProjectId: string };
  /** The shot setup picked from the camera bank (Gen's film vocabulary), kept on the take so Recreate brings it back. */
  shotSpec?: Record<string, string> | null;
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
