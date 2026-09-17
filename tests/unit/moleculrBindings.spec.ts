import { expect, test } from '@playwright/test';
import { strFromU8 } from 'fflate';
import { seedProject } from '../../lib/workbench/studio';
import { EMPTY_MOLECULR } from '../../lib/workbench/moleculr';
import { EMPTY_BRAND_KIT } from '../../lib/workbench/moleculr-creative';
import { createPoster, type PosterLayer } from '../../lib/workbench/moleculr-poster';
import { moleculrAssetBindingProblem, moleculrAssetDependencies, validateMoleculrBindings } from '../../lib/workbench/moleculr-bindings';
import { buildExportPackage, collectExportAssets } from '../../lib/workbench/studio-export';
import { referencedMedia } from '../../lib/mediaBindings';
import { saveSchema } from '../../lib/workbench/studio-schema';

function fixture() {
  const project = seedProject();
  for (const id of ['product', 'inactive-product', 'logo', 'poster-image', 'hidden-image', 'product-original']) {
    project.assets.push({ ...project.assets[1], id, name: id, url: `/api/uploads/${id}`, uploadId: id, refs: [] });
  }
  project.assets.find(asset => asset.id === 'product')!.parentId = 'product-original';
  let serial = 0;
  const poster = createPoster('Campaign', () => `layer-${++serial}`);
  const image = (assetId: string, visible: boolean): PosterLayer => ({ id: `layer-${assetId}`, name: assetId, kind: 'image', assetId, visible, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'contain' });
  poster.layers.push(image('poster-image', true), image('hidden-image', false));
  project.moleculr = { ...EMPTY_MOLECULR, activeProductId: 'active', productAssetIds: ['product'], products: [
    { id: 'active', name: 'Active', url: '', description: '', brand: '', assetIds: ['product'] },
    { id: 'inactive', name: 'Inactive', url: '', description: '', brand: '', assetIds: ['inactive-product', 'product'] },
  ], brandKit: { ...EMPTY_BRAND_KIT, logoAssetId: 'logo' }, poster };
  return project;
}

test('saved profiles, brand logo and hidden poster layers all retain canonical originals', () => {
  const project = fixture();
  expect(() => validateMoleculrBindings(project)).not.toThrow();
  expect(moleculrAssetDependencies(project).map(item => item.assetId)).toEqual(['product', 'inactive-product', 'product', 'logo', 'poster-image', 'hidden-image']);
  expect(moleculrAssetBindingProblem(project, 'inactive-product')).toContain('Inactive');
  expect(moleculrAssetBindingProblem(project, 'hidden-image')).toContain('Poster layer');
  expect(moleculrAssetBindingProblem(project, 'logo')).toContain('Brand logo');
  expect(moleculrAssetBindingProblem(project, 'character')).toBeNull();
});

test('missing, non-image, shared-only and ambiguous new bindings fail closed without changing the project', () => {
  for (const id of ['product', 'inactive-product', 'logo', 'poster-image', 'hidden-image']) {
    const project = fixture();
    const before = JSON.stringify(project);
    const original = project.assets.find(asset => asset.id === id)!;
    expect(() => validateMoleculrBindings({ ...project, assets: project.assets.filter(asset => asset.id !== id) })).toThrow('original image');
    expect(() => validateMoleculrBindings({ ...project, assets: project.assets.map(asset => asset.id === id ? { ...asset, kind: 'video' } : asset) })).toThrow('original image');
    expect(() => validateMoleculrBindings({ ...project, assets: project.assets.filter(asset => asset.id !== id), sharedAssets: [...project.sharedAssets!, original], sharedAssetIds: [...project.sharedAssetIds, id] })).toThrow('original image');
    expect(() => validateMoleculrBindings({ ...project, assets: [...project.assets, { ...original }] })).toThrow('ambiguous');
    expect(JSON.stringify(project)).toBe(before);
  }
});

test('old projects and permissive legacy current selection IDs remain compatible', () => {
  const project = seedProject();
  expect(() => validateMoleculrBindings(project)).not.toThrow();
  project.moleculr = { ...EMPTY_MOLECULR, productAssetIds: ['missing-old-product'], castAssetIds: ['missing-old-cast'],
    productSource: { url: 'https://example.test/product', reviewedAt: '2026-09-17T00:00:00.000Z' } };
  expect(() => validateMoleculrBindings(project)).not.toThrow();
  expect(moleculrAssetDependencies(project)).toEqual([]);
  expect(collectExportAssets(project)).toHaveLength(3);
  expect(saveSchema.safeParse({ project, revision: 0 }).success).toBe(true);
});

test('the public draft save contract rejects removing a retained original until its new binding is removed', () => {
  const project = fixture();
  expect(saveSchema.safeParse({ project, revision: 1 }).success).toBe(true);
  const withoutLogo = { ...project, assets: project.assets.filter(asset => asset.id !== 'logo') };
  const rejected = saveSchema.safeParse({ project: withoutLogo, revision: 1 });
  expect(rejected.success).toBe(false);
  if (!rejected.success) expect(rejected.error.issues).toContainEqual(expect.objectContaining({ path: ['project', 'moleculr'] }));
  expect(saveSchema.safeParse({ project: { ...withoutLogo, moleculr: { ...project.moleculr!, brandKit: { ...project.moleculr!.brandKit!, logoAssetId: undefined } } }, revision: 1 }).success).toBe(true);
});

test('delivery collects inactive profile and hidden design images once, together with original lineage', async () => {
  const project = fixture();
  const sources = collectExportAssets(project).map(asset => asset.id);
  expect(sources).toEqual(['environment', 'hero', 'character', 'product', 'product-original', 'inactive-product', 'logo', 'poster-image', 'hidden-image']);
  project.assets.find(asset => asset.id === 'product')!.url = 'https://preview.example.test/thumbnail.png';
  project.assets.find(asset => asset.id === 'poster-image')!.uploadId = undefined;
  project.assets.find(asset => asset.id === 'poster-image')!.generationId = 'poster-generation';
  project.assets.find(asset => asset.id === 'poster-image')!.url = 'https://preview.example.test/poster.png';
  const urls: string[] = [];
  const files = await buildExportPackage(project, async url => {
    urls.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  });
  expect(urls).toContain('/api/uploads/product?download=1');
  expect(urls).toContain('/api/media/poster-generation?download=1');
  expect(urls.some(url => url.includes('preview.example.test'))).toBe(false);
  expect(urls).toHaveLength(sources.length);
  const manifest = JSON.parse(strFromU8(files['production.json']));
  expect(manifest.files.map((item: { assetId: string }) => item.assetId)).toEqual(sources);
  expect(manifest.project.moleculr).toEqual(project.moleculr);
  for (const entry of manifest.files) expect(files[entry.file]).toEqual(new Uint8Array([1, 2, 3]));
  expect(referencedMedia(manifest.project).uploads).toContain('product');
  expect(referencedMedia(manifest.project).generations).toContain('poster-generation');
});

test('missing profile or hidden poster originals abort delivery before downloading any bytes', async () => {
  for (const id of ['inactive-product', 'hidden-image']) {
    const project = fixture();
    project.assets = project.assets.filter(asset => asset.id !== id);
    let calls = 0;
    await expect(buildExportPackage(project, async () => { calls++; return new Response('unused'); })).rejects.toThrow('original image');
    expect(calls).toBe(0);
  }
});
