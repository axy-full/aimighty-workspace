import { test, expect, type Page } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { seedProject, type Project } from '../lib/workbench/studio';
import { EMPTY_MOLECULR } from '../lib/workbench/moleculr';
import { saveSchema } from '../lib/workbench/studio-schema';

const wallet = '22222222-2222-4222-8222-222222222222';
const providerId = '33333333-3333-4333-8333-333333333333';
const generationId = `gen_hfc_${'a'.repeat(40)}`;
const original = { generationId, providerJobId: providerId, bytes: 1234, sha256: 'b'.repeat(64), width: 1080, height: 1920, seconds: 12,
  credits: 75, creditUnit: 'higgsfield_credits', asset: { generationId, url: `/api/media/${generationId}`, kind: 'video', mime: 'video/mp4', width: 1080, height: 1920, durationS: 12 } };
type FakeJob = Record<string, unknown> & { id: string; status: string };
const viewJob = (job: FakeJob) => ({ ...job, quoteExpired: job.status === 'quoted' && Number(job.quoteExpiresAt) <= Date.now() });
async function fixture(page: Page, options: { owner?: boolean; connected?: boolean; loseSubmit?: boolean; unsafeResult?: boolean; refuseSubmit?: boolean; loseBeforeAdmission?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  me.owner = options.owner ?? true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: 'consumer-campaign', name: 'Consumer campaign', nodes: [], productionProjectId: 'consumer-production',
    moleculr: { ...EMPTY_MOLECULR, productName: 'Our bottle', hooks: ['A considered opening'], creative: { kind: 'video', path: 'prompt', category: 'motion', aspect: '16:9', direction: 'A warm product scene.', seconds: 15 } } };
  let revision = 1;
  const jobs: FakeJob[] = [], posts: Record<string, unknown>[] = [], consumerReads: string[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
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
    if (path === `/api/media/${generationId}`) return route.fulfill({ path: 'public/fixtures/clip.mp4', contentType: 'video/mp4' });
    if (path.startsWith('/api/higgsfield/consumer/')) {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      if (request.method() === 'GET') consumerReads.push(path);
      if (path.endsWith('/connection') && request.method() === 'GET') return json({ connected: options.connected ?? true, requiresReconnect: false });
      if (path.endsWith('/video') && request.method() === 'GET') {
        expect(url.searchParams.get('draftId')).toBe(project.id);
        const recent = [...jobs].reverse(), active = (job: FakeJob) => ['dispatching', 'accepted', 'uncertain'].includes(job.status);
        return json({ jobs: [...recent.filter(active), ...recent.filter(job => !active(job))].slice(0, 25).map(viewJob) });
      }
      if (path.endsWith('/video') && request.method() === 'POST') {
        const body = request.postDataJSON(); posts.push(body);
        expect(body.draftId).toBe(project.id);
        if (body.action === 'quote') {
          expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
          const job: FakeJob = { id: `11111111-1111-4111-8111-${String(jobs.length + 1).padStart(12, '0')}`, draftId: project.id, status: 'quoted', input: body.input,
            workspaceId: wallet, workspaceName: 'Brand wallet', quoteCredits: 75, creditUnit: 'higgsfield_credits', quoteExpiresAt: Date.now() + 300000, providerJobId: null, result: null, createdAt: Date.now() };
          jobs.push(job); return json({ job: viewJob(job) });
        }
        const job = jobs.find(item => item.id === body.id)!;
        expect(job).toBeTruthy();
        if (body.action === 'submit') {
          expect(body).toEqual({ action: 'submit', draftId: project.id, id: job.id, workspaceId: wallet, credits: 75 });
          if (options.refuseSubmit) return json({ code: 'quote_changed', error: 'The Higgsfield price changed. Request a new quote.' }, 409);
          if (options.loseBeforeAdmission) return route.abort('connectionreset');
          job.status = options.loseSubmit ? 'uncertain' : 'accepted';
          job.providerReceipt = { response: { results: [{ id: providerId, model: 'marketing_studio_video', type: 'video', status: 'pending' }] } };
          if (options.loseSubmit) return route.abort('connectionreset');
          job.providerJobId = providerId; return json({ job: viewJob(job) });
        }
        if (body.action === 'status') {
          expect(body).toEqual({ action: 'status', draftId: project.id, id: job.id });
          if (['quoted', 'failed', 'completed'].includes(job.status)) return json({ job: viewJob(job) });
          job.status = 'completed'; job.providerJobId = providerId;
          job.result = { original: options.unsafeResult ? { ...original, asset: { ...original.asset, url: 'https://provider.example.test/raw.mp4' } } : original };
          job.originalAvailable = true; job.originalAvailability = 'available';
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
  return { scope, posts, jobs, consumerReads, unexpected, external, errors, get project() { return project; } };
}
const open = (page: Page) => page.goto('/workbench?project=consumer-campaign&suite=moleculr&page=variants');
function historyJob(index: number, status = 'quoted'): FakeJob {
  return { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, draftId: 'consumer-campaign', status,
    input: { prompt: `Saved campaign ${index}.`, duration: 15, resolution: '720p', aspectRatio: '16:9', generateAudio: true, mode: 'product_showcase' },
    workspaceId: wallet, workspaceName: 'Brand wallet', quoteCredits: 75, creditUnit: 'higgsfield_credits', quoteExpiresAt: Date.now() + 300000,
    providerJobId: status === 'accepted' || status === 'completed' ? providerId : null, result: null, createdAt: Date.now() - 60000 + index };
}

test('an older accepted video remains recoverable after more than 25 newer quotes and reload', async ({ page }) => {
  const state = await fixture(page);
  const oldest = historyJob(1, 'accepted');
  state.jobs.push(oldest, ...Array.from({ length: 30 }, (_, index) => historyJob(index + 2)));
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  const card = panel.locator('article').filter({ has: page.getByText('Saved campaign 1.', { exact: true }) });
  await expect(card.getByRole('button', { name: 'Check video result', exact: true })).toBeEnabled();
  await expect(panel.locator('article')).toHaveCount(25);
  // Exercise the local merge as well as the server's capped history response.
  for (let index = 0; index < 26; index++) {
    await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
    await expect.poll(() => state.posts.filter(body => body.action === 'quote').length).toBe(index + 1);
  }
  await expect(card.getByRole('button', { name: 'Check video result', exact: true })).toBeEnabled();
  await expect(panel.locator('article')).toHaveCount(25);
  await page.reload();
  await expect(card.getByRole('button', { name: 'Check video result', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Check video result', exact: true }).click();
  await expect(card.getByText('Original ready', { exact: true })).toBeVisible();
  expect(state.posts.filter(body => body.action === 'submit')).toEqual([]);
  expect(state.posts.filter(body => body.action === 'status')).toEqual([{ action: 'status', draftId: state.project.id, id: oldest.id }]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('an attempted quote missing from recent history remains guarded until its exact saved record is recovered', async ({ page }) => {
  const state = await fixture(page);
  const oldest = historyJob(1);
  state.jobs.push(oldest, ...Array.from({ length: 30 }, (_, index) => historyJob(index + 2)));
  const attemptKey = `particl-consumer-video:${encodeURIComponent(state.scope)}:${encodeURIComponent(state.project.id)}:attempts`;
  await page.addInitScript(({ key, id }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify([id])); }, { key: attemptKey, id: oldest.id });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  const quote = panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true });
  await expect(quote).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Recover earlier submission', exact: true })).toBeEnabled();
  expect(state.posts).toEqual([]);
  await panel.getByRole('button', { name: 'Recover earlier submission', exact: true }).click();
  await expect(panel.getByText('Saved campaign 1.', { exact: true })).toBeVisible();
  await expect(quote).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Recover earlier submission', exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), attemptKey)).toEqual([oldest.id]);
  oldest.quoteExpiresAt = Date.now() - 1000;
  await page.reload();
  await expect(quote).toBeDisabled();
  await panel.getByRole('button', { name: 'Recover earlier submission', exact: true }).click();
  await expect(quote).toBeEnabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), attemptKey)).toEqual([]);
  expect(state.posts).toEqual([
    { action: 'status', draftId: state.project.id, id: oldest.id },
    { action: 'status', draftId: state.project.id, id: oldest.id },
  ]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('a fast browser clock cannot release an attempted quote before authoritative server expiry', async ({ page }) => {
  const state = await fixture(page);
  const job = historyJob(1);
  state.jobs.push(job);
  const attemptKey = `particl-consumer-video:${encodeURIComponent(state.scope)}:${encodeURIComponent(state.project.id)}:attempts`;
  await page.addInitScript(({ key, id }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify([id])); }, { key: attemptKey, id: job.id });
  await page.clock.setFixedTime(new Date(Date.now() + 86400000));
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  const quote = panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true });
  await expect(panel.getByText('Submission needs reconciliation', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Date.now())).toBeGreaterThan(Number(job.quoteExpiresAt));
  expect(viewJob(job).quoteExpired).toBe(false);
  await expect(quote).toBeDisabled();
  await panel.getByRole('button', { name: 'Refresh saved video jobs', exact: true }).click();
  await expect(quote).toBeDisabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), attemptKey)).toEqual([job.id]);
  job.quoteExpiresAt = Date.now() - 1000;
  expect(viewJob(job).quoteExpired).toBe(true);
  await panel.getByRole('button', { name: 'Refresh saved video jobs', exact: true }).click();
  await expect(quote).toBeEnabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), attemptKey)).toEqual([]);
  expect(state.posts).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

for (const availability of ['deleted', undefined] as const) test(`a ${availability ?? 'missing'} original availability removes campaign download and attachment controls without changing its receipt`, async ({ page }) => {
  const state = await fixture(page);
  const job = { ...historyJob(1, 'completed'), result: { original }, originalAvailable: true as boolean | undefined, originalAvailability: 'available' as string | undefined };
  state.jobs.push(job);
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await expect(panel.getByText('Original ready', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Download original', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add original to project', exact: true })).toBeEnabled();
  const receipt = JSON.stringify(job.result);
  // Simulate deletion in Library (or an older response without live proof).
  job.originalAvailable = availability ? false : undefined;
  job.originalAvailability = availability;
  await panel.getByRole('button', { name: 'Refresh saved video jobs', exact: true }).click();
  const label = availability ? 'Completed · original deleted' : 'Completed · original unavailable';
  await expect(panel.getByText(label, { exact: true })).toBeVisible();
  await expect(panel.getByText('Original ready', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Download original', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Add original to project', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(panel.getByText(label, { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Download original', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Add original to project', exact: true })).toHaveCount(0);
  expect(JSON.stringify(job.result)).toBe(receipt);
  expect(state.posts).toEqual([]);
  expect(state.project.assets.some(asset => asset.generationId === generationId)).toBe(false);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('native campaign video requires a matching exact quote, recovers a lost acknowledgement and attaches only the collected original', async ({ page }, info) => {
  const state = await fixture(page, { loseSubmit: true });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true })).toBeEnabled();
  expect(state.posts).toEqual([]);
  const format = panel.getByLabel('Higgsfield video creative format', { exact: true });
  await expect(format).toHaveValue('product_showcase');
  expect(await format.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual([
    'ugc', 'ugc_how_to', 'ugc_unboxing', 'product_showcase', 'product_review', 'tv_spot', 'wild_card', 'ugc_virtual_try_on', 'virtual_try_on',
  ]);
  await expect(panel.getByText('UGC and try-on formats may introduce a presenter or model. Review generated dialogue and commercial claims before publishing.')).toBeVisible();
  await format.selectOption('tv_spot');
  await panel.getByLabel('Higgsfield video prompt', { exact: true }).fill('A warm, considered bottle reveal.');
  await panel.getByLabel('Higgsfield video duration').selectOption('12');
  await panel.getByLabel('Higgsfield video resolution').selectOption('1080p');
  await panel.getByLabel('Higgsfield video aspect ratio').selectOption('9:16');
  await panel.getByLabel('Generate audio', { exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeDisabled();
  expect(state.posts[0]).toMatchObject({ action: 'quote', input: { prompt: 'A warm, considered bottle reveal.', duration: 12, resolution: '1080p', aspectRatio: '9:16', generateAudio: false, mode: 'tv_spot' } });
  await expect(panel.getByLabel('Higgsfield video quote').getByText('Creative format · TV spot', { exact: true })).toBeVisible();
  await panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.').check();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeEnabled();
  await format.selectOption('ugc_unboxing');
  await expect(panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.')).not.toBeChecked();
  await expect(panel.getByText('The prompt or settings changed. Request a new quote before generating.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(1);
  // Returning to the old settings must not silently restore paid approval.
  await format.selectOption('tv_spot');
  await expect(panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeDisabled();
  await format.selectOption('ugc_unboxing');
  await panel.getByLabel('Higgsfield video prompt', { exact: true }).fill('A closer, warmer bottle reveal.');
  await expect(panel.getByText('The prompt or settings changed. Request a new quote before generating.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  expect(state.posts[1]).toMatchObject({ action: 'quote', input: { mode: 'ugc_unboxing' } });
  await expect(panel.getByLabel('Higgsfield video quote').getByText('Creative format · UGC · unboxing', { exact: true })).toBeVisible();
  await panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.').check();
  await panel.scrollIntoViewIfNeeded();
  if ((page.viewportSize()?.width ?? 1440) < 600) await panel.locator('[aria-label="Higgsfield video quote"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('consumer-campaign-video-quote.png') });
  await panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(state.posts.filter(body => body.action === 'submit')).toHaveLength(1);
  await page.reload();
  await expect(panel.getByLabel('Higgsfield video prompt', { exact: true })).toHaveValue('A closer, warmer bottle reveal.');
  await expect(format).toHaveValue('ugc_unboxing');
  await expect(panel.getByRole('button', { name: 'Recover saved video request', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true })).toBeDisabled();
  expect(state.posts.filter(body => body.action === 'submit')).toHaveLength(1);
  await panel.getByRole('button', { name: 'Recover saved video request', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Add original to project', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Add original to project', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'In project library', exact: true })).toBeDisabled();
  await expect.poll(() => state.project.assets.filter(asset => asset.generationId === generationId).length).toBe(1);
  expect(state.project.assets.find(asset => asset.generationId === generationId)).toMatchObject({ id: generationId, url: `/api/media/${generationId}`, kind: 'video', prompt: 'A closer, warmer bottle reveal.', category: 'Campaign video' });
  await page.reload();
  await expect(panel.getByRole('button', { name: 'In project library', exact: true })).toBeDisabled();
  expect(state.posts.map(body => body.action)).toEqual(['quote', 'quote', 'submit', 'status']);
  expect(state.jobs[1].input).toMatchObject({ mode: 'ugc_unboxing' });
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('nonowner sees the capability boundary and makes no consumer API requests', async ({ page }) => {
  const state = await fixture(page, { owner: false });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await expect(panel.getByText(/The workspace owner can use this connected account/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote' })).toHaveCount(0);
  expect(state.consumerReads).toEqual([]); expect(state.posts).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

for (const status of ['quoted', 'uncertain'] as const) test(`legacy ${status} video keeps the provider-default format and original saved input on recovery`, async ({ page }) => {
  const state = await fixture(page);
  const input = { prompt: 'An existing bottle campaign.', duration: 15, resolution: '720p', aspectRatio: '16:9', generateAudio: true };
  const receipt = status === 'uncertain' ? { response: { results: [{ id: providerId, model: 'marketing_studio_video', type: 'video', status: 'pending' }] } } : undefined;
  const job: FakeJob = { id: '11111111-1111-4111-8111-000000000001', draftId: state.project.id, status, input: { ...input },
    workspaceId: wallet, workspaceName: 'Brand wallet', quoteCredits: 75, creditUnit: 'higgsfield_credits', quoteExpiresAt: Date.now() + 300000,
    providerJobId: null, result: null, providerReceipt: receipt, createdAt: Date.now() };
  state.jobs.push(job);
  const storageKey = `particl-consumer-video:${encodeURIComponent(state.scope)}:${encodeURIComponent(state.project.id)}`;
  await page.addInitScript(({ key, value }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: input });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  const format = panel.getByLabel('Higgsfield video creative format', { exact: true });
  await expect(format).toHaveValue('');
  await expect(format.locator('option:checked')).toHaveText('UGC (provider default)');
  await expect(panel.locator('[aria-label="Saved Higgsfield video jobs"] article').getByText(/UGC \(provider default\) · 15s/)).toBeVisible();
  await page.reload();
  await expect(format).toHaveValue('');
  expect(state.posts).toEqual([]);
  if (status === 'quoted') {
    await panel.getByRole('button', { name: 'Review this saved quote', exact: true }).click();
    await expect(panel.getByLabel('Higgsfield video quote').getByText('Creative format · UGC (provider default)', { exact: true })).toBeVisible();
    await panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.').check();
    await panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Check video result', exact: true })).toBeEnabled();
    expect(state.posts.map(body => body.action)).toEqual(['submit']);
  } else {
    await panel.getByRole('button', { name: 'Recover saved video request', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Add original to project', exact: true })).toBeEnabled();
    expect(state.posts.map(body => body.action)).toEqual(['status']);
    expect(job.providerReceipt).toEqual(receipt);
  }
  expect(job.input).toEqual(input);
  expect(Object.hasOwn(job.input as object, 'mode')).toBe(false);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey)).toEqual(input);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('disconnected owner can review connection guidance without a quote or submission', async ({ page }) => {
  const state = await fixture(page, { connected: false });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await expect(panel.getByRole('link', { name: /Workspace settings/ })).toHaveAttribute('href', '/settings#engines');
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote' })).toBeDisabled();
  expect(state.posts).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('completed provider URL without a verified local original cannot attach or load remote media', async ({ page }) => {
  const state = await fixture(page, { unsafeResult: true });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  await panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.').check();
  await panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true }).click();
  await panel.getByRole('button', { name: 'Check video result', exact: true }).click();
  await expect(panel.getByText(/The original video is unavailable/)).toBeVisible();
  await expect(panel.getByText("Completed · original unavailable", { exact: true })).toBeVisible();
  await expect(panel.getByText("Original ready", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("The original video is ready to add to this project.", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Add original to project', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Download original' })).toHaveCount(0);
  expect(state.project.assets.some(asset => asset.generationId === generationId)).toBe(false);
  expect(state.posts.map(body => body.action)).toEqual(['quote', 'submit', 'status']);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('definite preflight refusal permits a new reviewed quote without retrying the submission', async ({ page }) => {
  const state = await fixture(page, { refuseSubmit: true });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  await panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.').check();
  await panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('The Higgsfield price changed. Request a new quote.');
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeDisabled();
  expect(state.posts.map(body => body.action)).toEqual(['quote', 'submit', 'quote']);
  expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('lost request with an unclaimed quote remains guarded until an explicit read confirms its expiry', async ({ page }) => {
  const state = await fixture(page, { loseBeforeAdmission: true });
  await open(page);
  const panel = page.getByRole('region', { name: 'Higgsfield Marketing Video', exact: true });
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  await panel.getByLabel('Charge 75 Higgsfield credits to Brand wallet for this video.').check();
  await panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await page.reload();
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Recover saved video request', exact: true })).toHaveCount(0);
  state.jobs[0].quoteExpiresAt = Date.now() - 1000;
  await panel.getByRole('button', { name: 'Refresh saved video jobs', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Get Higgsfield video quote', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Generate video · 75 Higgsfield credits', exact: true })).toBeDisabled();
  expect(state.posts.map(body => body.action)).toEqual(['quote', 'submit', 'quote']);
  expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
