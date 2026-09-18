import { test, expect } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { newProject } from '../lib/workbench/studio';
import { createAstraScene } from '../lib/astra-blender/scene';
import { astraSceneDigest } from '../lib/astra-blender/proposal';

function minimalGlb() {
  const json = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] });
  const padded = json.padEnd(Math.ceil(json.length / 4) * 4, ' '), data = Buffer.alloc(20 + padded.length + 12);
  data.writeUInt32LE(0x46546c67, 0); data.writeUInt32LE(2, 4); data.writeUInt32LE(data.length, 8); data.writeUInt32LE(padded.length, 12); data.writeUInt32LE(0x4e4f534a, 16); data.write(padded, 20); data.writeUInt32LE(4, 20 + padded.length); data.writeUInt32LE(0x004e4942, 24 + padded.length); return data;
}
test('real routes retain GLB originals, save scene bindings, export a native package and isolate accounts', async ({ request, playwright }) => {
  await signInLocally(request);
  const me = await request.get('/api/me').then(response => response.json());
  const headers = { 'X-Workbench-Scope': `particl-active-${me.workspace.id}-${me.id}` };
  const source = minimalGlb();
  const upload = await request.post('/api/uploads', { headers, multipart: { file: { name: 'product.glb', mimeType: 'model/gltf-binary', buffer: source } } });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const receipt = await upload.json();
  expect(receipt.mime).toBe('model/gltf-binary');
  const original = await request.get(receipt.url + '?download=1');
  expect(original.ok()).toBeTruthy(); expect(await original.body()).toEqual(source);
  const project = { ...newProject('Astra API study'), astraBlender: createAstraScene('product') };
  project.assets.push({ id: 'glb-product', uploadId: receipt.id, name: receipt.filename, kind: 'document', mime: receipt.mime, url: receipt.url, category: 'Astra blender', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] });
  project.astraBlender.objects[2] = { ...project.astraBlender.objects[2], type: 'model', assetId: 'glb-product' };
  const save = await request.put('/api/workbench/projects', { headers, data: { project, revision: 0 } });
  expect(save.ok(), await save.text()).toBeTruthy();
  const digest = await astraSceneDigest(project.astraBlender);
  const body = { projectId: project.id, sceneDigest: digest };
  const result = await request.post('/api/workbench/astra-blender/export', { headers, data: body });
  expect(result.ok(), await result.text()).toBeTruthy();
  const pack = await result.json();
  expect(pack.scene).toEqual(project.astraBlender);
  expect(pack.script).toContain('bpy.ops.wm.save_as_mainfile');
  expect(pack.files).toEqual([{ assetId: 'glb-product', filename: 'asset-1.glb', url: receipt.url + '?download=1' }]);
  expect((await request.post('/api/workbench/astra-blender/export', { headers, data: { ...body, sceneDigest: 'f'.repeat(64) } })).status()).toBe(409);
  expect((await request.post('/api/workbench/astra-blender/export', { headers: { 'X-Workbench-Scope': 'wrong-account' }, data: body })).status()).toBe(409);
  expect((await request.put('/api/workbench/projects', { headers, data: { project: { ...project, assets: [] }, revision: 1 } })).ok()).toBe(false);
  const outsider = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || 'http://localhost:4551' });
  try {
    await signInLocally(outsider);
    const other = await outsider.get('/api/me').then(response => response.json());
    expect((await outsider.post('/api/workbench/astra-blender/export', { headers: { 'X-Workbench-Scope': `particl-active-${other.workspace.id}-${other.id}` }, data: body })).status()).toBe(404);
    expect((await outsider.get(receipt.url)).status()).toBe(404);
  } finally { await outsider.dispose(); }
});


test('native Blender intake preserves originals, rejects compressed inputs, and persists bound source', async ({ request }) => {
  await signInLocally(request);
  const me = await request.get('/api/me').then(response => response.json());
  const headers = { 'X-Workbench-Scope': `particl-active-${me.workspace.id}-${me.id}` };
  const source = Buffer.concat([Buffer.from('BLENDER-v502'), Buffer.alloc(128)]);
  const upload = await request.post('/api/uploads', { headers, multipart: { file: { name: 'source.blend', mimeType: 'application/octet-stream', buffer: source } } });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const receipt = await upload.json();
  expect(receipt.mime).toBe('application/x-blender');
  expect(await request.get(receipt.url + '?download=1').then(response => response.body())).toEqual(source);
  const project = newProject('Native file intake');
  project.assets.push({ id: 'native-source', uploadId: receipt.id, name: receipt.filename, kind: 'document', mime: receipt.mime, url: receipt.url, category: 'Astra blender', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] });
  project.astraNative = { schemaVersion: 1, name: 'Native source', program: 'import bpy', assetIds: [], baseBlendAssetId: 'native-source' };
  const saved = await request.put('/api/workbench/projects', { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const read = await request.get('/api/workbench/projects?id=' + project.id, { headers });
  expect((await read.json()).project.astraNative).toEqual(project.astraNative);
  const invalid = await request.post('/api/uploads', { headers, multipart: { file: { name: 'compressed.blend', mimeType: 'application/octet-stream', buffer: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) } } });
  expect(invalid.status()).toBe(400);
});
