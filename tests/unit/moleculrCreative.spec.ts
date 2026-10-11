import { test, expect } from '@playwright/test';
import { EMPTY_MOLECULR, moleculrPrompt, variantAssets } from '../../lib/workbench/moleculr';
import { CREATIVE_TEMPLATES, saveProduct, switchProduct } from '../../lib/workbench/moleculr-creative';
import { createPoster, posterDimensions, posterDocumentSchema, posterTextLines } from '../../lib/workbench/moleculr-poster';
import { newProject } from '../../lib/workbench/studio';
import { saveSchema } from '../../lib/workbench/studio-schema';
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
