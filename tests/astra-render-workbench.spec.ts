import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signInLocally } from './helpers/workbenchLocal';
import { newProject, type Project, type Asset } from '../lib/workbench/studio';
import { projectSchema } from '../lib/workbench/studio-schema';
import { createAstraScene } from '../lib/astra-blender/scene';
import { astraSceneDigest } from '../lib/astra-blender/proposal';
import { astraNativeDigest } from '../lib/astra-blender/native';
import type { AstraRenderJob, AstraRenderRequest, AstraRenderRuntime } from '../lib/astra-blender/render-contract';
import { astraRenderPendingKey } from '../components/astra-blender/astra-render-recovery';

const ENDPOINT = '/api/workbench/astra-blender/render';
const READY: AstraRenderRuntime = { configured: true, reason: null, blenderVersion: '5.0', timeoutMs: 180000, vcpus: 2, memoryMb: 4096 };

async function outputPanel(workspace: Locator) {
  await expect(workspace).toBeVisible();
  const mobile = workspace.getByRole('navigation', { name: '3D workspace panels' });
  await (await mobile.isVisible() ? mobile : workspace.getByRole('navigation', { name: 'Inspector panels' })).getByRole('button', { name: 'Output', exact: true }).click();
  const panel = workspace.getByRole('region', { name: 'Native Blender renders', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function fixture(page: Page, options: { unavailable?: boolean; loseResponse?: 'missing' | 'accepted' } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject('Astra native render study'), id: 'astra-native-render-study', productionProjectId: 'astra-render-production', shotMappings: {}, astraBlender: createAstraScene('product'), astraNative: { schemaVersion: 1, name: 'Bevel material study', program: 'import bpy\n# Reviewed Blender program fixture\n', assetIds: [] } };
  let revision = 1;
  let jobs: AstraRenderJob[] = [];
  const runtime = options.unavailable ? { ...READY, configured: false, reason: 'Connect a Blender snapshot and sandbox account before starting native jobs.' } : READY;
  const quotes: AstraRenderRequest[] = [], submissions: string[] = [], cancellations: string[] = [], forbidden: string[] = [], headers: string[] = [];
  const bytes: Record<string, Buffer> = { preview: await readFile('public/fixtures/still.png'), blend: Buffer.from('BLENDER-v500-fixture'), glb: Buffer.from('glTF-fixture') };
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === '/api/me') return json(me);
    if (url.pathname === '/api/workbench/projects') {
      if (request.method() === 'PUT') {
        headers.push(request.headers()['x-workbench-scope']);
        project = projectSchema.parse(request.postDataJSON().project) as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project, projects: [{ id: project.id, name: project.name }], productions: [], revision });
    }
    if (url.pathname === ENDPOINT) {
      headers.push(request.headers()['x-workbench-scope']);
      if (request.method() === 'GET') return json({ runtime, jobs: url.searchParams.has('requestId') ? jobs.filter((job) => job.requestId === url.searchParams.get('requestId')) : jobs });
      if (request.method() === 'PATCH') {
        const input = request.postDataJSON();
        cancellations.push(input.jobId);
        expect(input).toEqual({ projectId: project.id, jobId: jobs[0].id, action: 'cancel' });
        jobs[0] = { ...jobs[0], status: 'cancelled', billedCredits: 0, costUsd: 0, updatedAt: Date.now() };
        return json({ job: jobs[0] });
      }
      const input = request.postDataJSON() as AstraRenderRequest;
      if (input.quoteOnly) { quotes.push(input); return json({ runtime, quote: { estimateCredits: 12, maxCostUsd: .12, quoteDigest: 'a'.repeat(64), sourceDigest: input.sourceDigest, expiresAt: Date.now() + 60000, billingNote: 'The approved ceiling covers this native job. Actual usage is settled after completion.' } }); }
      submissions.push(request.postData()!);
      if (options.loseResponse === 'missing' && submissions.length === 1) return route.abort('failed');
      jobs = [{ id: 'render-fixture-1', requestId: input.requestId, projectId: project.id, source: input.source, sourceDigest: input.sourceDigest, status: 'running', estimateCredits: 12, billedCredits: null, costUsd: null, createdAt: Date.now(), updatedAt: Date.now(), error: null, artifacts: [], assetsRegistered: false }];
      if (options.loseResponse === 'accepted' && submissions.length === 1) return route.abort('failed');
      return json({ job: jobs[0] });
    }
    if (url.pathname.startsWith('/api/uploads/astra-render-')) {
      const kind = url.pathname.split('-').at(-1)!;
      return route.fulfill({ contentType: kind === 'preview' ? 'image/png' : kind === 'glb' ? 'model/gltf-binary' : 'application/x-blender', headers: url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${kind === 'preview' ? 'preview.png' : kind === 'glb' ? 'scene.glb' : 'scene.blend'}"` } : {}, body: bytes[kind] });
    }
    if (url.pathname === '/api/workbench/atomik' || url.pathname === '/api/workbench/development') return json({ models: [], jobs: [] });
    if (url.pathname === '/api/jobs') return json({ generations: [], nextCursor: null });
    if (url.pathname === '/api/engines' || url.pathname === '/api/workbench/engines') return json({ models: [], vendors: [] });
    if (request.method() !== 'GET') { forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'Unexpected paid request in native render browser fixture.' } }); }
    return json({});
  });
  await page.goto(`/workbench?project=${project.id}&stage=astra-blender`);
  const workspace = page.getByRole('region', { name: 'Astra blender', exact: true });
  const panel = await outputPanel(workspace);
  await expect(panel.getByText(options.unavailable ? 'Runtime setup required' : 'Blender 5.0 · Ready', { exact: true })).toBeVisible();
  return { workspace, panel, scope, quotes, submissions, cancellations, forbidden, headers, bytes,
    get project() { return project; }, get jobs() { return jobs; },
    complete() {
      const artifacts = (['preview', 'blend', 'glb'] as const).map((kind) => ({ kind, assetId: `asset-${kind}`, uploadId: `astra-render-${kind}`, url: `/api/uploads/astra-render-${kind}`, filename: kind === 'preview' ? 'preview.png' : `scene.${kind}`, mime: kind === 'preview' ? 'image/png' : kind === 'blend' ? 'application/x-blender' : 'model/gltf-binary', bytes: bytes[kind].length }));
      jobs[0] = { ...jobs[0], status: 'succeeded', billedCredits: 8, costUsd: .08, assetsRegistered: true, artifacts, updatedAt: Date.now() };
      const assets: Asset[] = artifacts.map((artifact) => ({ id: artifact.assetId, uploadId: artifact.uploadId, url: artifact.url, mime: artifact.mime, name: artifact.filename, kind: artifact.kind === 'preview' ? 'image' : 'document', category: 'Astra blender', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] }));
      project = { ...project, assets: [...project.assets, ...assets] }; revision++;
    },
  };
}

async function review(page: Page, panel: Locator) {
  await panel.getByRole('button', { name: 'Review render quote', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run native Blender render', exact: true });
  await expect(dialog.getByRole('button', { name: 'Start render · up to 12 cr', exact: true })).toBeEnabled();
  return dialog;
}

test('native render quote binds an explicit source and completed original outputs persist in the project', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const state = await fixture(page);
  await expect(state.panel.getByLabel('Native render source')).toHaveValue('native');
  const nativeQuote = await review(page, state.panel);
  expect(state.quotes[0].sourceDigest).toBe(await astraNativeDigest(state.project.astraNative));
  await expect(nativeQuote.getByText('Native program', { exact: true })).toBeVisible();
  expect(state.submissions).toHaveLength(0);
  await nativeQuote.getByRole('button', { name: 'Close', exact: true }).click();
  await state.panel.getByLabel('Native render source').selectOption('scene');
  const dialog = await review(page, state.panel);
  expect(state.quotes[1]).toMatchObject({ source: 'scene', sourceDigest: await astraSceneDigest(state.project.astraBlender!) });
  await page.screenshot({ path: info.outputPath('astra-native-quote.png') });
  await dialog.getByRole('button', { name: 'Start render · up to 12 cr', exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog).toHaveCount(0);
  await expect(state.panel.getByRole('progressbar', { name: 'Native render in progress' })).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  state.complete();
  await state.panel.getByRole('button', { name: 'Refresh native render history' }).click();
  await expect(state.panel.getByText('Outputs saved in your project library.', { exact: true })).toBeVisible();
  await state.panel.getByRole('button', { name: 'Load saved outputs into project', exact: true }).click();
  await expect(state.panel.getByRole('button', { name: 'Load saved outputs into project', exact: true })).toHaveCount(0);
  for (const [label, kind, filename] of [['PNG', 'preview', 'preview.png'], ['.blend', 'blend', 'scene.blend'], ['GLB', 'glb', 'scene.glb']] as const) {
    const downloading = page.waitForEvent('download');
    await state.panel.getByRole('link', { name: `Download rendered ${label}`, exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await readFile((await download.path())!)).toEqual(state.bytes[kind]);
  }
  await page.reload(); await outputPanel(state.workspace);
  await expect(state.panel.getByRole('article', { name: 'Native render render-fixture-1', exact: true })).toContainText('8 cr charged');
  expect(state.project.assets).toHaveLength(3);
  expect(new Set(state.project.assets.map((asset) => asset.id)).size).toBe(3);
  expect(state.headers.every((header) => header === state.scope)).toBe(true);
  expect(state.forbidden).toEqual([]); expect(errors).toEqual([]);
  await state.panel.getByRole('link', { name: 'Download rendered PNG', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('astra-native-completed.png') });
});

test('native render cancellation updates the durable job and remains cancelled after reload', async ({ page }) => {
  const state = await fixture(page);
  const dialog = await review(page, state.panel);
  await dialog.getByRole('button', { name: 'Start render · up to 12 cr', exact: true }).click();
  await state.panel.getByRole('button', { name: 'Cancel render', exact: true }).click();
  await expect(state.panel.getByRole('article', { name: 'Native render render-fixture-1', exact: true })).toContainText('Cancelled');
  await expect(state.panel.getByRole('progressbar')).toHaveCount(0);
  await page.reload(); await outputPanel(state.workspace);
  await expect(state.panel.getByRole('article', { name: 'Native render render-fixture-1', exact: true })).toContainText('0 cr charged');
  expect(state.cancellations).toEqual(['render-fixture-1']); expect(state.submissions).toHaveLength(1); expect(state.forbidden).toEqual([]);
});

test('unconfigured native Blender explains setup and cannot submit a render', async ({ page }) => {
  const state = await fixture(page, { unavailable: true });
  await expect(state.panel.getByRole('button', { name: 'Review render quote', exact: true })).toBeDisabled();
  await expect(state.panel.getByText('Connect a Blender snapshot and sandbox account before starting native jobs.', { exact: true })).toBeVisible();
  await expect(state.workspace.getByRole('button', { name: 'Download Blender package', exact: true })).toBeEnabled();
  expect(state.quotes).toEqual([]); expect(state.submissions).toEqual([]); expect(state.forbidden).toEqual([]);
});

test('an interrupted native submission recovers the exact durable request after reload', async ({ page }) => {
  const state = await fixture(page, { loseResponse: 'missing' });
  const dialog = await review(page, state.panel);
  await dialog.getByRole('button', { name: 'Start render · up to 12 cr', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const key = astraRenderPendingKey(state.scope, state.project.id), original = state.submissions[0];
  expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), key))!).body).toBe(original);
  await page.reload(); await outputPanel(state.workspace);
  const recovery = state.panel.getByRole('button', { name: 'Recover saved render request', exact: true });
  await expect(recovery).toBeEnabled(); await recovery.click();
  await expect(state.panel.getByRole('article', { name: 'Native render render-fixture-1', exact: true })).toBeVisible();
  expect(state.submissions).toEqual([original, original]); expect(state.quotes).toHaveLength(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull(); expect(state.forbidden).toEqual([]);
});

test('a lost response for an accepted native job recovers by lookup without another submission', async ({ page }) => {
  const state = await fixture(page, { loseResponse: 'accepted' });
  const dialog = await review(page, state.panel);
  await dialog.getByRole('button', { name: 'Start render · up to 12 cr', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(state.panel.getByRole('article', { name: 'Native render render-fixture-1', exact: true })).toBeVisible();
  expect(state.submissions).toHaveLength(1); expect(state.quotes).toHaveLength(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), astraRenderPendingKey(state.scope, state.project.id))).toBeNull();
  expect(state.forbidden).toEqual([]);
});
