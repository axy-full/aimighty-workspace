import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signInLocally } from './helpers/workbenchLocal';
import { seedProject, type Project } from '../lib/workbench/studio';
import { EMPTY_MOLECULR } from '../lib/workbench/moleculr';
import { saveSchema } from '../lib/workbench/studio-schema';

const wallet = '22222222-2222-4222-8222-222222222222';
const providerId = '33333333-3333-4333-8333-333333333333';
const generationId = `gen_hfc_${'c'.repeat(40)}`;
const original = { generationId, providerJobId: providerId, bytes: 1234, sha256: 'd'.repeat(64), width: 1024, height: 1024, mime: 'image/png',
  credits: 40, creditUnit: 'higgsfield_credits', asset: { generationId, url: `/api/media/${generationId}`, kind: 'image', mime: 'image/png', width: 1024, height: 1024 } };
const fixture = JSON.parse(readFileSync('tests/fixtures/marketing-templates.json', 'utf8'));
const cards = fixture.pages.flatMap((page: { presets: Record<string, unknown>[] }) => page.presets).map((preset: Record<string, unknown>) => ({
  id: preset.id, name: String(preset.name).replace(/Higgsfield\s*/i, ''), category: preset.category, description: preset.description ?? '',
  previewUrl: typeof preset.preview_url === 'string' && preset.preview_url.startsWith('https://') ? preset.preview_url : null,
  outputKind: preset.type ?? (['ugc', 'motion', 'ads'].includes(String(preset.category)) ? 'video' : 'image'), inputs: preset.inputs ?? [],
  credits: preset.id === 'tpl_product_shot_studio' ? 40 : preset.category === 'ugc' ? 75 : preset.credits ?? 30, priceSource: preset.credits ? 'catalogue' : 'cost_table',
}));
type FakeJob = Record<string, unknown> & { id: string; status: string };
const viewJob = (job: FakeJob) => ({ ...job, quoteExpired: job.status === 'quoted' && Number(job.quoteExpiresAt) <= Date.now() });
async function fixtureFor(page: Page, options: { connected?: boolean; loseSubmit?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  me.owner = true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: 'template-campaign', name: 'Template campaign', nodes: [], productionProjectId: 'template-production',
    assets: [{ id: 'asset-still', name: 'Bottle still', kind: 'image', category: 'Product', url: '/api/uploads/still', uploadId: 'still', description: '', prompt: '', status: 'Draft', version: 1, locked: false, refs: [] }],
    moleculr: { ...EMPTY_MOLECULR, productName: 'Our bottle', productDescription: 'A reusable bottle.', productAssetIds: ['asset-still'], hooks: ['A considered opening'] } };
  let revision = 1;
  const jobs: FakeJob[] = [], posts: Record<string, unknown>[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    if (url.hostname === 'previews.example.test') return route.fulfill({ path: 'public/fixtures/still.png', contentType: 'image/png' });
    external.push(url.href); return route.abort('blockedbyclient');
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === '/api/me') return json(me);
    if (path === `/api/media/${generationId}` || path === '/api/uploads/still') return route.fulfill({ path: 'public/fixtures/still.png', contentType: 'image/png' });
    if (path.startsWith('/api/higgsfield/consumer/')) {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      if (path.endsWith('/connection') && request.method() === 'GET') return json({ connected: options.connected ?? true, requiresReconnect: false });
      if (path.endsWith('/marketing-templates') && request.method() === 'GET') {
        expect(url.searchParams.get('draftId')).toBe(project.id);
        const recent = [...jobs].reverse(), active = (job: FakeJob) => ['dispatching', 'accepted', 'uncertain'].includes(job.status);
        return json({ jobs: [...recent.filter(active), ...recent.filter(job => !active(job))].slice(0, 25).map(viewJob) });
      }
      if (path.endsWith('/marketing-templates') && request.method() === 'POST') {
        const body = request.postDataJSON(); posts.push(body);
        if (body.action === 'catalogue') {
          expect(body).toEqual({ action: 'catalogue', limit: 400, ...(body.refresh ? { refresh: true } : {}) });
          return json({ catalogue: { templates: cards, matched: cards.length, total: 986, loaded: cards.length, complete: true, fetchedAt: Date.now(), categories: ['ads', 'marketplace', 'motion', 'posters', 'product-shot', 'ugc'], costsVersion: '2026-09-18' } });
        }
        expect(body.draftId).toBe(project.id);
        if (body.action === 'quote') {
          expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
          const job: FakeJob = { id: `11111111-1111-4111-8111-${String(jobs.length + 1).padStart(12, '0')}`, draftId: project.id, status: 'quoted', input: body.input,
            template: { id: body.input.presetId, name: 'Studio product shot', category: 'product-shot', previewUrl: 'https://previews.example.test/tpl_product_shot_studio.jpg' }, outputKind: 'image', priceSource: 'cost_table', costsVersion: '2026-09-18',
            workspaceId: wallet, workspaceName: 'Brand wallet', quoteCredits: 40, creditUnit: 'higgsfield_credits', quoteExpiresAt: Date.now() + 300000, providerJobId: null, result: null, createdAt: Date.now() };
          jobs.push(job); return json({ job: viewJob(job) });
        }
        const job = jobs.find(item => item.id === body.id)!;
        expect(job).toBeTruthy();
        if (body.action === 'submit') {
          expect(body).toEqual({ action: 'submit', draftId: project.id, id: job.id, workspaceId: wallet, credits: 40 });
          job.status = options.loseSubmit ? 'uncertain' : 'accepted';
          job.providerReceipt = { response: { job_id: providerId, status: 'pending' } };
          if (options.loseSubmit) return route.abort('connectionreset');
          job.providerJobId = providerId; return json({ job: viewJob(job) });
        }
        if (body.action === 'status') {
          expect(body).toEqual({ action: 'status', draftId: project.id, id: job.id });
          if (['quoted', 'failed', 'completed'].includes(job.status)) return json({ job: viewJob(job) });
          job.status = 'completed'; job.providerJobId = providerId;
          job.result = { original }; job.originalAvailable = true; job.originalAvailability = 'available';
          return json({ job: viewJob(job), pollAfterSeconds: 30 });
        }
      }
    }
    if (path === '/api/workbench/projects') {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      if (request.method() === 'PUT') {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
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
  return { scope, posts, jobs, unexpected, external, errors, get project() { return project; } };
}
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const sectionLink = (page: Page, name: string) => page.getByRole('navigation', { name: 'Marketing Studio sections', exact: true }).getByRole('link', { name, exact: true });

test('browse the template catalogue in Format, pick one, quote, approve, create, check status and save the original as a variant', async ({ page }) => {
  const state = await fixtureFor(page);
  await page.goto('/workbench?project=template-campaign&suite=moleculr&page=format');
  const browser = page.getByRole('region', { name: 'Template catalogue', exact: true });
  await expect(browser).toBeVisible();
  await expect(browser.getByText(/6 of 6 templates \(986 in the catalogue; first 6 loaded\)/)).toBeVisible();
  const grid = browser.getByRole('list', { name: 'Templates', exact: true });
  await expect(grid.getByRole('button')).toHaveCount(6);
  await browser.getByLabel('Template category', { exact: true }).selectOption('ugc');
  await expect(grid.getByRole('button')).toHaveCount(1);
  await expect(grid.getByRole('button', { name: /UGC unboxing/ })).toContainText('75 connected credits');
  await browser.getByLabel('Template category', { exact: true }).selectOption('all');
  await browser.getByLabel('Search templates', { exact: true }).fill('studio');
  await expect(grid.getByRole('button')).toHaveCount(1);
  const card = grid.getByRole('button', { name: /Studio product shot/ });
  await expect(card).toContainText('40 connected credits');
  await expect(card.locator('img')).toHaveAttribute('src', 'https://previews.example.test/tpl_product_shot_studio.jpg');
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(browser.getByRole('status')).toContainText('Selected template · Studio product shot · product-shot · image · 40 connected credits');
  await noOverflow(page);
  expect(state.posts.filter(post => post.action === 'catalogue')).toHaveLength(1);
  expect((await browser.textContent())?.toLowerCase()).not.toContain('higgsfield');

  await sectionLink(page, 'Variants').click();
  const creator = page.getByRole('region', { name: 'Create with template', exact: true });
  await expect(creator).toBeVisible();
  await expect(creator.getByLabel('Picked template', { exact: true })).toContainText('Studio product shot');
  await expect(creator.getByLabel('Template description', { exact: true })).toHaveValue(/Product: Our bottle\./);
  await creator.getByLabel('Template brand name', { exact: true }).fill('Our bottle');
  await creator.getByLabel('Template product image', { exact: true }).selectOption('asset-still');
  const quoteButton = creator.getByRole('button', { name: 'Get connected-credit quote', exact: true });
  await expect(quoteButton).toBeDisabled();
  await creator.getByLabel(/copied to the connected account/).check();
  await expect(quoteButton).toBeEnabled();
  await quoteButton.click();
  const quote = creator.getByLabel('Template quote', { exact: true });
  await expect(quote).toContainText('40 connected credits · Brand wallet');
  await expect(quote).toContainText('Approved exact price from the template catalogue’s cost table (version 2026-09-18); the create tool advertises no preflight quote.');
  await expect(quote).toContainText('Studio product shot · product-shot · image · 1 product image');
  expect(state.posts.find(post => post.action === 'quote')?.input).toEqual({ presetId: 'tpl_product_shot_studio', prompt: expect.stringContaining('Product: Our bottle.'), brandName: 'Our bottle', productImage: { uploadId: 'still' } });
  const createButton = creator.getByRole('button', { name: /^Create with template · 40 connected credits$/ });
  await expect(createButton).toBeDisabled();
  await quote.getByLabel(/Charge 40 connected credits to Brand wallet/).check();
  await expect(createButton).toBeEnabled();
  await noOverflow(page);
  await createButton.click();
  await expect(creator.getByRole('status').filter({ hasText: 'Request recorded' })).toBeVisible();
  const jobCard = creator.getByLabel('Saved template jobs', { exact: true }).locator('article').first();
  await expect(jobCard).toContainText('In progress');
  await jobCard.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(jobCard).toContainText('Original ready');
  await expect(jobCard.locator('img')).toHaveAttribute('src', `/api/media/${generationId}`);
  await jobCard.getByRole('button', { name: 'Save as variant', exact: true }).click();
  await expect(jobCard.getByRole('button', { name: 'Saved as variant', exact: true })).toBeDisabled();
  await expect.poll(() => state.project.assets.find(asset => asset.generationId === generationId)?.category).toBe('Campaign template');
  await expect(page.getByRole('heading', { name: 'Campaign takes', exact: true }).locator('xpath=ancestor::section[1]')).toContainText('1 takes');
  await noOverflow(page);
  expect(state.posts.map(post => post.action)).toEqual(['catalogue', 'quote', 'submit', 'status']);
  expect(state.posts.filter(post => post.action === 'submit')).toHaveLength(1);
  expect((await creator.textContent())?.toLowerCase()).not.toContain('higgsfield');
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('a lost create acknowledgement stays guarded until its saved record is recovered, and the catalogue is not read while disconnected', async ({ page }) => {
  const state = await fixtureFor(page, { loseSubmit: true });
  await page.goto('/workbench?project=template-campaign&suite=moleculr&page=format');
  const browser = page.getByRole('region', { name: 'Template catalogue', exact: true });
  await browser.getByRole('list', { name: 'Templates', exact: true }).getByRole('button', { name: /Studio product shot/ }).click();
  await sectionLink(page, 'Variants').click();
  const creator = page.getByRole('region', { name: 'Create with template', exact: true });
  await creator.getByRole('button', { name: 'Get connected-credit quote', exact: true }).click();
  const quote = creator.getByLabel('Template quote', { exact: true });
  await quote.getByLabel(/Charge 40 connected credits/).check();
  await creator.getByRole('button', { name: /^Create with template/ }).click();
  await expect(creator.getByRole('alert')).toBeVisible();
  await expect(creator.getByRole('button', { name: 'Get connected-credit quote', exact: true })).toBeDisabled();
  await expect(creator.getByRole('status').filter({ hasText: 'A submission needs reconciliation' })).toBeVisible();
  await page.reload();
  const again = page.getByRole('region', { name: 'Create with template', exact: true });
  await expect(again.getByRole('button', { name: 'Get connected-credit quote', exact: true })).toBeDisabled();
  await again.getByRole('button', { name: 'Recover saved request', exact: true }).click();
  await expect(again.getByLabel('Saved template jobs', { exact: true }).locator('article').first()).toContainText('Original ready');
  expect(state.posts.filter(post => post.action === 'submit')).toHaveLength(1);
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test('without a connected account the catalogue is not read and the creator explains the connection step', async ({ page }) => {
  const state = await fixtureFor(page, { connected: false });
  await page.goto('/workbench?project=template-campaign&suite=moleculr&page=format');
  const browser = page.getByRole('region', { name: 'Template catalogue', exact: true });
  await expect(browser.getByRole('link', { name: /Workspace settings/ })).toBeVisible();
  await expect(browser.getByRole('list', { name: 'Templates', exact: true })).toHaveCount(0);
  await sectionLink(page, 'Variants').click();
  const creator = page.getByRole('region', { name: 'Create with template', exact: true });
  await expect(creator.getByText('No template picked yet. Choose one in the Format section’s template catalogue.')).toBeVisible();
  await expect(creator.getByRole('button', { name: 'Get connected-credit quote', exact: true })).toBeDisabled();
  await noOverflow(page);
  expect(state.posts).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
