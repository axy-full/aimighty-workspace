import { test, expect, type Locator, type Page } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { seedProject, newProject, type Project } from '../lib/workbench/studio';
import { EMPTY_MOLECULR } from '../lib/workbench/moleculr';
import { saveSchema } from '../lib/workbench/studio-schema';
import { legacyShell } from './helpers/legacyShell';

/* A member of a managed workspace runs website tools on the platform's
   website account: every price is the workspace's own credits, the charge
   stands if the run fails and is said before approval, approval names the
   credits alone, and no wallet, connected credits or account name appears.
   Every route is a fixture; nothing reaches a provider. */
const video = `gen_hfc_${'a'.repeat(40)}`, clips = [`gen_hfc_${'b'.repeat(40)}`, `gen_hfc_${'c'.repeat(40)}`], variant = `gen_hfc_${'d'.repeat(40)}`;
const presetId = '7fa32a45-2f1e-45ed-8cc7-03296ddcf07f';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
type Job = Record<string, unknown> & { id: string; status: string };
/** A platform job's view, as the server narrows it (lib/higgsfield-consumer/client-view.ts). */
const platform = (credits: number) => ({ workspaceId: null, workspaceName: null, providerJobId: null, providerReceipt: null, quoteCredits: credits,
  creditUnit: 'particl_credits', chargeTerms: { credits, onFailure: 'charged' } });
/** A collected original as a client sees it: no provider id and no account price. */
const original = (generationId: string) => ({ generationId, bytes: 4096, sha256: 'e'.repeat(64), width: 720, height: 1280, seconds: 12,
  asset: { generationId, url: `/api/media/${generationId}`, kind: 'video', mime: 'video/mp4', width: 720, height: 1280, durationS: 12 } });

async function fixture(page: Page, project: Project, saved: Partial<Record<'video' | 'shorts' | 'marketing-templates', Job[]>> = {}) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  // A member, not the owner, of a workspace on the platform's keys.
  Object.assign(me, { owner: false, role: 'member' });
  me.workspace = { ...me.workspace, platformKeys: true };
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let revision = 1;
  const jobs: Record<string, Job[]> = { video: [...(saved.video ?? [])], shorts: [...(saved.shorts ?? [])], 'marketing-templates': [...(saved['marketing-templates'] ?? [])] };
  const posts: Record<string, unknown>[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [], connectionReads: string[] = [];
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
    if (path.startsWith('/api/media/')) return route.fulfill({ path: 'public/fixtures/clip.mp4', contentType: 'video/mp4' });
    if (/^\/api\/uploads\/[^/]+$/.test(path)) return route.fulfill({ body: pixel, contentType: path.includes('launch') ? 'video/mp4' : 'image/png' });
    /* The tool panels never ask for a member's own connection here (the route's websiteTools answer decides);
       the page around Shorts still reads the signed-in owner's, as it always has, and none is connected. */
    if (path === '/api/higgsfield/consumer/connection') { connectionReads.push(new URL(request.frame().url()).pathname); return json({ connected: false }); }
    const tool = path.match(/^\/api\/higgsfield\/consumer\/(video|shorts|marketing-templates)$/)?.[1];
    if (tool) {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      const list = jobs[tool];
      if (request.method() === 'GET') return json({ websiteTools: { managed: true, available: true }, jobs: [...list].reverse(),
        ...(tool === 'shorts' ? { capabilities: { shorts: true, aspectRatios: ['9:16', '16:9'], resolution: '720p', minSourceSeconds: 4, maxSourceSeconds: 120, maxClips: 20, cancel: false } } : {}) });
      const body = request.postDataJSON(); posts.push({ tool, ...body });
      if (body.action === 'presets') return json({ presets: { presets: [{ id: presetId, source: 'cms', name: 'Bold Urban' }], complete: true, fetchedAt: Date.now() } });
      if (body.action === 'catalogue') return json({ catalogue: { templates: [{ id: 'tpl_ugc_unboxing_01', name: 'UGC unboxing', category: 'ugc', description: 'A creator unboxes the product.', previewUrl: null, outputKind: 'video', inputs: [], credits: null, priceSource: null }],
        matched: 1, total: 1, loaded: 1, complete: true, fetchedAt: Date.now(), categories: ['ugc'], costsVersion: null } });
      const id = body.action === 'quote' ? `11111111-1111-4111-8111-${String(posts.length).padStart(12, '0')}` : body.id;
      if (body.action === 'quote') {
        const base = { id, draftId: project.id, status: 'quoted', input: body.input, quoteExpiresAt: Date.now() + 300000, result: null, createdAt: Date.now(), failureCode: null };
        const job: Job = tool === 'video' ? { ...base, ...platform(15) }
          : tool === 'shorts' ? { ...base, ...platform(21), source: { kind: 'video', name: 'Launch cut.mp4' }, pricedSeconds: 31, priceSource: 'get_cost', clips: [], settlement: null }
          : { ...base, ...platform(9), template: { id: 'tpl_ugc_unboxing_01', name: 'UGC unboxing', category: 'ugc', previewUrl: null }, outputKind: 'video', priceSource: 'get_cost', costsVersion: null };
        list.push(job); return json({ job });
      }
      const job = list.find(item => item.id === id)!;
      if (body.action === 'submit') {
        // Approved by the workspace's own credits alone: no wallet is named.
        expect(Object.keys(body).sort()).toEqual(['action', 'credits', 'draftId', 'id']);
        expect(body.credits).toBe((job.chargeTerms as { credits: number }).credits);
        job.status = 'accepted'; return json({ job });
      }
      if (body.action === 'status') {
        job.status = 'completed';
        if (tool === 'shorts') {
          job.clips = [
            { index: 0, providerJobId: null, state: 'collected', availability: 'available', original: original(clips[0]) },
            { index: 1, providerJobId: null, state: 'failed', reason: 'failed' },
            { index: 2, providerJobId: null, state: 'collected', availability: 'available', original: original(clips[1]) },
          ];
          job.settlement = { clips: 3, collected: 2, failed: 1, credits: 21, creditUnit: 'particl_credits' };
        } else {
          job.result = { original: original(tool === 'video' ? video : variant) };
          job.originalAvailable = true; job.originalAvailability = 'available';
        }
        return json({ job, pollAfterSeconds: 15 });
      }
    }
    if (path === '/api/workbench/projects') {
      if (request.method() === 'PUT') {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project: !url.searchParams.get('id') || url.searchParams.get('id') === project.id ? project : null, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === '/api/workbench/library') return json({ uploads: url.searchParams.get('source') === 'generations' ? [] : uploads, generations: [], nextCursor: null, nextPageCursor: null });
    if (path === '/api/uploads') return json({ uploads, nextCursor: null, nextPageCursor: null });
    for (const upload of uploads) if (path === `/api/uploads/${upload.id}/metadata`) return json({ upload });
    if (path === '/api/jobs') return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === '/api/workbench/atomik' || path === '/api/workbench/development') return json({ configured: false, models: [], jobs: [] });
    if (path === '/api/pipelines') return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: '', music: '' } });
    if (path === '/api/atomik') return json({ chats: [], models: { featured: [], rest: [] }, engines: [] });
    if (path === '/api/projects') return json({ projects: [] });
    if (path === '/api/engines') return json({ engines: [], models: [], vendors: [] });
    if (path === '/api/settings') return json({ settings: {}, models: { image: '', video: '', text: {} } });
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return json({ error: 'No other mutation permitted.' }, 409); }
    return json({});
  });
  return { posts, unexpected, external, errors, connectionReads };
}
const uploads = [
  { id: 'launch-original', filename: 'Launch cut.mp4', kind: 'video', mime: 'video/mp4', bytes: 4000, width: 640, height: 360, durationS: 31, sha256: 'e'.repeat(64), createdAt: Date.now(), url: '/api/uploads/launch-original' },
];
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
/** No account wording anywhere in a managed workspace's tool. */
async function neutral(region: Locator) {
  expect((await region.innerText()).toLowerCase()).not.toMatch(/connected (credit|account|cr)|wallet|higgsfield|supercomputer/);
}
/** A price is never cut short, and a phone's approve button is a full thumb target. */
async function priceWhole(page: Page, price: Locator, approve: Locator) {
  expect(await price.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).textOverflow !== 'ellipsis')).toBe(true);
  if (page.viewportSize()!.width < 900) expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
}

test('a member makes a marketing video in the workspace’s credits, told before approving that a failed video is still charged', async ({ page }) => {
  const project: Project = { ...seedProject(), id: 'managed-campaign', name: 'Managed campaign', nodes: [], productionProjectId: 'managed-production',
    moleculr: { ...EMPTY_MOLECULR, productName: 'Our bottle', hooks: ['A considered opening'], creative: { kind: 'video', path: 'prompt', category: 'motion', aspect: '16:9', direction: 'A warm product scene.', seconds: 15 } } };
  const state = await fixture(page, project);
  await page.goto(await legacyShell(page, '/workbench?project=managed-campaign&suite=moleculr&page=variants'));
  const panel = page.getByRole('region', { name: 'Marketing Video', exact: true });
  await expect(panel.getByText('Website tools · Video', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Get video quote', exact: true }).click();
  const quote = panel.getByLabel('Video quote', { exact: true });
  await expect(quote.getByText('15 credits', { exact: true })).toBeVisible();
  // Said before approval: the approved price stands whether the video succeeds or fails.
  await expect(quote.getByRole('note')).toHaveText('15 credits are charged even if the video fails.');
  const approve = quote.getByRole('button', { name: 'Generate video · 15 credits', exact: true });
  await expect(approve).toBeDisabled();
  await priceWhole(page, quote.getByText('15 credits', { exact: true }), approve);
  await neutral(panel);
  await noOverflow(page);
  await quote.getByRole('checkbox', { name: 'Charge 15 credits for this video, even if it fails.', exact: true }).check();
  await approve.click();
  const card = panel.getByLabel('Saved video jobs', { exact: true }).locator('article').first();
  await expect(card.getByText('Video in progress', { exact: true })).toBeVisible();
  await expect(card.getByText('15 credits', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Check video result', exact: true }).click();
  await expect(card.getByText('Original ready', { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Download original', exact: true })).toHaveAttribute('href', `/api/media/${video}?download=1`);
  await neutral(panel);
  await noOverflow(page);
  expect(state.posts.map(post => post.action)).toEqual(['quote', 'submit', 'status']);
  expect(state.connectionReads).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('a lost reply stays unconfirmed and gates new work until a member recovers it from its saved record; it is never sent again', async ({ page }) => {
  const project: Project = { ...seedProject(), id: 'managed-recovery', name: 'Managed recovery', nodes: [], productionProjectId: 'managed-recovery-production',
    moleculr: { ...EMPTY_MOLECULR, productName: 'Our bottle', creative: { kind: 'video', path: 'prompt', category: 'motion', aspect: '16:9', direction: 'A warm product scene.', seconds: 15 } } };
  // Its reply was saved on the server: the page learns only that it exists, never its contents.
  const lost: Job = { id: '11111111-1111-4111-8111-00000000feed', draftId: project.id, status: 'uncertain', receiptSaved: true, ...platform(15),
    input: { prompt: 'A plain bottle.', duration: 15, resolution: '720p', aspectRatio: '16:9', generateAudio: true, mode: 'product_showcase' },
    quoteExpiresAt: Date.now() + 300000, result: null, createdAt: Date.now(), failureCode: null };
  const state = await fixture(page, project, { video: [lost] });
  await page.goto(await legacyShell(page, '/workbench?project=managed-recovery&suite=moleculr&page=variants'));
  const panel = page.getByRole('region', { name: 'Marketing Video', exact: true });
  const card = panel.getByLabel('Saved video jobs', { exact: true }).locator('article').first();
  await expect(card.getByText('Submission needs reconciliation', { exact: true })).toBeVisible();
  await expect(card.getByText('15 credits', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Get video quote', exact: true })).toBeDisabled();
  await expect(panel.getByRole('status').filter({ hasText: 'It is never sent again: check it below.' })).toBeVisible();
  const recover = card.getByRole('button', { name: 'Recover saved video request', exact: true });
  if (page.viewportSize()!.width < 900) expect((await recover.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await neutral(panel);
  await noOverflow(page);
  await recover.click();
  await expect(card.getByText('Original ready', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Get video quote', exact: true })).toBeEnabled();
  expect(state.posts).toEqual([{ tool: 'video', action: 'status', draftId: project.id, id: lost.id }]);
  expect(state.connectionReads).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('a member makes shorts in the workspace’s credits: one price for the set, charged even if it yields no clip', async ({ page }) => {
  const project: Project = { ...newProject('Viral launch'), id: 'managed-shorts', productionProjectId: 'managed-shorts-production' };
  const state = await fixture(page, project);
  await page.goto(await legacyShell(page, '/subatomik?project=managed-shorts&page=shorts'));
  const panel = page.getByRole('region', { name: 'Shorts on the website tools', exact: true });
  await expect(panel.getByText('Website tools', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Load styles', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Style', exact: true }).selectOption(`cms:${presetId}`);
  const source = page.locator('[data-library-id="upload:launch-original"]');
  await expect(source).toBeVisible();
  if (page.viewportSize()!.width < 760) {
    await source.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: 'Use as reference', exact: true }).click();
  } else await source.getByRole('button', { name: 'Use as reference', exact: true }).click();
  await panel.getByRole('checkbox', { name: /copied to Particl’s website tools/ }).check();
  await panel.getByRole('button', { name: 'Get quote', exact: true }).click();
  const quote = panel.getByLabel('Shorts quote', { exact: true });
  await expect(quote.getByText('21 credits', { exact: true })).toBeVisible();
  await expect(quote.getByRole('note')).toHaveText('21 credits are charged even if the session fails.');
  const approve = quote.getByRole('button', { name: 'Make shorts · 21 credits', exact: true });
  await priceWhole(page, quote.getByText('21 credits', { exact: true }), approve);
  await neutral(panel);
  await noOverflow(page);
  await quote.getByRole('checkbox', { name: 'Charge 21 credits for this set of shorts, even if it yields no clip.', exact: true }).check();
  await approve.click();
  const sessions = page.getByRole('region', { name: 'Saved Shorts sessions', exact: true });
  const card = sessions.locator('article').first();
  await expect(card.getByText('In progress', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(card.getByText('2 of 3 clips ready', { exact: true })).toBeVisible();
  await expect(card).toContainText('1 clip failed; the session was charged once, as quoted.');
  await expect(card.getByRole('link', { name: 'Download clip', exact: true })).toHaveCount(2);
  await neutral(sessions);
  await noOverflow(page);
  expect(state.posts.map(post => post.action)).toEqual(['presets', 'quote', 'submit', 'status']);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('a member runs a video template in the workspace’s credits, told before approving that a failed run is still charged', async ({ page }) => {
  const project: Project = { ...seedProject(), id: 'managed-templates', name: 'Managed templates', nodes: [], productionProjectId: 'managed-templates-production',
    moleculr: { ...EMPTY_MOLECULR, productName: 'Our bottle', productDescription: 'A reusable bottle.' } };
  const state = await fixture(page, project);
  await page.goto(await legacyShell(page, '/workbench?project=managed-templates&suite=moleculr&page=format'));
  const browser = page.getByRole('region', { name: 'Template catalogue', exact: true });
  await browser.getByRole('list', { name: 'Templates', exact: true }).getByRole('button', { name: /UGC unboxing/ }).click();
  await neutral(browser);
  await page.getByRole('navigation', { name: 'Marketing Studio sections', exact: true }).getByRole('link', { name: 'Variants', exact: true }).click();
  const creator = page.getByRole('region', { name: 'Create with template', exact: true });
  await creator.getByRole('button', { name: 'Get quote', exact: true }).click();
  const quote = creator.getByLabel('Template quote', { exact: true });
  await expect(quote.getByText('9 credits', { exact: true })).toBeVisible();
  await expect(quote.getByRole('note')).toHaveText('9 credits are charged even if the template run fails.');
  const approve = quote.getByRole('button', { name: 'Create with template · 9 credits', exact: true });
  await priceWhole(page, quote.getByText('9 credits', { exact: true }), approve);
  await neutral(creator);
  await noOverflow(page);
  await quote.getByRole('checkbox', { name: 'Charge 9 credits for this template run, even if it fails.', exact: true }).check();
  await approve.click();
  const card = creator.getByLabel('Saved template jobs', { exact: true }).locator('article').first();
  await expect(card).toContainText('In progress');
  await card.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(card).toContainText('Original ready');
  await neutral(creator);
  await noOverflow(page);
  expect(state.posts.map(post => post.action)).toEqual(['catalogue', 'quote', 'submit', 'status']);
  expect(state.connectionReads).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
