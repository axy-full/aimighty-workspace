import { test, expect } from '@playwright/test';
import { EMPTY_MOLECULR, moleculrPrompt, variantAssets } from '../../lib/workbench/moleculr';
import { CREATIVE_TEMPLATES, saveProduct, switchProduct } from '../../lib/workbench/moleculr-creative';
import { createPoster, posterDimensions, posterDocumentSchema, posterTextLines } from '../../lib/workbench/moleculr-poster';
import { buildMoleculrStoryboard, prepareMoleculrVariants } from '../../lib/workbench/moleculr-storyboard';
import { newProject, seedProject } from '../../lib/workbench/studio';
import { saveSchema } from '../../lib/workbench/studio-schema';
import { generationReferenceIds } from '../../lib/workbench/node-graph';
import { recoverMediaAssets } from '../../lib/workbench/job-recovery';

test('switching products snapshots edits and restores each original image selection', () => {
  const first = saveProduct({ ...EMPTY_MOLECULR, productName: 'First', productAssetIds: ['one'], productDescription: 'First facts' }, 'first');
  const second = saveProduct({ ...first, productName: 'Second', productAssetIds: ['two'], productDescription: 'Second facts' }, 'second');
  const edited = { ...second, productName: 'Second revised' };
  const restored = switchProduct(edited, 'first');
  expect(restored.productName).toBe('First'); expect(restored.productAssetIds).toEqual(['one']);
  expect(switchProduct(restored, 'second').productName).toBe('Second revised');
  expect(second.products?.[1].name).toBe('Second');
  expect(() => switchProduct(restored, 'missing')).toThrow('no longer available');
});
test('bounded saved product library replaces an existing profile without erasing other profiles', () => {
  let brief = { ...EMPTY_MOLECULR };
  for (let index = 0; index < 24; index++) brief = saveProduct({ ...brief, productName: `Item ${index}` }, `product-${index}`);
  expect(() => saveProduct(brief, 'overflow')).toThrow('24');
  expect(saveProduct({ ...brief, productName: 'Revised' }, 'product-0').products?.[0].name).toBe('Revised');
});
test('campaign prompt carries reviewed facts, brand direction and selected native brief while keeping claims bounded', () => {
  const project = newProject('Brand campaign');
  const brief = { ...EMPTY_MOLECULR, productName: 'Object', productDescription: 'Made of glass', productBrand: 'Example', brandKit: { name: 'Example', tagline: 'The small details', voice: 'Precise', audience: 'Designers', colors: ['#334455'], font: 'editorial' as const }, creative: { path: 'template' as const, category: 'product-shots' as const, templateId: 'studio-seamless', direction: 'Soft shadow', aspect: '1:1' as const, seconds: 15 } };
  const prompt = moleculrPrompt(project, brief, 'A quiet object');
  expect(prompt).toContain('Made of glass'); expect(prompt).toContain('Studio essential'); expect(prompt).toContain('#334455'); expect(prompt).toContain('Do not invent product claims');
  const saved = saveSchema.parse({ project: { ...project, moleculr: brief }, revision: 1 });
  expect(saved.project.moleculr?.creative?.templateId).toBe('studio-seamless');
});
test('storyboard creates independently reviewable shots with persistent original references and no fake takes', () => {
  const project = seedProject(); project.nodes = []; project.shots = [];
  project.moleculr = { ...EMPTY_MOLECULR, productAssetIds: ['hero'], castAssetIds: ['character'], creative: { path: 'template', category: 'ugc', templateId: 'ugc-presenter', direction: '', aspect: '9:16', seconds: 15 } };
  let sequence = 0;
  const next = buildMoleculrStoryboard(project, () => `new-${++sequence}`, '2026-09-18T00:00:00.000Z');
  expect(next.moleculr?.variants).toHaveLength(3); expect(next.assets).toEqual(project.assets);
  expect(next.shots).toHaveLength(0); expect(project.nodes).toHaveLength(0);
  for (const variant of next.moleculr!.variants) {
    const node = next.nodes.find(item => item.id === variant.nodeId)!;
    expect(node.text).toContain('SHOT'); expect(node.mode).toBe('Video'); expect(generationReferenceIds(node, next)).toEqual(['hero','character']);
    expect(variant.generation?.ratio).toBe('9:16');
  }
  expect(next.moleculr!.variants.map(variant => variant.generation?.duration)).toEqual([4,7,4]);
  expect(variantAssets(next, next.moleculr!)).toEqual([]);
});
test('bulk creative preparation creates hook and cast combinations with exact preset role order and separate reviewed settings', () => {
  const project = seedProject(); project.nodes = [];
  project.moleculr = { ...EMPTY_MOLECULR, hooks: ['Hook A','Hook B'], productAssetIds: ['hero','environment'], castAssetIds: ['character'], marketing: { enhancePrompt: true, quality: 'high', presetId: '123e4567-e89b-42d3-a456-426614174000' } };
  let id = 0; const next = prepareMoleculrVariants(project, 'image', () => `batch-${++id}`);
  expect(next.moleculr!.variants).toHaveLength(2);
  for (const variant of next.moleculr!.variants) {
    const node = next.nodes.find(item => item.id === variant.nodeId)!;
    expect(generationReferenceIds(node, next)).toEqual(['hero','character']);
    expect(variant.generation?.marketing).toEqual({ quality: 'high', enhancePrompt: true, presetId: project.moleculr.marketing!.presetId });
  }
  expect(() => prepareMoleculrVariants(next, 'image', () => `batch-${++id}`)).toThrow('already prepared');
  expect(project.nodes).toHaveLength(0); expect(next.assets).toEqual(project.assets);
});
test('bulk bounds and missing cast fail atomically, and product-only batches do not add a person', () => {
  const project = seedProject(); project.nodes = [];
  project.moleculr = { ...EMPTY_MOLECULR, hooks: ['Hook'], productAssetIds: ['hero'], castAssetIds: [] };
  let id = 0; const next = prepareMoleculrVariants(project, 'video', () => `batch-${++id}`);
  expect(generationReferenceIds(next.nodes.find(node => node.type === 'generate')!, next)).toEqual(['hero']);
  expect(next.moleculr!.variants[0].castAssetId).toBeUndefined();
  project.moleculr.castAssetIds = ['deleted'];
  expect(() => prepareMoleculrVariants(project, 'video', () => `batch-${++id}`)).toThrow('missing');
  project.moleculr.hooks = Array.from({ length: 12 }, (_, i) => `Hook ${i}`); project.moleculr.castAssetIds = ['character','hero','environment'];
  expect(() => prepareMoleculrVariants(project, 'video', () => `batch-${++id}`)).toThrow('24');
  expect(project.nodes).toHaveLength(0);
});
test('invalid references, duplicate identities and capacity stop storyboard preparation atomically', () => {
  const project = newProject('Limits'); project.moleculr = { ...EMPTY_MOLECULR, creative: { path: 'template', category: 'motion', templateId: 'motion-orbit', direction: '', aspect: '16:9', seconds: 15 } };
  expect(() => buildMoleculrStoryboard(project, () => 'duplicate')).toThrow('unique');
  project.moleculr.productAssetIds = ['missing']; expect(() => buildMoleculrStoryboard(project, () => 'unused')).toThrow('missing');
  project.moleculr.productAssetIds = []; project.moleculr.variants = Array.from({ length: 99 }, (_, index) => ({ id: `v-${index}`, nodeId: `n-${index}`, hook: '' }));
  expect(() => buildMoleculrStoryboard(project, () => 'unused')).toThrow('100-variant');
  expect(project.nodes).toEqual([]);
});
test('poster dimensions preserve requested aspect and layers reject unsafe sizes and arbitrary payloads', () => {
  let index = 0; const poster = createPoster('Launch', () => `layer-${++index}`);
  expect(posterDimensions('9:16', 3840)).toEqual({ width: 2160, height: 3840 });
  expect(posterDimensions('4:5', 2160)).toEqual({ width: 1728, height: 2160 });
  expect(() => posterDimensions('1:1', 9000)).toThrow();
  expect(posterDocumentSchema.safeParse({ ...poster, layers: [poster.layers[0], poster.layers[0]] }).success).toBe(false);
  expect(posterDocumentSchema.safeParse({ ...poster, background: 'url(https://example.test)' }).success).toBe(false);
  expect(posterDocumentSchema.safeParse({ ...poster, layers: [{ ...poster.layers[0], html: '<script/>' }] }).success).toBe(false);
  expect(posterTextLines('hello world\nunbrokenword', 5, value => value.length)).toEqual(['hello','world','unbro','kenwo','rd']);
});
test('all creative briefs are original directions; video beats have complete bounded instructions', () => {
  for (const template of CREATIVE_TEMPLATES) {
    expect(template.direction.length).toBeGreaterThan(50);
    if (template.kind === 'video') expect(template.beats.reduce((sum, beat) => sum + beat.seconds, 0)).toBe(15);
  }
});
test('completed presenter generations become reusable cast images and poster outputs join campaign takes', () => {
  const project = newProject('Cast'); project.nodes = [{ id: 'avatar', type: 'character', title: 'Presenter', mode: 'Image', x: 0, y: 0, width: 300, linked: [] }]; project.shotMappings = { avatar: 'shot-avatar' };
  const next = recoverMediaAssets(project, [{ id: 'gen', status: 'succeeded', kind: 'image', shotId: 'shot-avatar', prompt: 'Original adult presenter', model: 'test' }]);
  expect(next.assets[0].category).toBe('Character');
  next.assets.push({ ...next.assets[0], id: 'design', nodeId: undefined, generationId: undefined, category: 'Campaign design' });
  expect(variantAssets(next, EMPTY_MOLECULR).map(asset => asset.id)).toEqual(['design']);
});
