import { test, expect, type Page, type Locator } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { newProject, type Project, type Plan } from '../lib/workbench/studio';
import { projectSchema } from '../lib/workbench/studio-schema';
import { createAstraScene, ASTRA_BLENDER_MODEL } from '../lib/astra-blender/scene';
import { atomikPendingKey, type AtomikSubmission } from '../lib/workbench/atomik-pending-request';
import { astraNativeDigest } from '../lib/astra-blender/native';
import { readFile } from 'node:fs/promises';

type Request = AtomikSubmission & { quoteOnly?: boolean };
const EFFORTS = [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra high' }, { value: 'max', label: 'Maximum' }];

async function fixture(page: Page, loseResponse = false, nativeAssets = false, failNativeSave = false) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject('Astra assistant study'), id: 'astra-assistant-study', productionProjectId: 'astra-assistant-production', shotMappings: {}, astraBlender: createAstraScene('product') };
  if (nativeAssets) project.assets = [
    { id: 'base-blend', uploadId: 'base-blend-upload', name: 'Character rig.blend', mime: 'application/x-blender', kind: 'document', url: '/api/uploads/base-blend-upload', category: 'Astra', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] },
    { id: 'reference-render', uploadId: 'reference-render-upload', name: 'Reference render.png', mime: 'image/png', kind: 'image', url: '/api/uploads/reference-render-upload', category: 'Astra', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] },
    { id: 'reference-model', uploadId: 'reference-model-upload', name: 'Character.glb', mime: 'model/gltf-binary', kind: 'document', url: '/api/uploads/reference-model-upload', category: 'Astra', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] },
  ];
  let revision = 1;
  let jobs: Record<string, unknown>[] = [];
  const quotes: Request[] = [], submissions: Request[] = [], forbidden: string[] = [], headers: string[] = [];
  const proposed = createAstraScene('product');
  proposed.name = 'Astra material study';
  proposed.objects.find((object) => object.id === 'product')!.material.color = '#4466aa';
  const models = [{ id: ASTRA_BLENDER_MODEL, name: 'Astra', efforts: EFFORTS }, { id: 'anthropic/claude-fixture', name: 'Sage fixture', efforts: EFFORTS }];
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === '/api/me') return json(me);
    if (url.pathname === '/api/workbench/projects') {
      if (request.method() === 'PUT') {
        headers.push(request.headers()['x-workbench-scope']);
        if (failNativeSave && request.postDataJSON().project.astraNative) return route.fulfill({ status: 409, json: { error: 'Fixture native source save failed.' } });
        project = projectSchema.parse(request.postDataJSON().project) as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project, projects: [{ id: project.id, name: project.name }], productions: [], revision });
    }
    if (url.pathname === '/api/workbench/atomik') {
      headers.push(request.headers()['x-workbench-scope']);
      if (request.method() === 'GET') return json({ models, jobs: url.searchParams.has('requestId') ? jobs.filter((job) => job.requestId === url.searchParams.get('requestId')) : jobs });
      const input = request.postDataJSON() as Request;
      if (input.quoteOnly) { quotes.push(input); return json({ estimateCredits: 7, model: ASTRA_BLENDER_MODEL, effort: input.effort }); }
      submissions.push(input);
      if (loseResponse && submissions.length === 1) return route.abort('failed');
      const plan: Plan = {
        id: 'astra-proposal-job', request: input.request, model: input.model, effort: input.effort, depth: input.depth, refs: [], applied: false,
        intent: '3D scene', summary: 'A blue anodized product with the existing studio lighting.', steps: ['Change the product material to blue while retaining scene geometry.'],
        ...(input.astraBlender?.mode === 'native' ? { astraNative: { baseSceneDigest: input.astraBlender.sceneDigest, baseNativeDigest: input.astraBlender.nativeDigest!, source: { ...project.astraNative!, name: 'Procedural character study', program: 'import bpy\n# Editable geometry nodes and the existing character rig\nobj = bpy.context.active_object\n' } } } : { astraBlender: { baseSceneDigest: input.astraBlender!.sceneDigest, scene: proposed } }),
      };
      jobs = [{ id: plan.id, projectId: project.id, requestId: input.requestId, request: input.request, model: input.model, effort: input.effort, depth: input.depth, refs: [], status: 'succeeded', credits: 3, estimateCredits: 7, astraBlender: input.astraBlender, plan }];
      return json({ job: jobs[0] });
    }
    if (url.pathname === '/api/workbench/development') return json({ models: [], jobs: [] });
    if (url.pathname === '/api/jobs') return json({ generations: [], nextCursor: null });
    if (url.pathname === '/api/engines' || url.pathname === '/api/workbench/engines') return json({ models: [], vendors: [] });
    if (request.method() !== 'GET') { forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'Media generation and 3D runtime dispatch are forbidden in the assistant fixture.' } }); }
    return json({});
  });
  await page.goto('/workbench?project=astra-assistant-study&stage=astra-blender');
  const workspace = page.getByRole('region', { name: 'Astra', exact: true });
  await expect(workspace).toBeVisible();
  await panel(workspace, 'Astra');
  const assistant = workspace.getByRole('region', { name: 'Astra scene assistant', exact: true });
  await expect(assistant.getByLabel('Astra scene request')).toBeEnabled();
  return { workspace, assistant, scope, proposed, quotes, submissions, forbidden, headers, get project() { return project; } };
}

async function panel(workspace: Locator, name: 'Astra' | 'Objects' | 'Properties' | 'Scene') {
  await expect(workspace).toBeVisible();
  const mobile = workspace.getByRole('navigation', { name: '3D workspace panels' });
  if (await mobile.isVisible()) await mobile.getByRole('button', { name, exact: true }).click();
  else if (name === 'Astra' || name === 'Properties') await workspace.getByRole('navigation', { name: 'Inspector panels' }).getByRole('button', { name, exact: true }).click();
}

async function quote(page: Page, assistant: Locator) {
  await assistant.getByLabel('Astra scene request').fill('Make the product blue with a restrained anodized-metal finish.');
  await assistant.getByRole('button', { name: 'Review Astra quote', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Build with Astra', exact: true });
  await expect(dialog.getByRole('button', { name: 'Atomik request model', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Atomik request model', exact: true })).toContainText('Astra');
  await dialog.getByRole('combobox', { name: 'Atomik request effort', exact: true }).click();
  for (const effort of EFFORTS) await expect(page.getByRole('option', { name: effort.label, exact: true })).toBeVisible();
  await page.getByRole('option', { name: 'Maximum', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true })).toBeEnabled();
  return dialog;
}

test('Astra quote fixes the model, preserves effort, reviews a proposal, applies and reloads the saved scene', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await fixture(page);
  const dialog = await quote(page, state.assistant);
  expect(state.submissions).toHaveLength(0);
  expect(state.quotes.at(-1)).toMatchObject({ model: ASTRA_BLENDER_MODEL, effort: 'max', projectId: state.project.id });
  expect(state.quotes.at(-1)?.astraBlender?.sceneDigest).toMatch(/^[a-f0-9]{64}$/);
  await page.screenshot({ path: info.outputPath('astra-assistant-quote.png') });
  await dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog).toHaveCount(0);
  await expect(state.assistant.getByRole('button', { name: 'Apply scene proposal', exact: true })).toBeEnabled();
  expect(state.project.astraBlender!.name).toBe('Product study');
  await state.assistant.getByText('4 objects · 2 lights · review scene', { exact: true }).click();
  await expect(state.assistant.getByText('Product body · cylinder · 0, 0, 1 m', { exact: true })).toBeVisible();
  await state.assistant.getByRole('button', { name: 'Apply scene proposal', exact: true }).click();
  await expect.poll(() => state.project.astraBlender?.name).toBe(state.proposed.name);
  await expect(state.assistant.getByRole('button', { name: 'Applied to scene', exact: true })).toBeDisabled();
  await state.workspace.getByRole('button', { name: 'Undo scene change', exact: true }).click();
  await expect.poll(() => state.project.astraBlender?.name).toBe('Product study');
  await state.workspace.getByRole('button', { name: 'Redo scene change', exact: true }).click();
  await expect.poll(() => state.project.astraBlender?.name).toBe(state.proposed.name);
  await page.reload();
  await panel(state.workspace, 'Astra');
  await expect(state.assistant.getByRole('button', { name: 'Applied to scene', exact: true })).toBeDisabled();
  expect(state.project.astraBlender).toEqual(state.proposed);
  expect(state.project.plans.find((plan) => plan.id === 'astra-proposal-job')?.applied).toBe(true);
  expect(state.submissions).toHaveLength(1);
  expect(state.submissions[0]).toMatchObject({ model: ASTRA_BLENDER_MODEL, effort: 'max', maxCredits: 7, refs: [] });
  expect(state.headers.every((header) => header === state.scope)).toBe(true);
  expect(state.forbidden).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('astra-assistant-applied.png') });
});

test('editing a scene after requesting a proposal blocks stale apply and preserves the user edit', async ({ page }) => {
  const state = await fixture(page);
  const dialog = await quote(page, state.assistant);
  await dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true }).click();
  await expect(state.assistant.getByRole('button', { name: 'Apply scene proposal', exact: true })).toBeEnabled();
  await panel(state.workspace, 'Objects');
  await state.workspace.getByRole('button', { name: 'Product body', exact: true }).click();
  await panel(state.workspace, 'Properties');
  await state.workspace.getByLabel('Position X', { exact: true }).fill('2.5');
  await state.workspace.getByLabel('Position X', { exact: true }).press('Enter');
  await expect.poll(() => state.project.astraBlender?.objects.find((object) => object.id === 'product')?.position[0]).toBe(2.5);
  const edited = structuredClone(state.project.astraBlender);
  await panel(state.workspace, 'Astra');
  await state.assistant.getByRole('button', { name: 'Apply scene proposal', exact: true }).click();
  await expect(state.assistant.getByRole('alert')).toContainText('scene changed after this proposal was requested');
  expect(state.project.astraBlender).toEqual(edited);
  expect(state.project.plans.some((plan) => plan.id === 'astra-proposal-job' && plan.applied)).toBe(false);
  expect(state.submissions).toHaveLength(1);
  expect(state.forbidden).toEqual([]);
});

test('a lost Astra submission recovers identical request bytes after reload without another quote', async ({ page }) => {
  const state = await fixture(page, true);
  const dialog = await quote(page, state.assistant);
  await dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Recover this request', exact: true })).toBeEnabled();
  const original = state.submissions[0], key = atomikPendingKey(state.scope, state.project.id), quoteCount = state.quotes.length;
  const record = await page.evaluate((key) => localStorage.getItem(key), key);
  expect(JSON.parse(record!).body).toBe(JSON.stringify(original));
  await page.reload();
  await panel(state.workspace, 'Astra');
  const recovery = state.assistant.getByRole('button', { name: 'Recover saved Astra request', exact: true });
  await expect(recovery).toBeEnabled();
  await recovery.click();
  const restored = page.getByRole('dialog', { name: 'Build with Astra', exact: true });
  await expect(restored.getByLabel('Atomik request', { exact: true })).toBeDisabled();
  await restored.getByRole('button', { name: 'Recover this request', exact: true }).click();
  await expect(restored).toHaveCount(0);
  await expect(state.assistant.getByRole('button', { name: 'Apply scene proposal', exact: true })).toBeEnabled();
  expect(state.submissions).toEqual([original, original]);
  expect(state.quotes).toHaveLength(quoteCount);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
  expect(state.forbidden).toEqual([]);
});

test('native 3D workflow reviews Python, retains base blend and asset references, then saves and downloads the applied source', async ({ page }, info) => {
  const state = await fixture(page, false, true);
  const source = state.workspace.getByRole('region', { name: 'Native 3D source', exact: true });
  await source.getByLabel('Native source name', { exact: true }).fill('Character starting scene');
  await source.getByLabel('Native starting scene', { exact: true }).selectOption('base-blend');
  await source.getByText('Native input assets · 0/64', { exact: true }).click();
  await source.getByRole('checkbox', { name: 'Reference render.png', exact: true }).check();
  await source.getByRole('checkbox', { name: 'Character.glb', exact: true }).check();
  await source.getByRole('button', { name: 'Save native source', exact: true }).click();
  await expect.poll(() => state.project.astraNative?.baseBlendAssetId).toBe('base-blend');
  expect(state.project.astraNative?.assetIds).toEqual(['reference-render', 'reference-model']);
  const nativeDigest = await astraNativeDigest(state.project.astraNative), sceneBefore = structuredClone(state.project.astraBlender);
  await state.assistant.getByRole('button', { name: 'Native 3D', exact: true }).click();
  await state.assistant.getByText('Start a 3D runtime workflow', { exact: true }).click();
  await state.assistant.getByRole('button', { name: 'Geometry nodes', exact: true }).click();
  await expect(state.assistant.getByLabel('Astra scene request')).toHaveValue(/procedural geometry-node setup/);
  await state.assistant.getByText('Visual references · 0/4', { exact: true }).click();
  await state.assistant.getByRole('checkbox', { name: 'Reference render.png', exact: true }).check();
  await state.assistant.getByRole('button', { name: 'Review Astra quote', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Build with Astra', exact: true });
  await expect(dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true })).toBeEnabled();
  expect(state.quotes.at(-1)?.astraBlender).toMatchObject({ mode: 'native', nativeDigest, referenceIds: ['reference-render'] });
  await dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true }).click();
  await state.assistant.getByText('Review 3D runtime Python · Procedural character study', { exact: true }).click();
  await expect(state.assistant.getByText('2 asset inputs · Continues from a saved .blend', { exact: true })).toBeVisible();
  await expect(state.assistant.locator('pre')).toContainText('Editable geometry nodes');
  expect(await state.assistant.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await source.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(state.project.astraNative?.name).toBe('Character starting scene');
  await page.screenshot({ path: info.outputPath('astra-native-proposal.png') });
  await state.assistant.getByRole('button', { name: 'Apply native proposal', exact: true }).click();
  await expect.poll(() => state.project.astraNative?.name).toBe('Procedural character study');
  await expect(state.assistant.getByRole('button', { name: 'Applied to native source', exact: true })).toBeDisabled();
  expect(state.project.astraBlender).toEqual(sceneBefore);
  await page.reload(); await panel(state.workspace, 'Astra');
  await expect(source.getByLabel('Native starting scene', { exact: true })).toHaveValue('base-blend');
  await expect(source.getByLabel('Native 3D Python', { exact: true })).toHaveValue(state.project.astraNative!.program);
  const downloading = page.waitForEvent('download');
  await source.getByRole('button', { name: 'Download Python', exact: true }).click();
  const download = await downloading;
  expect(await readFile((await download.path())!, 'utf8')).toBe(state.project.astraNative!.program);
  expect(state.project.astraNative?.assetIds).toEqual(['reference-render', 'reference-model']);
  expect(state.submissions).toHaveLength(1); expect(state.forbidden).toEqual([]);
  await page.screenshot({ path: info.outputPath('astra-native-source.png') });
});

test('a failed native source save keeps the edited code and reports the failure after the editor remounts', async ({ page }) => {
  const state = await fixture(page, false, false, true);
  const source = state.workspace.getByRole('region', { name: 'Native 3D source', exact: true });
  await source.getByText('Review or edit Python', { exact: true }).click();
  const program = 'import bpy\n# Keep this unsaved source visible\n';
  await source.getByLabel('Native 3D Python', { exact: true }).fill(program);
  await source.getByRole('button', { name: 'Save native source', exact: true }).click();
  await expect(source.getByRole('alert')).toContainText('has not saved yet');
  await expect(source.getByLabel('Native 3D Python', { exact: true })).toHaveValue(program);
  await expect(source.getByRole('button', { name: 'Save native source', exact: true })).toBeEnabled();
  expect(state.project.astraNative).toBeUndefined();
  expect(state.submissions).toEqual([]); expect(state.forbidden).toEqual([]);
});
