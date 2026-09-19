import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signInLocally } from './helpers/workbenchLocal';
import { goWorkbenchStage } from './helpers/workbenchNavigation';
import { newProject, type Project } from '../lib/workbench/studio';
import type { SoulIdentity } from '../lib/workbench/soul-identity';

/** Cast & Elements (four-suites PR F): identity-first cards over a mocked
 * identity list, with identity rendering gated off. Nothing here submits a
 * paid request; training and generation are refused at the route mocks. */
const PROVIDER = /soul|higgsfield|\bfal\b/i;

async function fixture(page: Page) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { 'X-Workbench-Scope': scope };
  const image = await readFile('public/campaign/character.webp');
  const response = await page.request.post('/api/uploads', { headers, multipart: { file: { name: 'Mira original.webp', mimeType: 'image/webp', buffer: image } } });
  expect(response.ok(), await response.text()).toBe(true);
  const uploaded = await response.json();
  const project = newProject('Cast & Elements identity fixture');
  const still = { kind: 'image' as const, url: uploaded.url as string, uploadId: uploaded.id as string, prompt: '', status: 'Draft' as const, locked: false, version: 1, refs: [] };
  project.assets = [
    { ...still, id: 'mira', name: 'Mira', category: 'Character', description: 'Lead', soulIdentityId: 'identity-ready' },
    { ...still, id: 'ravi', name: 'Ravi', category: 'Character', description: 'Support', soulIdentityId: 'identity-training' },
    { ...still, id: 'noor', name: 'Noor', category: 'Character', description: 'No identity yet' },
    { ...still, id: 'lantern', name: 'Brass lantern', category: 'Element', description: 'Hero prop', soulIdentityId: 'identity-failed' },
  ];
  project.nodes = [
    { id: 'mira-node', type: 'character', title: 'Mira on set', assetId: 'mira', x: 40, y: 40, width: 280, linked: [] },
    { id: 'take-node', type: 'generate', title: 'Mira close-up', text: 'A close portrait with soft window light.', x: 390, y: 40, width: 344, linked: ['mira-node'] },
  ];
  const saved = await page.request.put('/api/workbench/projects', { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const base = { projectId: project.id, description: '', subjectType: 'character' as const, references: [{ uploadId: uploaded.id }], previewUrl: uploaded.url, createdAt: 1, updatedAt: 1, creditsBilled: 250, error: null };
  const identities: SoulIdentity[] = [
    { ...base, id: 'identity-ready', name: 'Mira likeness', status: 'ready' },
    { ...base, id: 'identity-training', name: 'Ravi likeness', status: 'training', creditsBilled: null },
    { ...base, id: 'identity-failed', name: 'Lantern identity', subjectType: 'element', status: 'failed', error: 'Training did not complete.' },
  ];
  let reads = 0;
  await page.route('**/api/soul/identities*', route => {
    if (route.request().method() !== 'GET') throw new Error('This UI test must never train an identity.');
    expect(route.request().headers()['x-workbench-scope']).toBe(scope);
    reads++;
    return route.fulfill({ json: { identities, configured: true, generationAvailable: false, terms: { minPhotos: 1, maxPhotos: 40, trainingCredits: 250 } } });
  });
  await page.route(/\/api\/(generate|audio)$/, () => { throw new Error('This UI test must never submit a generation.'); });
  await page.route('**/api/workbench/engines*', route => {
    if (new URL(route.request().url()).searchParams.has('model')) return route.fulfill({ json: { credits: 3 } });
    // Identity rendering is gated off: only ordinary image engines are configured.
    return route.fulfill({ json: { models: [{ id: 'gemini-3-pro-image', label: 'Image Pro', kind: 'image', resolutions: ['1K'], ratios: ['16:9'], durations: [], maxReferenceImages: 8, maxReferenceVideos: 0 }] } });
  });
  async function current() { return (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then(response => response.json())).project as Project; }
  return { scope, project, current, identities, reads: () => reads };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test('Cast & Elements cards show identity state and open the Identity panel from cast and element cards', async ({ page }, info) => {
  const f = await fixture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/workbench');
  await goWorkbenchStage(page, 'characters');
  const cast = page.getByRole('region', { name: 'Cast', exact: true });
  const elements = page.getByRole('region', { name: 'Elements', exact: true });
  const card = (region: typeof cast, name: string) => region.getByRole('article', { name: `Asset: ${name}`, exact: true });
  await expect(card(cast, 'Mira').getByRole('status', { name: 'Identity ready', exact: true })).toBeVisible();
  await expect(card(cast, 'Ravi').getByRole('status', { name: 'Identity training', exact: true })).toBeVisible();
  await expect(card(cast, 'Noor').getByRole('status', { name: 'No identity', exact: true })).toBeVisible();
  await expect(card(elements, 'Brass lantern').getByRole('status', { name: 'Identity failed', exact: true })).toBeVisible();
  expect(f.reads()).toBeGreaterThan(0);
  for (const region of [cast, elements]) expect(await region.textContent()).not.toMatch(PROVIDER);
  await expect(page.getByRole('button', { name: 'Identity', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Element identity', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('cast-elements-states.png') });

  await card(cast, 'Mira').getByRole('button', { name: 'Identity for Mira', exact: true }).click();
  let panel = page.getByRole('dialog', { name: 'Identity', exact: true });
  await expect(panel).toContainText('Attach to Mira');
  await expect(panel).toContainText('Identity rendering is not enabled yet.');
  await expect(panel.getByRole('article', { name: 'Identity: Mira likeness', exact: true }).getByRole('button', { name: 'Attached', exact: true })).toBeDisabled();
  await expect(panel.getByRole('article', { name: 'Identity: Ravi likeness', exact: true }).getByRole('status')).toContainText('Training');
  await expect(panel.getByRole('article', { name: 'Identity: Lantern identity', exact: true }).getByRole('status')).toContainText('Failed');
  expect(await panel.textContent()).not.toMatch(PROVIDER);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('cast-identity-panel.png') });
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0);

  await card(elements, 'Brass lantern').getByRole('button', { name: 'Identity for Brass lantern', exact: true }).click();
  panel = page.getByRole('dialog', { name: 'Identity', exact: true });
  await expect(panel).toContainText('Attach to Brass lantern');
  await expect(panel.getByRole('button', { name: 'Use in Elements', exact: true })).toBeVisible();
  expect(await panel.textContent()).not.toMatch(PROVIDER);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await noOverflow(page);
  expect((await f.current()).assets.map(asset => asset.soulIdentityId)).toEqual(['identity-ready', 'identity-training', undefined, 'identity-failed']);
  expect(errors).toEqual([]);
});

test('a ready identity is the pre-selected reference for its take while identity rendering stays gated', async ({ page }, info) => {
  const f = await fixture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/workbench');
  await goWorkbenchStage(page, 'canvas');
  if (page.viewportSize()!.width < 760) {
    await page.locator('.mobile-node-viewbar').getByRole('tab', { name: 'List', exact: true }).click();
    await page.locator('.mobile-node-list button').filter({ hasText: 'Mira close-up' }).click();
  } else {
    const node = page.getByRole('article', { name: 'Generate node: Mira close-up', exact: true });
    await node.focus(); await node.press('Enter');
  }
  await page.getByRole('button', { name: 'Generate take', exact: true }).click();
  const generation = page.getByRole('dialog', { name: 'Generate a new take', exact: true });
  await expect(generation.getByRole('combobox', { name: 'Generation engine', exact: true })).toHaveValue('gemini-3-pro-image');
  const references = generation.getByRole('list', { name: 'Bound references', exact: true });
  await expect(references.getByRole('listitem')).toHaveCount(1);
  await expect(references.getByRole('listitem').first()).toHaveText('Mira · Identity');
  await expect(references.getByRole('listitem').first()).toHaveAttribute('data-identity', 'ready');
  await expect(generation.getByRole('note')).toHaveText('Identity rendering is awaiting verification; this take uses the identity’s portrait as its reference.');
  await expect(generation.getByRole('combobox', { name: 'Identity', exact: true })).toHaveCount(0);
  await expect(generation.getByRole('button', { name: 'Generate · 3 cr estimated', exact: true })).toBeEnabled();
  expect(await generation.textContent()).not.toMatch(PROVIDER);
  expect(await generation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('cast-identity-generation.png'), animations: 'disabled' });
  await generation.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(generation).toHaveCount(0);
  await noOverflow(page);
  expect((await f.current()).nodes).toHaveLength(2);
  expect(errors).toEqual([]);
});
