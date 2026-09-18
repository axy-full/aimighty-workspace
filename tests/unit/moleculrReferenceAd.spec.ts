import { test, expect } from '@playwright/test';
import { strFromU8 } from 'fflate';
import { MODELS } from '../../lib/models';
import { seedProject, type Asset, type Project } from '../../lib/workbench/studio';
import { EMPTY_MOLECULR, moleculrPrompt, moleculrVideoPrompt } from '../../lib/workbench/moleculr';
import { buildMoleculrStoryboard, prepareMoleculrVariants } from '../../lib/workbench/moleculr-storyboard';
import { generationReferenceIds } from '../../lib/workbench/node-graph';
import { referenceAdBinding, referenceVideoModels } from '../../lib/workbench/reference-ad';
import { mediaQuoteReferences, mediaReferenceIdentity } from '../../lib/workbench/media-reference-input';
import { saveSchema } from '../../lib/workbench/studio-schema';
import { moleculrAssetBindingProblem } from '../../lib/workbench/moleculr-bindings';
import { buildExportPackage, collectExportAssets } from '../../lib/workbench/studio-export';
import { referencedMedia } from '../../lib/mediaBindings';

function fixture(): Project {
  const project = seedProject();
  project.nodes = [];
  const base: Asset = { ...project.assets[0], kind: 'video', mime: 'video/mp4', name: 'Ad original', refs: [], url: 'https://preview.example.test/thumbnail.webp' };
  project.assets.push({ ...base, id: 'ad-upload', uploadId: 'original-upload' }, { ...base, id: 'ad-generated', generationId: 'original-generation' });
  project.moleculr = { ...EMPTY_MOLECULR, hooks: ['Introduce the product'], productAssetIds: ['hero'], castAssetIds: ['character'],
    referenceAd: { assetId: 'ad-upload', notes: 'Two-second detail opening.', direction: 'Preserve the measured pace and use our product.' },
    creative: { kind: 'video', path: 'template', category: 'motion', templateId: 'motion-orbit', direction: '', aspect: '16:9', seconds: 15 } };
  return project;
}
const ids = () => { let id = 0; return () => `new-${++id}`; };

test('video storyboard persists one exact original alongside product/cast and survives draft serialization', () => {
  const project = fixture(), before = structuredClone(project);
  const prepared = buildMoleculrStoryboard(project, ids());
  const saved = saveSchema.parse(JSON.parse(JSON.stringify({ project: prepared, revision: 1 }))).project as Project;
  for (const variant of saved.moleculr!.variants) {
    const node = saved.nodes.find(item => item.id === variant.nodeId)!;
    expect(generationReferenceIds(node, saved)).toEqual(['hero', 'character', 'ad-upload']);
    expect(variant.referenceVideo).toEqual({ assetId: 'ad-upload', sourceKey: '{"uploadId":"original-upload"}' });
    expect(node.text).toContain('Two-second detail opening.');
    expect(node.text).toContain('SHOT');
    const selected = saved.assets.filter(asset => generationReferenceIds(node, saved).includes(asset.id));
    expect(new URLSearchParams(mediaQuoteReferences(selected)).getAll('uploadId')).toEqual(['original-upload']);
    expect(mediaReferenceIdentity(selected.find(asset => asset.kind === 'video')!)).toEqual({ uploadId: 'original-upload' });
  }
  expect(prepared.assets).toEqual(project.assets);
  expect(prepared.shots).toEqual(project.shots);
  expect(project).toEqual(before);
});

test('changing or clearing reference video creates a fresh variant and preserves existing reference history', () => {
  const project = fixture(), createId = ids();
  const first = prepareMoleculrVariants(project, 'video', createId);
  expect(() => prepareMoleculrVariants(first, 'video', createId)).toThrow('already prepared');
  const switched = { ...first, moleculr: { ...first.moleculr!, referenceAd: { ...first.moleculr!.referenceAd!, assetId: 'ad-generated' } } };
  const second = prepareMoleculrVariants(switched, 'video', createId);
  expect(second.moleculr!.variants).toHaveLength(2);
  const last = second.moleculr!.variants[1];
  expect(last.referenceVideo).toEqual({ assetId: 'ad-generated', sourceKey: '{"genId":"original-generation"}' });
  expect(generationReferenceIds(second.nodes.find(node => node.id === last.nodeId)!, second)).toEqual(['hero', 'character', 'ad-generated']);
  const cleared = prepareMoleculrVariants({ ...second, moleculr: { ...second.moleculr!, referenceAd: { notes: '', direction: '' } } }, 'video', createId);
  expect(cleared.moleculr!.variants).toHaveLength(3);
  expect(cleared.moleculr!.variants[2].referenceVideo).toBeUndefined();
  expect(collectExportAssets(cleared).map(asset => asset.id)).toEqual(expect.arrayContaining(['ad-upload', 'ad-generated']));
  expect(saveSchema.safeParse({ project: cleared, revision: 1 }).success).toBe(true);
});

test('current and historical video dependencies protect deletion and changing a bound original fails closed', async () => {
  const prepared = prepareMoleculrVariants(fixture(), 'video', ids());
  const cleared = { ...prepared, moleculr: { ...prepared.moleculr!, referenceAd: { notes: '', direction: '' } } };
  expect(moleculrAssetBindingProblem(cleared, 'ad-upload')).toContain('uses this video');
  for (const assets of [cleared.assets.filter(asset => asset.id !== 'ad-upload'), cleared.assets.map(asset => asset.id === 'ad-upload' ? { ...asset, uploadId: 'replacement-upload' } : asset)]) {
    const invalid = { ...cleared, assets };
    expect(saveSchema.safeParse({ project: invalid, revision: 1 }).success).toBe(false);
    let calls = 0;
    await expect(buildExportPackage(invalid, async () => { calls++; return new Response('unused'); })).rejects.toThrow();
    expect(calls).toBe(0);
  }
});

test('export includes exact uploaded/generated original bytes and persistent media identities', async () => {
  const prepared = prepareMoleculrVariants(fixture(), 'video', ids());
  prepared.moleculr!.referenceAd!.assetId = 'ad-generated';
  // Preview URLs may be stale or transformed; the bound immutable source wins.
  prepared.assets.find(asset => asset.id === 'ad-upload')!.url = '/api/media/stale-preview-generation';
  prepared.assets.find(asset => asset.id === 'ad-generated')!.url = '/campaign/preview-video.mp4';
  const urls: string[] = [];
  const files = await buildExportPackage(prepared, async url => {
    urls.push(url);
    return new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'Content-Type': url.startsWith('/api/') ? 'video/mp4' : 'image/webp' } });
  });
  expect(urls).toContain('/api/uploads/original-upload?download=1');
  expect(urls).toContain('/api/media/original-generation?download=1');
  expect(urls.some(url => url.includes('preview.example.test'))).toBe(false);
  expect(urls.some(url => url.includes('stale-preview') || url.includes('preview-video'))).toBe(false);
  const manifest = JSON.parse(strFromU8(files['production.json']));
  expect(manifest.project.moleculr.variants[0].referenceVideo.assetId).toBe('ad-upload');
  expect(referencedMedia(manifest.project).uploads.has('original-upload')).toBe(true);
  expect(referencedMedia(manifest.project).generations.has('original-generation')).toBe(true);
  for (const file of manifest.files.filter((file: { assetId: string }) => file.assetId.startsWith('ad-')))
    expect(files[file.file]).toEqual(new Uint8Array([0, 1, 2, 255]));
});

test('image preparation stays unchanged and maximum video direction retains shot instructions', () => {
  const project = fixture(), brief = project.moleculr!;
  const without = { ...project, moleculr: { ...brief, referenceAd: undefined } };
  const timestamp = '2026-09-18T00:00:00.000Z';
  const images = prepareMoleculrVariants(project, 'image', ids(), timestamp);
  expect({ ...images, moleculr: { ...images.moleculr!, referenceAd: undefined } }).toEqual(prepareMoleculrVariants(without, 'image', ids(), timestamp));
  expect(images.moleculr!.variants[0].referenceVideo).toBeUndefined();
  expect(generationReferenceIds(images.nodes.find(node => node.type === 'generate')!, images)).toEqual(['hero', 'character']);
  expect(moleculrPrompt(project, brief, 'Hook')).toBe(moleculrPrompt(project, { ...brief, referenceAd: undefined }, 'Hook'));
  const long = { ...project, moleculr: { ...brief, referenceAd: { ...brief.referenceAd!, notes: 'n'.repeat(2000), direction: 'd'.repeat(6000) }, notes: 'b'.repeat(6000) } };
  expect(moleculrVideoPrompt(long, long.moleculr, 'Hook').length).toBeLessThanOrEqual(12000);
  const storyboard = buildMoleculrStoryboard(long, ids());
  for (const variant of storyboard.moleculr!.variants) expect(storyboard.nodes.find(node => node.id === variant.nodeId)!.text).toContain('Target duration');
});

test('missing video aborts preparation before allocating nodes; only compatible video catalogue entries remain', () => {
  const project = fixture();
  project.moleculr!.referenceAd!.assetId = 'missing';
  let allocated = 0;
  expect(() => prepareMoleculrVariants(project, 'video', () => { allocated++; return 'unused'; })).toThrow('original video');
  expect(() => buildMoleculrStoryboard(project, () => { allocated++; return 'unused'; })).toThrow('original video');
  expect(allocated).toBe(0);
  const selected = referenceVideoModels(MODELS, ['image', 'image', 'video']);
  expect(selected.map(model => model.id)).toEqual(['dreamina-seedance-2-5-260628', 'dreamina-seedance-2-0-260128']);
  expect(referenceVideoModels(MODELS, ['image'])).toBe(MODELS);
  expect(referenceVideoModels(MODELS.filter(model => model.provider === 'fal'), ['video'])).toEqual([]);
  expect(referenceAdBinding(fixture(), { assetId: 'ad-generated', notes: '', direction: '' })).toMatchObject({ sourceKey: '{"genId":"original-generation"}' });
});
