import { test, expect, type Page } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { seedProject, type Project } from '../lib/workbench/studio';
import { EMPTY_MOLECULR } from '../lib/workbench/moleculr';
import { saveSchema } from '../lib/workbench/studio-schema';
import { generationReferenceIds } from '../lib/workbench/node-graph';

const seedance = 'dreamina-seedance-2-5-260628';
async function fixture(page: Page, compatible = true) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: 'reference-ad', name: 'Reference campaign', nodes: [], productionProjectId: 'reference-production' };
  project.assets[0] = { ...project.assets[0], uploadId: 'product-upload' };
  project.assets.push(
    { ...project.assets[0], id: 'ad-upload', kind: 'video', name: 'Uploaded reference', uploadId: 'ad-original-upload', refs: [], mime: 'video/mp4' },
    { ...project.assets[0], id: 'ad-generated', kind: 'video', name: 'Generated reference', uploadId: undefined, generationId: 'ad-original-generation', refs: [], mime: 'video/mp4' },
  );
  project.moleculr = { ...EMPTY_MOLECULR, productName: 'Our product', hooks: ['A clear introduction'], productAssetIds: ['hero'],
    creative: { kind: 'video', path: 'prompt', category: 'motion', aspect: '16:9', direction: '', seconds: 15 } };
  let revision = 1;
  const posts: Record<string, unknown>[] = [], quotes: URLSearchParams[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    external.push(url.href); return route.abort('blockedbyclient');
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === '/api/me') return json(me);
    if (/^\/api\/(uploads|media)\/ad-original-/.test(path)) return route.fulfill({ path: 'public/fixtures/clip.mp4', contentType: 'video/mp4' });
    if (path === '/api/workbench/projects') {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      if (request.method() === 'PUT') {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings ?? {} });
      }
      if (request.method() === 'POST') return json({ shotId: 'reviewed-shot', productionProjectId: 'reference-production' });
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === '/api/workbench/engines') {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      if (url.searchParams.has('model')) { quotes.push(url.searchParams); expect(url.searchParams.get('model')).toBe(seedance); return json({ credits: 4 }); }
      const base = { kind: 'video', resolutions: ['720p'], ratios: ['16:9', '9:16'], durations: [4, 7, 15] };
      return json({ models: [
        { ...base, id: 'fal-ai/kling-video/v3/standard', label: 'Kling without video references', family: 'kling-3', maxReferenceImages: 0, maxReferenceVideos: 0 },
        ...(compatible ? [{ ...base, id: seedance, label: 'Seedance 2.5', family: 'seedance-2', maxReferenceImages: 30, maxReferenceVideos: 10 }] : []),
      ] });
    }
    if (path === '/api/generate' && request.method() === 'POST') {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      posts.push(request.postDataJSON()); return json({ id: 'mock-reference-job' });
    }
    if (path === '/api/jobs') return json({ generations: [] });
    if (path === '/api/workbench/atomik' || path === '/api/workbench/development') return json({ configured: false, models: [], jobs: [] });
    if (path === '/api/pipelines') return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: '', music: '' } });
    if (path === '/api/atomik') return json({ chats: [], models: { featured: [], rest: [] }, engines: [] });
    if (path === '/api/projects') return json({ projects: [] });
    if (path === '/api/engines') return json({ engines: [], models: [], vendors: [] });
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return json({ error: 'No other mutation permitted.' }, 409); }
    return json({});
  });
  return { posts, quotes, unexpected, external, errors, get project() { return project; } };
}

test('Moleculr stores one original reference, quotes a compatible engine and sends that exact video only after review', async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto('/workbench?project=reference-ad&suite=moleculr&page=variants');
  await page.getByLabel('Reference ad video', { exact: true }).selectOption('ad-upload');
  await page.getByLabel('Reference ad notes', { exact: true }).fill('A quiet detail opening.');
  await page.getByLabel('Reference ad matching direction', { exact: true }).fill('Adapt the pace to our product; use a warm setting.');
  const preview = page.getByLabel('Reference ad preview: Uploaded reference');
  await expect(preview).toHaveAttribute('src', '/api/uploads/ad-original-upload?download=1');
  await expect(preview).toHaveAttribute('preload', 'metadata');
  await expect(preview).not.toHaveAttribute('autoplay');
  await page.getByRole('button', { name: 'Prepare hook × cast variants', exact: true }).click();
  await expect.poll(() => state.project.moleculr?.variants.length).toBe(1);
  expect(state.posts).toEqual([]); expect(state.quotes).toEqual([]);
  const variant = state.project.moleculr!.variants[0];
  expect(variant.referenceVideo?.assetId).toBe('ad-upload');
  expect(generationReferenceIds(state.project.nodes.find(node => node.id === variant.nodeId)!, state.project)).toEqual(['hero', 'ad-upload']);
  await page.getByRole('button', { name: 'Review generation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Generation engine')).toHaveValue(seedance);
  await expect(dialog.getByLabel('Generation engine').locator('option')).toHaveCount(1);
  await expect(dialog.getByText(/2 bound media references/)).toBeVisible();
  await expect(dialog.getByLabel('Generation direction')).toContainText('A quiet detail opening.');
  await expect(dialog.getByLabel('Node first frame')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Generate · 4 cr estimated', exact: true })).toBeEnabled();
  expect(state.quotes.at(-1)?.getAll('uploadId')).toEqual(['product-upload', 'ad-original-upload']);
  await page.screenshot({ path: info.outputPath('reference-ad-reviewed-generation.png') });
  await dialog.getByRole('button', { name: 'Generate · 4 cr estimated', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({ model: seedance, maxCredits: 4, firstFrameAssetId: '', references: [
    { uploadId: 'product-upload', role: 'reference_image' }, { uploadId: 'ad-original-upload', role: 'reference_video' },
  ] });
  await expect.poll(() => state.project.moleculr?.variants[0].generation?.modelId).toBe(seedance);
  await page.reload();
  await expect(page.getByLabel('Reference ad video', { exact: true })).toHaveValue('ad-upload');
  await expect(page.getByLabel('Reference ad notes', { exact: true })).toHaveValue('A quiet detail opening.');
  await page.getByLabel('Reference ad video', { exact: true }).selectOption('ad-generated');
  await page.getByRole('button', { name: 'Prepare hook × cast variants', exact: true }).click();
  await expect.poll(() => state.project.moleculr?.variants.length).toBe(2);
  expect(state.project.moleculr!.variants[1].referenceVideo).toEqual({ assetId: 'ad-generated', sourceKey: '{"genId":"ad-original-generation"}' });
  await page.getByRole('button', { name: 'Review generation', exact: true }).first().click();
  await expect(dialog.getByRole('button', { name: 'Generate · 4 cr estimated', exact: true })).toBeEnabled();
  expect(state.quotes.at(-1)?.getAll('genId')).toEqual(['ad-original-generation']);
  expect(state.posts).toHaveLength(1);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('reference video with no compatible configured engine cannot quote or submit', async ({ page }) => {
  const state = await fixture(page, false);
  await page.goto('/workbench?project=reference-ad&suite=moleculr&page=variants');
  await page.getByLabel('Reference ad video', { exact: true }).selectOption('ad-upload');
  await page.getByRole('button', { name: 'Configure generation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/No configured video engine accepts these references/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Loading estimate…', exact: true })).toBeDisabled();
  expect(state.quotes).toEqual([]); expect(state.posts).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
