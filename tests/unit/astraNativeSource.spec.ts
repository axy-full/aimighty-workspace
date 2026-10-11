import { test, expect } from '@playwright/test';
import { astraNativeSchema, astraNativeDigest, validateAstraNativeBindings } from '../../lib/astra-blender/native';
import { seedProject } from '../../lib/workbench/studio';
import { projectSchema, saveSchema } from '../../lib/workbench/studio-schema';

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
