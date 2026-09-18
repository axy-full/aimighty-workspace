import { z } from "zod";
import type { Asset, Project } from "./studio";
import { originalAssetDownload } from "./original-asset";
import { mediaReferenceIdentity } from "./media-reference-input";
import { videoReferenceProblem } from "../generationReferences";
import type { ModelDef } from "../models";

/** A user's reference and direction, not provider analysis or permission to execute. */
export const referenceAdSchema = z.object({
  assetId: z.string().min(1).max(100).optional(),
  notes: z.string().max(2000),
  direction: z.string().max(6000),
}).strict();
export type ReferenceAdConfig = z.infer<typeof referenceAdSchema>;
export const EMPTY_REFERENCE_AD: ReferenceAdConfig = { notes: "", direction: "" };
export const referenceAdBindingSchema = z.object({ assetId: z.string().min(1).max(100), sourceKey: z.string().min(1).max(300) }).strict();
export type ReferenceAdBinding = z.infer<typeof referenceAdBindingSchema>;
export type ReferenceAdOriginal = {
  /** The exact canonical record: original upload/generation IDs and lineage stay intact. */
  asset: Asset;
  original: { url: string; filename: string };
};

/** Only existing project originals can be previewed. No remote URL is fetched or inferred. */
export function referenceAdOriginals(project: Pick<Project, "assets">): ReferenceAdOriginal[] {
  const counts = new Map<string, number>();
  for (const asset of project.assets) counts.set(asset.id, (counts.get(asset.id) ?? 0) + 1);
  return project.assets.flatMap((asset) => {
    if (asset.kind !== "video" || !asset.id || asset.id.length > 100 || counts.get(asset.id) !== 1) return [];
    const original = originalAssetDownload(asset), identity = mediaReferenceIdentity(asset);
    if (!original || !identity) return [];
    const id = "genId" in identity ? identity.genId : identity.uploadId;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return [];
    // Preview and provider admission address the same immutable source identity.
    return [{ asset, original: { ...original, url: `/api/${"genId" in identity ? "media" : "uploads"}/${id}?download=1` } }];
  });
}

export function resolveReferenceAd(
  project: Pick<Project, "assets">,
  value: Pick<ReferenceAdConfig, "assetId">,
): ReferenceAdOriginal | null {
  if (!value.assetId) return null;
  return referenceAdOriginals(project).find((item) => item.asset.id === value.assetId) ?? null;
}

/** UI cleanup preserves the authored direction while dropping unavailable selection. */
export function normalizeReferenceAd(project: Pick<Project, "assets">, value: ReferenceAdConfig): ReferenceAdConfig {
  const parsed = referenceAdSchema.parse(value);
  if (!parsed.assetId || resolveReferenceAd(project, parsed)) return parsed;
  return { notes: parsed.notes, direction: parsed.direction };
}

/** No array or URL input can select extra or foreign project records. */
export function selectReferenceAd(
  project: Pick<Project, "assets">,
  value: ReferenceAdConfig,
  assetId: string | undefined,
): ReferenceAdConfig {
  return normalizeReferenceAd(project, { ...value, assetId: assetId || undefined });
}

/** Save/export callers should reject missing originals instead of silently rewriting saved data. */
export function validateReferenceAd(project: Pick<Project, "assets">, value: ReferenceAdConfig): void {
  const parsed = referenceAdSchema.parse(value);
  if (parsed.assetId && !resolveReferenceAd(project, parsed))
    throw new Error("The reference ad needs its original video in this project. Restore it or clear the reference selection.");
}

/** Later save/export integration can retain the canonical asset and its original lineage. */
export function referenceAdAssetIds(value: ReferenceAdConfig): string[] {
  const parsed = referenceAdSchema.parse(value);
  return parsed.assetId ? [parsed.assetId] : [];
}

/** Capture source identity separately from the mutable current selection. */
export function referenceAdBinding(project: Pick<Project, "assets">, value?: ReferenceAdConfig): ReferenceAdBinding | undefined {
  if (!value?.assetId) return undefined;
  validateReferenceAd(project, value);
  const selected = resolveReferenceAd(project, value)!;
  return { assetId: selected.asset.id, sourceKey: JSON.stringify(mediaReferenceIdentity(selected.asset)) };
}

export function validateReferenceAdBinding(project: Pick<Project, "assets">, binding: ReferenceAdBinding): void {
  referenceAdBindingSchema.parse(binding);
  const current = referenceAdBinding(project, { ...EMPTY_REFERENCE_AD, assetId: binding.assetId });
  if (current?.sourceKey !== binding.sourceKey) throw new Error("A prepared reference ad original changed. Restore its original source or remove the affected campaign variant before saving.");
}

export function referenceAdDirection(project: Pick<Project, "assets">, value?: ReferenceAdConfig): string {
  if (!value?.assetId) return "";
  validateReferenceAd(project, value);
  return [
    "Use the attached original reference video as creative guidance for pacing, framing and movement. Adapt the direction to this campaign's product and brand; do not copy another brand's claims, logos or endorsements.",
    value.notes.trim() && `User-reviewed reference observations: ${value.notes.trim().slice(0, 2000)}`,
    value.direction.trim() && `Reference adaptation direction: ${value.direction.trim().slice(0, 6000)}`,
  ].filter(Boolean).join("\n\n");
}

/** Catalogue entries are already workspace-configured; preserve image-only behavior. */
export function referenceVideoModels<T extends Pick<ModelDef, 'kind' | 'label' | 'family' | 'maxReferenceImages' | 'maxReferenceVideos'>>(models: T[], kinds: string[]): T[] {
  if (!kinds.includes('video')) return models;
  return models.filter(model => model.kind === 'video' && !videoReferenceProblem(model, kinds.map(kind => ({ kind, role: kind === 'video' ? 'reference_video' : 'reference_image' }))));
}
