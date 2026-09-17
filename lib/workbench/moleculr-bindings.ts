import type { Project } from './studio';

export type MoleculrAssetDependency = { assetId: string; label: string };

/** New saved objects retain their originals even when inactive or hidden.
 * Legacy current product/cast selections stay permissive for old drafts. */
export function moleculrAssetDependencies(project: Project): MoleculrAssetDependency[] {
  const brief = project.moleculr;
  if (!brief) return [];
  return [
    ...(brief.products ?? []).flatMap(product => product.assetIds.map(assetId => ({ assetId, label: `Product profile “${product.name || product.id}”` }))),
    ...(brief.brandKit?.logoAssetId ? [{ assetId: brief.brandKit.logoAssetId, label: 'Brand logo' }] : []),
    ...(brief.poster?.layers ?? []).flatMap(layer => layer.kind === 'image' ? [{ assetId: layer.assetId, label: `Poster layer “${layer.name || layer.id}”` }] : []),
  ];
}

/** Pure draft binding validation; stored media ownership is checked by saveDraft
 * in the authenticated tenant transaction. No shared-only record is autoimported. */
export function validateMoleculrBindings(project: Project): void {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const duplicated = new Set(project.assets.filter((asset, index) => project.assets.findIndex(item => item.id === asset.id) !== index).map(asset => asset.id));
  for (const { assetId, label } of moleculrAssetDependencies(project)) {
    if (duplicated.has(assetId)) throw new Error(`${label} has an ambiguous original image (${assetId}). Resolve duplicate asset IDs before saving.`);
    if (assets.get(assetId)?.kind !== 'image') throw new Error(`${label} needs its original image (${assetId}) in this draft. Restore the image or remove its binding before saving or exporting.`);
  }
}

/** A future local remove action can explain the saved object that retains an asset. */
export function moleculrAssetBindingProblem(project: Project, assetId: string): string | null {
  const binding = moleculrAssetDependencies(project).find(item => item.assetId === assetId);
  return binding ? `${binding.label} uses this image. Remove its binding before removing the original from this draft.` : null;
}
