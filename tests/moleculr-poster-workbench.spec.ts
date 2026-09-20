import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { signInLocally } from './helpers/workbenchLocal';
import { seedProject, type Project } from '../lib/workbench/studio';
import { saveSchema } from '../lib/workbench/studio-schema';
import { legacyShell } from "./helpers/legacyShell";

test.use({ actionTimeout: 12000 });

test('poster layers persist, export a full-size PNG and save a reusable original without provider calls', async ({ page }, info) => {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: 'poster-workflow', name: 'Poster workflow', productionProjectId: 'poster-production' };
  let revision = 1;
  const providerCalls: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/workbench/projects') {
      if (request.method() === 'PUT') {
        expect(request.headers()['x-workbench-scope']).toBe(scope);
        const saved = saveSchema.parse(request.postDataJSON()); project = saved.project as Project;
        return route.fulfill({ json: { revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} } });
      }
      return route.fulfill({ json: { project, projects: [{ id: project.id, name: project.name }], productions: [], revision } });
    }
    if (url.pathname === '/api/workbench/atomik' || url.pathname === '/api/workbench/development') return route.fulfill({ json: { configured: false, models: [], jobs: [] } });
    if (url.pathname === '/api/jobs') return route.fulfill({ json: { generations: [] } });
    if (url.pathname === '/api/atomik') return route.fulfill({ json: { chats: [], models: { featured: [], rest: [] }, engines: [] } });
    if (url.pathname === '/api/generate' || url.pathname === '/api/audio') { providerCalls.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  await page.goto(await legacyShell(page, '/workbench?project=poster-workflow&suite=moleculr&page=design'));
  await page.getByRole('button', { name: 'Create a poster', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Poster designer', exact: true })).toBeVisible();
  await page.getByLabel('Design name', { exact: true }).fill('Launch poster');
  await page.getByLabel('Background', { exact: true }).fill('#123456');
  await page.getByRole('button', { name: 'Headline', exact: true }).click();
  await page.getByLabel('Layer text', { exact: true }).fill('Made with intention');
  await page.getByLabel('Image from library', { exact: true }).selectOption('hero');
  await page.getByRole('button', { name: 'Add image layer', exact: true }).click();
  await expect.poll(() => project.moleculr?.poster?.layers.length).toBe(3);
  await expect(page.getByRole('button', { name: 'Export PNG', exact: true })).toBeEnabled();
  const downloading = page.waitForEvent('download', { timeout: 20000 });
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const download = await downloading;
  const path = info.outputPath('poster-1728x2160.png'); await download.saveAs(path);
  const metadata = await sharp(path).metadata(); expect(metadata.width).toBe(1728); expect(metadata.height).toBe(2160); expect(metadata.format).toBe('png');
  const pixel = await sharp(path).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer(); expect([...pixel]).toEqual([0x12,0x34,0x56]);
  await page.getByRole('button', { name: 'Save poster to library', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Poster saved in the project library' })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => project.assets.some(asset => asset.category === 'Campaign design' && !!asset.uploadId)).toBe(true);
  const saved = project.assets.find(asset => asset.category === 'Campaign design')!;
  expect(saved.refs).toEqual(['hero']); expect(saved.mime).toBe('image/png'); expect(saved.url).toMatch(/^\/api\/uploads\//);
  await page.reload();
  await expect(page.getByLabel('Design name', { exact: true })).toHaveValue('Launch poster');
  await page.getByRole('button', { name: 'Headline', exact: true }).click();
  await expect(page.getByLabel('Layer text', { exact: true })).toHaveValue('Made with intention');
  await expect.poll(() => page.getByLabel('Poster preview', { exact: true }).evaluate((element: HTMLCanvasElement) => [...element.getContext('2d')!.getImageData(0, 0, 1, 1).data])).toEqual([0x12, 0x34, 0x56, 255]);
  await page.screenshot({ path: info.outputPath('poster-editor.png'), fullPage: true });
  expect(providerCalls).toEqual([]); expect(errors).toEqual([]);
});
