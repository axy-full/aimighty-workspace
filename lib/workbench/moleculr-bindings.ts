import type { Project } from './studio';
import { validateReferenceAd, validateReferenceAdBinding } from './reference-ad';

export type MoleculrAssetDependency = { assetId: string; label: string; kind?: 'image' | 'video' };

/** New saved objects retain their originals even when inactive or hidden.
 * Legacy current product/cast selections stay permissive for old drafts. */
export function moleculrAssetDependencies(project: Project): MoleculrAssetDependency[] {
  const brief = project.moleculr;
  if (!brief) return [];
  return [
    ...(brief.products ?? []).flatMap(product => product.assetIds.map(assetId => ({ assetId, label: `Product profile “${product.name || product.id}”` }))),
    ...(brief.brandKit?.logoAssetId ? [{ assetId: brief.brandKit.logoAssetId, label: 'Brand logo' }] : []),
    ...(brief.poster?.layers ?? []).flatMap(layer => layer.kind === 'image' ? [{ assetId: layer.assetId, label: `Poster layer “${layer.name || layer.id}”` }] : []),
    ...(brief.referenceAd?.assetId ? [{ assetId: brief.referenceAd.assetId, label: 'Reference ad', kind: 'video' as const }] : []),
    ...brief.variants.flatMap(variant => variant.referenceVideo ? [{ assetId: variant.referenceVideo.assetId, label: `Campaign reference ad “${variant.hook}”`, kind: 'video' as const }] : []),
  ];
}

/** Pure draft binding validation; stored media ownership is checked by saveDraft
 * in the authenticated tenant transaction. No shared-only record is autoimported. */
export function validateMoleculrBindings(project: Project): void {
  if (project.moleculr?.referenceAd) validateReferenceAd(project, project.moleculr.referenceAd);
  for (const variant of project.moleculr?.variants ?? []) if (variant.referenceVideo) {
    if (variant.kind !== 'video') throw new Error('A reference ad can only bind a video campaign variant.');
    validateReferenceAdBinding(project, variant.referenceVideo);
  }
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const duplicated = new Set(project.assets.filter((asset, index) => project.assets.findIndex(item => item.id === asset.id) !== index).map(asset => asset.id));
  for (const { assetId, label, kind = 'image' } of moleculrAssetDependencies(project)) {
    if (duplicated.has(assetId)) throw new Error(`${label} has an ambiguous original ${kind} (${assetId}). Resolve duplicate asset IDs before saving.`);
    if (assets.get(assetId)?.kind !== kind) throw new Error(`${label} needs its original ${kind} (${assetId}) in this draft. Restore the original or remove its binding before saving or exporting.`);
  }
}

/** A future local remove action can explain the saved object that retains an asset. */
export function moleculrAssetBindingProblem(project: Project, assetId: string): string | null {
  const binding = moleculrAssetDependencies(project).find(item => item.assetId === assetId);
  return binding ? `${binding.label} uses this ${binding.kind ?? 'image'}. Remove its binding before removing the original from this draft.` : null;
}
