import { test, expect } from '@playwright/test';
import { astraNativeSchema, astraNativeDigest, validateAstraNativeBindings } from '../../lib/astra-blender/native';
import { mergeRegisteredAstraAssets } from '../../lib/astra-blender/merge-assets';
import { seedProject, type Asset } from '../../lib/workbench/studio';
import { projectSchema, saveSchema } from '../../lib/workbench/studio-schema';
import { PROJECT_LIMITS } from '../../lib/workbench/project-limits';

const source = { schemaVersion: 1 as const, name: 'Rig', program: 'import bpy\nbpy.context.scene.frame_set(12)\n', assetIds: ['texture'], baseBlendAssetId: 'rig' };
const inputs = [{ id: 'texture', name: 'Map', kind: 'image' as const, mime: 'image/png' }, { id: 'rig', name: 'Rig.blend', kind: 'document' as const, mime: 'application/x-blender' }];
test('native proposals bind original files and persist as editable project source', async () => {
  validateAstraNativeBindings(source, inputs);
  expect(() => validateAstraNativeBindings(source, inputs.slice(0, 1))).toThrow('no longer');
  expect(() => validateAstraNativeBindings({ ...source, assetIds: ['rig'] }, inputs)).not.toThrow();
  expect(() => validateAstraNativeBindings({ ...source, baseBlendAssetId: 'texture' }, inputs)).toThrow('inputs must');
  expect(astraNativeSchema.safeParse({ ...source, assetIds: ['texture', 'texture'] }).success).toBe(false);
  expect(astraNativeSchema.safeParse({ ...source, program: 'x\0y' }).success).toBe(false);
  expect(await astraNativeDigest(source)).not.toBe(await astraNativeDigest({ ...source, program: source.program + '# changed' }));
  expect(await astraNativeDigest()).toHaveLength(64);
  const project = seedProject();
  project.assets = inputs.map(asset => ({ ...asset, url: '/api/uploads/' + asset.id, category: 'Astra', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] }));
  project.astraNative = source;
  expect(projectSchema.parse(project).astraNative).toEqual(source);
  expect(saveSchema.safeParse({ project: { ...project, assets: [] }, revision: 0 }).success).toBe(false);
});
test('render output merge preserves newer local edits and deletions', () => {
  const base = seedProject(), current = structuredClone(base), remote = structuredClone(base);
  current.brief = 'New local creative direction';
  current.assets = [];
  const output: Asset = { ...base.assets[0], id: 'render-output', name: 'Native.blend', kind: 'document', mime: 'application/x-blender' };
  remote.assets.push(output);
  const merged = mergeRegisteredAstraAssets(base, current, remote);
  expect(merged.brief).toBe(current.brief);
  expect(merged.assets).toEqual([output]);
  expect(current.assets).toEqual([]);
  expect(mergeRegisteredAstraAssets(base, merged, remote).assets).toEqual([output]);
});
test('render output merge exposes concurrent changes instead of overwriting either side', () => {
  const base = seedProject(), current = structuredClone(base), remote = structuredClone(base);
  remote.brief = 'Other session edit';
  expect(() => mergeRegisteredAstraAssets(base, current, remote)).toThrow('another session');
  remote.brief = base.brief;
  remote.assets[0].name = 'Other asset edit';
  expect(() => mergeRegisteredAstraAssets(base, current, remote)).toThrow('existing asset changed');
  remote.assets = [...base.assets, { ...base.assets[0], id: 'new', name: 'Remote' }];
  current.assets.push({ ...base.assets[0], id: 'new', name: 'Local' });
  expect(() => mergeRegisteredAstraAssets(base, current, remote)).toThrow('conflicts with a local asset');
});
test('render output merge allows a feature-size project up to the project asset limit', () => {
  const base = seedProject();
  const filler = (count: number, prefix: string): Asset[] => Array.from({ length: count }, (_, i) => ({ ...base.assets[0], id: `${prefix}-${i}`, name: `${prefix} ${i}` }));
  base.assets = filler(PROJECT_LIMITS.assets - 1, 'held');
  const current = structuredClone(base), remote = structuredClone(base);
  remote.assets.push({ ...base.assets[0], id: 'render-output', name: 'Native.blend' });
  expect(mergeRegisteredAstraAssets(base, current, remote).assets).toHaveLength(PROJECT_LIMITS.assets);
  remote.assets.push({ ...base.assets[0], id: 'render-output-2', name: 'Native 2.blend' });
  expect(() => mergeRegisteredAstraAssets(base, current, remote)).toThrow('asset limit');
});
