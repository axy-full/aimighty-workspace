import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signInLocally } from './helpers/workbenchLocal';
import { newProject, type Project } from '../lib/workbench/studio';
import { projectSchema } from '../lib/workbench/studio-schema';
import { createAstraScene } from '../lib/astra-blender/scene';

function triangleGlb(external = false) {
  const binary = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const description = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: binary.length, ...(external ? { uri: 'https://untrusted.example/geometry.bin' } : {}) }], bufferViews: [{ buffer: 0, byteLength: binary.length, byteOffset: 0 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  const json = Buffer.from(JSON.stringify(description).padEnd(Math.ceil(JSON.stringify(description).length / 4) * 4, ' '));
  const output = Buffer.alloc(28 + json.length + binary.length);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20);
  output.writeUInt32LE(binary.length, 20 + json.length); output.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(output, 28 + json.length);
  return output;
}

async function fixture(page: Page, withAssets = false) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then((response) => response.json());
  let project: Project = {
    ...newProject('Astra browser study'),
    id: 'astra-browser-study',
    productionProjectId: 'astra-production',
    shotMappings: {},
    astraBlender: createAstraScene('product'),
    assets: withAssets ? [
      { id: 'triangle', name: 'Triangle model', kind: 'document', mime: 'model/gltf-binary', uploadId: 'astra-model', url: '/api/uploads/astra-model', category: 'Astra blender', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] },
      { id: 'unsafe', name: 'External model', kind: 'document', mime: 'model/gltf-binary', uploadId: 'astra-unsafe', url: '/api/uploads/astra-unsafe', category: 'Astra blender', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] },
      { id: 'image', name: 'Image plane', kind: 'image', mime: 'image/png', uploadId: 'astra-image', url: '/api/uploads/astra-image', category: 'Astra blender', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] },
    ] : [],
  };
  let revision = 1;
  const paidRequests: string[] = [];
  const assetReads: string[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/uploads/astra-')) {
      assetReads.push(path);
      return route.fulfill(path.endsWith('image') ? { contentType: 'image/png', body: await readFile('public/fixtures/still.png') } : { contentType: 'model/gltf-binary', body: triangleGlb(path.endsWith('unsafe')) });
    }
    if (path === '/api/me') return route.fulfill({ json: me });
    if (path === '/api/workbench/projects') {
      if (request.method() === 'PUT') {
        const data = request.postDataJSON();
        project = projectSchema.parse(data.project) as Project;
        revision = data.revision + 1;
        return route.fulfill({ json: { revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings } });
      }
      return route.fulfill({ json: { project, revision, projects: [{ id: project.id, name: project.name }], productions: [] } });
    }
    if (path === '/api/workbench/atomik' && request.method() === 'GET') return route.fulfill({ json: { models: [{ id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })) }], jobs: [] } });
    if (path === '/api/workbench/development') return route.fulfill({ json: { models: [], jobs: [] } });
    if (path === '/api/jobs') return route.fulfill({ json: { generations: [], nextCursor: null } });
    if (path === '/api/engines' || path === '/api/workbench/engines') return route.fulfill({ json: { models: [], vendors: [] } });
    if (request.method() === 'POST') {
      paidRequests.push(path);
      return route.fulfill({ status: 409, json: { error: 'Unexpected paid request in scene editing fixture.' } });
    }
    return route.fulfill({ json: { jobs: [] } });
  });
  await page.goto('/workbench?project=astra-browser-study&stage=astra-blender');
  const workspace = page.getByRole('region', { name: 'Astra blender', exact: true });
  await expect(workspace).toBeVisible();
  return { workspace, paidRequests, assetReads, get project() { return project; } };
}

async function openPanel(workspace: Locator, label: 'Scene' | 'Objects' | 'Properties' | 'Output' | 'Astra') {
  const mobile = workspace.getByRole('navigation', { name: '3D workspace panels' });
  if (await mobile.isVisible()) await mobile.getByRole('button', { name: label, exact: true }).click();
  else if (['Properties', 'Output', 'Astra'].includes(label)) await workspace.getByRole('navigation', { name: 'Inspector panels' }).getByRole('button', { name: label, exact: true }).click();
}

async function setNumber(workspace: Locator, label: string, value: string) {
  const input = workspace.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
}

async function observeViewportDraws(page: Page, renderDelayMs = 0) {
  await page.addInitScript((delay) => {
    const metrics = { calls: 0, delayedFrames: 0 };
    Object.defineProperty(window, '__astraDraws', { value: metrics });
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (typeof descriptor?.value !== 'function') continue;
        const original = descriptor.value;
        Object.defineProperty(prototype, name, { ...descriptor, value: function (this: WebGLRenderingContext, ...args: unknown[]) {
          if (this.canvas instanceof HTMLCanvasElement && this.canvas.getAttribute('aria-label') === 'Interactive 3D viewport') metrics.calls++;
          return Reflect.apply(original, this, args);
        } });
      }
      const clear = Object.getOwnPropertyDescriptor(prototype, 'clear');
      if (delay && typeof clear?.value === 'function') {
        const original = clear.value;
        Object.defineProperty(prototype, 'clear', { ...clear, value: function (this: WebGLRenderingContext, ...args: unknown[]) {
          // Simulate a slow GPU once per visible frame, not per shadow pass.
          if (this.canvas instanceof HTMLCanvasElement && this.canvas.getAttribute('aria-label') === 'Interactive 3D viewport' && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
            metrics.delayedFrames++;
            const until = performance.now() + delay;
            while (performance.now() < until) { /* deterministic slow-render fixture */ }
          }
          return Reflect.apply(original, this, args);
        } });
      }
    }
  }, renderDelayMs);
  const count = () => page.evaluate(() => (window as unknown as { __astraDraws: { calls: number } }).__astraDraws.calls);
  const idle = async () => {
    await expect.poll(() => page.evaluate(async () => {
      const metrics = (window as unknown as { __astraDraws: { calls: number } }).__astraDraws;
      const before = metrics.calls;
      await new Promise(resolve => setTimeout(resolve, 500));
      return metrics.calls - before;
    }), { message: 'An unchanged viewport must issue no WebGL draw calls' }).toBe(0);
    return count();
  };
  return { count, idle };
}

async function dragViewport(page: Page, canvas: Locator, draws: Awaited<ReturnType<typeof observeViewportDraws>>) {
  // In short landscape layouts the canvas extends below the fixed stage dock.
  // Scroll it into view, then use a drag path that actually hits the canvas.
  await canvas.hover();
  const drag = await canvas.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const left = Math.max(bounds.left, 0), right = Math.min(bounds.right, innerWidth);
    const top = Math.max(bounds.top, 0), bottom = Math.min(bounds.bottom, innerHeight);
    const dx = Math.min(30, (right - left) / 10), dy = Math.min(20, (bottom - top) / 10);
    for (const fraction of [.3, .5, .7]) {
      const x = left + (right - left) * .3, y = top + (bottom - top) * fraction;
      if ([0, .5, 1].every(t => document.elementFromPoint(x + dx * t, y + dy * t) === node)) return { x, y, dx, dy };
    }
    return null;
  });
  expect(drag, 'The viewport must have an unobstructed visible orbit-drag path').not.toBeNull();
  await page.mouse.move(drag!.x, drag!.y);
  const before = await draws.idle();
  await page.mouse.down();
  await page.mouse.move(drag!.x + drag!.dx, drag!.y + drag!.dy, { steps: 3 });
  await page.mouse.up();
  await expect.poll(draws.count).toBeGreaterThan(before);
}

test('viewport draws only for changes, finishes orbit damping and restores overlays after PNG capture', async ({ page }) => {
  const draws = await observeViewportDraws(page);
  const { workspace } = await fixture(page);
  const canvas = workspace.getByRole('img', { name: 'Interactive 3D viewport' });
  await expect(canvas).toBeVisible();
  await expect.poll(draws.count).toBeGreaterThan(0);
  let before = await draws.idle();
  await workspace.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await expect.poll(draws.count).toBeGreaterThan(before);
  await dragViewport(page, canvas, draws);
  await draws.idle();
  await workspace.getByRole('button', { name: 'Play animation', exact: true }).click();
  before = await draws.count();
  await expect.poll(draws.count).toBeGreaterThan(before);
  await workspace.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await draws.idle();
  await workspace.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await draws.idle();
  const shown = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL());
  await openPanel(workspace, 'Output');
  const downloaded = page.waitForEvent('download');
  await workspace.getByRole('button', { name: 'Save viewport PNG', exact: true }).click();
  await downloaded;
  await openPanel(workspace, 'Scene');
  await draws.idle();
  expect(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL()) === shown, 'PNG capture must restore the visible grid and selection overlays').toBe(true);
  // A hidden document cancels pending drawing but retains changes to render
  // once it becomes visible again. Exercise the browser event deterministically.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  before = await draws.idle();
  await workspace.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  expect(await draws.idle()).toBe(before);
  await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(draws.count).toBeGreaterThan(before);
  await draws.idle();
  await page.getByRole('navigation', { name: 'Particl Production Studio pages', exact: true }).getByRole('link', { name: 'Brief & Script', exact: true }).click();
  await expect(canvas).toHaveCount(0);
  await draws.idle();
});

test('orbit damping settles promptly when each viewport frame takes 180 milliseconds', async ({ page }) => {
  const draws = await observeViewportDraws(page, 180);
  const { workspace } = await fixture(page);
  const canvas = workspace.getByRole('img', { name: 'Interactive 3D viewport' });
  await expect(canvas).toBeVisible();
  await expect.poll(draws.count).toBeGreaterThan(0);
  await dragViewport(page, canvas, draws);
  const started = Date.now();
  await draws.idle();
  expect(Date.now() - started, 'Slow rendering must not extend the orbit tail into a long frame-count loop').toBeLessThan(6000);
  expect(await page.evaluate(() => (window as unknown as { __astraDraws: { delayedFrames: number } }).__astraDraws.delayedFrames)).toBeGreaterThan(3);
});

test('editable 3D scene persists transforms, material, keyframes, locks and scene export without paid calls', async ({ page }, info) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const state = await fixture(page);
  const workspace = state.workspace;
  await expect(workspace.getByRole('img', { name: 'Interactive 3D viewport' })).toBeVisible();
  await openPanel(workspace, 'Objects');
  await workspace.getByLabel('Add object', { exact: true }).selectOption('box');
  await openPanel(workspace, 'Properties');
  await workspace.getByLabel('Name', { exact: true }).fill('Hero cube');
  await workspace.getByLabel('Name', { exact: true }).press('Tab');
  await setNumber(workspace, 'Position X', '1.25');
  await setNumber(workspace, 'Roughness', '0.65');
  await openPanel(workspace, 'Scene');
  await workspace.getByRole('button', { name: 'Add keyframe', exact: true }).click();
  await workspace.getByLabel('Current frame', { exact: true }).fill('60');
  await openPanel(workspace, 'Properties');
  await setNumber(workspace, 'Position X', '3.25');
  await expect(workspace.getByRole('button', { name: 'Frame 60', exact: true })).toBeVisible();
  await openPanel(workspace, 'Scene');
  await workspace.getByRole('button', { name: 'Go to keyframe 1', exact: true }).click();
  await openPanel(workspace, 'Properties');
  await expect(workspace.getByLabel('Position X', { exact: true })).toHaveValue('1.25');
  await workspace.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(workspace.getByLabel('Name', { exact: true })).toHaveValue('Hero cube copy');
  await workspace.getByRole('button', { name: 'Delete', exact: true }).click();
  await openPanel(workspace, 'Objects');
  await expect(workspace.getByRole('button', { name: 'Hero cube copy', exact: true })).toHaveCount(0);
  await workspace.getByRole('button', { name: 'Undo scene change', exact: true }).click();
  await expect(workspace.getByRole('button', { name: 'Hero cube copy', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Redo scene change', exact: true }).click();
  await expect(workspace.getByRole('button', { name: 'Hero cube copy', exact: true })).toHaveCount(0);
  await workspace.getByRole('button', { name: 'Hero cube', exact: true }).click();
  await workspace.getByRole('button', { name: 'Lock Hero cube', exact: true }).click();
  await openPanel(workspace, 'Properties');
  await expect(workspace.getByLabel('Position X', { exact: true })).toBeDisabled();
  await openPanel(workspace, 'Objects');
  await workspace.getByRole('button', { name: 'Unlock Hero cube', exact: true }).click();
  await workspace.getByRole('button', { name: 'Hide Hero cube', exact: true }).click();
  await expect.poll(() => state.project.astraBlender?.objects.find((object) => object.name === 'Hero cube')?.visible).toBe(false);
  await workspace.getByRole('button', { name: 'Show Hero cube', exact: true }).click();
  await openPanel(workspace, 'Output');
  const downloaded = page.waitForEvent('download');
  await workspace.getByRole('button', { name: 'Download scene JSON' }).click();
  const download = await downloaded;
  const downloadedScene = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(downloadedScene.objects.find((object: { name: string }) => object.name === 'Hero cube')).toMatchObject({ material: { roughness: .65 }, keyframes: [{ frame: 1, position: [1.25, 0, .5] }, { frame: 60, position: [3.25, 0, .5] }] });
  await expect.poll(() => state.project.astraBlender?.objects.find((object) => object.name === 'Hero cube')?.visible).toBe(true);
  await page.reload();
  await expect(workspace).toBeVisible();
  await openPanel(workspace, 'Objects');
  await workspace.getByRole('button', { name: 'Hero cube', exact: true }).click();
  await openPanel(workspace, 'Properties');
  await expect(workspace.getByLabel('Position X', { exact: true })).toHaveValue('1.25');
  await expect(workspace.getByLabel('Roughness', { exact: true })).toHaveValue('0.65');
  await openPanel(workspace, 'Scene');
  await workspace.screenshot({ path: info.outputPath('astra-scene.png') });
  expect(pageErrors).toEqual([]);
  expect(state.paidRequests).toEqual([]);
});

test('templates, playback, camera and viewport capture stay usable across viewport sizes', async ({ page }, info) => {
  const { workspace, paidRequests } = await fixture(page);
  await workspace.getByLabel('Scene template', { exact: true }).selectOption('abstract');
  await openPanel(workspace, 'Objects');
  await workspace.getByRole('button', { name: 'Orbit', exact: true }).click();
  await openPanel(workspace, 'Scene');
  await workspace.getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect.poll(async () => Number(await workspace.getByLabel('Current frame', { exact: true }).inputValue())).toBeGreaterThan(1);
  await workspace.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await workspace.getByRole('button', { name: 'First frame', exact: true }).click();
  await openPanel(workspace, 'Objects');
  await workspace.getByRole('button', { name: /Scene camera/ }).click();
  await openPanel(workspace, 'Properties');
  await setNumber(workspace, 'Focal length (mm)', '70');
  await expect(workspace.getByLabel('Focal length (mm)', { exact: true })).toHaveValue('70');
  await openPanel(workspace, 'Output');
  const downloaded = page.waitForEvent('download');
  await workspace.getByRole('button', { name: 'Save viewport PNG', exact: true }).click();
  const download = await downloaded;
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(100);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(100);
  await workspace.screenshot({ path: info.outputPath('astra-output.png') });
  await page.screenshot({ path: info.outputPath('astra-output-page.png') });
  const bounds = await workspace.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(paidRequests).toEqual([]);
});

test('project GLB and image previews retain loaded resources during edits and reject external model resources', async ({ page }) => {
  const draws = await observeViewportDraws(page);
  const state = await fixture(page, true);
  const workspace = state.workspace;
  // Wait for the lazy viewport (including development Strict Mode setup) before
  // counting loads triggered by edits, rather than loads from mounting it.
  await expect(workspace.getByRole('img', { name: 'Interactive 3D viewport' })).toBeVisible();
  const external: string[] = [];
  await page.route('https://untrusted.example/**', async (route) => { external.push(route.request().url()); await route.abort(); });
  let releaseModel!: () => void, releaseImage!: () => void;
  const modelReady = new Promise<void>(resolve => { releaseModel = resolve; });
  const imageReady = new Promise<void>(resolve => { releaseImage = resolve; });
  await page.route('**/api/uploads/astra-model**', async route => { await modelReady; await route.fallback(); });
  await page.route('**/api/uploads/astra-image**', async route => { await imageReady; await route.fallback(); });
  await openPanel(workspace, 'Objects');
  await workspace.getByLabel('Add object', { exact: true }).selectOption('asset:triangle');
  await openPanel(workspace, 'Scene');
  let before = await draws.idle();
  releaseModel();
  await expect.poll(() => state.assetReads.filter((path) => path.endsWith('model')).length).toBe(1);
  await expect.poll(draws.count).toBeGreaterThan(before);
  await draws.idle();
  await openPanel(workspace, 'Properties');
  await setNumber(workspace, 'Position X', '2');
  await setNumber(workspace, 'Scale Z', '2');
  await openPanel(workspace, 'Objects');
  await workspace.getByLabel('Add object', { exact: true }).selectOption('asset:image');
  await openPanel(workspace, 'Scene');
  before = await draws.idle();
  releaseImage();
  await expect.poll(() => state.assetReads.filter((path) => path.endsWith('image')).length).toBe(1);
  await expect.poll(draws.count).toBeGreaterThan(before);
  await draws.idle();
  await openPanel(workspace, 'Properties');
  await setNumber(workspace, 'Position Z', '1');
  expect(state.assetReads.filter((path) => path.endsWith('model'))).toHaveLength(1);
  expect(state.assetReads.filter((path) => path.endsWith('image'))).toHaveLength(1);
  await openPanel(workspace, 'Objects');
  await workspace.getByLabel('Add object', { exact: true }).selectOption('asset:unsafe');
  await openPanel(workspace, 'Scene');
  await expect(workspace.getByRole('status')).toContainText('external files and data URLs are unsupported');
  expect(external).toEqual([]);
});
