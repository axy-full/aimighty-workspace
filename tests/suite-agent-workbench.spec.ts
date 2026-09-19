import { test, expect, type Page } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { seedProject, type Project, type Plan } from '../lib/workbench/studio';
import { projectSchema } from '../lib/workbench/studio-schema';
import { atomikPendingKey } from '../lib/workbench/atomik-pending-request';

type Submission = { suite: string; projectId: string; requestId: string; request: string; model: string; effort: string; refs: string[]; maxCredits?: number; quoteOnly?: boolean };
async function fixture(page: Page, lostResponse = false, googleOnly = false) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const base = seedProject();
  let project: Project = { ...base, id: 'agent-browser-project', name: 'Agent browser project', productionProjectId: 'agent-production', nodes: [], sharedNodes: [], sharedNodeIds: [], shots: [], plans: [],
    assets: [...base.assets, { ...base.assets[0], id: 'fourth-image', name: 'Fourth project image' }] };
  project.sharedAssets = structuredClone(project.assets);
  let revision = 1, jobs: Record<string, unknown>[] = [];
  const submissions: Submission[] = [], quotes: Submission[] = [], headers: string[] = [], forbidden: string[] = [];
  const models = [
    { id: 'openai/gpt-fixture', name: 'OpenAI: GPT Fixture', vision: true, efforts: [{ value: 'auto', label: 'Provider default' }, { value: 'medium', label: 'Medium' }] },
    { id: 'anthropic/claude-fixture', name: 'Anthropic: Sage fixture', vision: true, efforts: [{ value: 'auto', label: 'Provider default' }, { value: 'medium', label: 'Medium' }] },
    { id: 'google/gemini-fixture', name: 'Google: Prism fixture', vision: true },
  ].filter(model => !googleOnly || model.id.startsWith('google/'));
  function complete() {
    const input = submissions.at(-1)!;
    const plan: Plan = { id: 'suite-agent-job', request: input.request, role: 'marketing', model: input.model, depth: 'Deep', refs: input.refs, applied: false, intent: 'campaign', summary: 'A considered launch concept using the selected originals.', steps: ['Review the hero frame, then its motion.'], suiteAgent: { suite: 'moleculr', projectId: project.id,
      actions: [{ kind: 'image', title: 'Agent hero frame', prompt: 'Preserve the exact supplied product shape. Soft side light and a restrained composition.', referenceIds: ['environment'] }, { kind: 'video', title: 'Agent motion study', prompt: 'A slow dolly toward the supplied subject, preserving original proportions.', referenceIds: ['character'] }], hooks: ['An original perspective.'], assumptions: ['All product claims need review.'] } };
    jobs = [{ ...jobs[0], status: 'succeeded', credits: 3, plan }];
  }
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === '/api/me') return json({ ...me, workspace: { ...me.workspace, id: 'fresh-api-scope-must-not-replace-captured-document' } });
    if (url.pathname === '/api/workbench/projects') {
      if (request.method() === 'PUT') {
        expect(request.headers()['x-workbench-scope']).toBe(scope);
        project = projectSchema.parse(request.postDataJSON().project) as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project, projects: [{ id: project.id, name: project.name }], productions: [], revision });
    }
    if (url.pathname === '/api/workbench/atomik') {
      headers.push(request.headers()['x-workbench-scope']);
      if (request.method() === 'GET') return json({ configured: true, models, jobs: url.searchParams.has('requestId') ? jobs.filter(job => job.requestId === url.searchParams.get('requestId')) : jobs });
      const input = request.postDataJSON() as Submission;
      if (input.quoteOnly) { quotes.push(input); return json({ estimateCredits: 7, model: input.model === 'auto' ? 'openai/gpt-fixture' : input.model, effort: input.effort }); }
      submissions.push(input);
      if (lostResponse && submissions.length === 1) return route.abort('failed');
      jobs = [{ id: 'suite-agent-job', requestId: input.requestId, projectId: project.id, suite: input.suite, status: 'queued', request: input.request, model: input.model, depth: 'Deep', refs: input.refs, estimateCredits: 7, credits: null, plan: null }];
      return json({ job: jobs[0] });
    }
    if (url.pathname === '/api/workbench/development') return json({ models: [], jobs: [] });
    if (url.pathname === '/api/jobs') return json({ generations: [] });
    if (url.pathname === '/api/workbench/engines') return json({ models: [] });
    if (url.pathname === '/api/projects') return json({ projects: [{ id: 'agent-production', name: project.name }] });
    if (url.pathname === '/api/engines') return json({ models: [], vendors: [] });
    if (request.method() !== 'GET') { forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'No provider dispatch allowed in this fixture.' } }); }
    return json({});
  });
  return { scope, submissions, quotes, headers, forbidden, complete, get project() { return project; } };
}

async function openAgent(page: Page) {
  await page.goto('/workbench?project=agent-browser-project&suite=moleculr&page=brand');
  const panel = page.getByRole('region', { name: 'Campaign agent', exact: true }).first();
  await expect(panel.getByLabel('Creative request')).toBeEnabled();
  return panel;
}

test('suite agent quotes supported models once, keeps captured scope, and adds editable referenced actions', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await fixture(page);
  const panel = await openAgent(page);
  await panel.getByLabel('Creative request').fill('Develop a launch campaign with product-accurate frames and motion.');
  await panel.getByText('Project references', { exact: false }).click();
  for (const checkbox of await panel.getByRole('checkbox').all()) await checkbox.check();
  await panel.getByRole('button', { name: 'Review agent quote' }).click();
  const dialog = page.getByRole('dialog', { name: 'Campaign agent' });
  await dialog.getByLabel('Atomik request', { exact: true }).fill('A revised request without any suite prefix.');
  await dialog.getByRole('button', { name: 'Atomik request model', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Prism fixture', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Sage fixture', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Atomik request effort', exact: true }).click();
  await page.getByRole('option', { name: 'Medium', exact: true }).click();
  const run = dialog.getByRole('button', { name: 'Run · 7 cr estimated', exact: true });
  await expect(run).toBeEnabled();
  // Two immediate native clicks must still issue only one paid submission.
  await run.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Agent working…' })).toBeDisabled();
  expect(state.submissions).toHaveLength(1);
  expect(state.submissions[0]).toMatchObject({ suite: 'moleculr', projectId: 'agent-browser-project', request: 'A revised request without any suite prefix.', model: 'anthropic/claude-fixture', effort: 'medium', maxCredits: 7 });
  expect(state.submissions[0].refs).toHaveLength(4);
  state.complete();
  await panel.getByRole('button', { name: 'Refresh agent proposals' }).click();
  await panel.getByRole('button', { name: 'Add 2 actions to Rig', exact: true }).click();
  await expect.poll(() => state.project.nodes.filter(node => node.type === 'generate').length).toBe(2);
  expect(state.project.nodes.filter(node => node.type === 'generate').map(node => node.mode)).toEqual(['Image', 'Video']);
  expect(state.project.nodes.find(node => node.title === 'Agent hero frame')?.linked).toHaveLength(1);
  if (page.viewportSize()!.width < 760) {
    await page.locator('.mobile-node-viewbar').getByRole('tab', { name: 'List', exact: true }).click();
    await page.locator('.mobile-node-list button').filter({ hasText: 'Agent hero frame' }).click();
  } else {
    const node = page.getByRole('article', { name: 'Generate node: Agent hero frame', exact: true });
    await node.focus(); await node.press('Enter');
  }
  const direction = page.locator('#ng-direction');
  await expect(direction).toHaveValue(/Preserve the exact supplied product shape/);
  await direction.fill('Edited by the producer before any paid rendering.');
  await expect.poll(() => state.project.nodes.find(node => node.title === 'Agent hero frame')?.text).toBe('Edited by the producer before any paid rendering.');
  expect(state.forbidden).toEqual([]);
  expect(state.submissions).toHaveLength(1);
  expect(state.headers.every(header => header === state.scope)).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('suite-agent-editable-actions.png') });
});

test('lost suite submission recovers its exact request after reload without a new quote or identity', async ({ page }) => {
  const state = await fixture(page, true);
  const panel = await openAgent(page);
  await panel.getByLabel('Creative request').fill('Prepare a considered product launch.');
  await panel.getByRole('button', { name: 'Review agent quote' }).click();
  await page.getByRole('button', { name: 'Run · 7 cr estimated', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover this request', exact: true })).toBeEnabled();
  const first = state.submissions[0], key = atomikPendingKey(state.scope, state.project.id);
  const saved = await page.evaluate(key => localStorage.getItem(key), key);
  expect(JSON.parse(saved!).body).toBe(JSON.stringify(first));
  const quotes = state.quotes.length;
  await page.reload();
  await panel.getByRole('button', { name: 'Review agent quote' }).click();
  await expect(page.getByLabel('Atomik request', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Recover this request', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Campaign agent' })).toHaveCount(0);
  expect(state.submissions).toEqual([first, first]);
  expect(state.quotes).toHaveLength(quotes);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  expect(state.headers.every(header => header === state.scope)).toBe(true);
  expect(state.forbidden).toEqual([]);
});

test('suite planning stays unavailable when only unsupported models are connected', async ({ page }) => {
  const state = await fixture(page, false, true);
  const panel = await openAgent(page);
  await panel.getByLabel('Creative request').fill('Prepare an original campaign.');
  await expect(panel.getByRole('button', { name: 'Review agent quote' })).toBeDisabled();
  await expect(panel.getByText('Connect a priced thinking model in Workspace → Engines.')).toBeVisible();
  expect(state.quotes).toEqual([]);
  expect(state.submissions).toEqual([]);
});
