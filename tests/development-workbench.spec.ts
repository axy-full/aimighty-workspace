import { goWorkbenchStage as goStage } from "./helpers/workbenchNavigation";
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signInLocally } from './helpers/workbenchLocal';
import { screenplayPdf } from './helpers/screenplayPdf';
import { newProject, type Project } from '../lib/workbench/studio';
import { sourceCanonical, type DevelopmentJob, type DevelopmentRequest, type DevelopmentResult } from '../lib/workbench/development-types';
import { developmentPendingKey } from '../lib/workbench/development-client';
import { legacyShell } from "./helpers/legacyShell";

const efforts = [{ value: 'low', label: 'Low', description: 'Faster planning' }, { value: 'high', label: 'High', description: 'More time for complex planning' }];
const models = [
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', vision: true, efforts },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', vision: true, efforts },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', vision: true, efforts },
];


/** Visible text under the 12px phone floor inside `root`. */
function underFloor(root: Locator) {
  return root.evaluate(element => Array.from(element.querySelectorAll('*'))
    .filter(el => (el as HTMLElement).offsetParent !== null && Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()))
    .filter(el => Number.parseFloat(getComputedStyle(el).fontSize) < 12)
    .map(el => `${getComputedStyle(el).fontSize}: ${el.textContent?.trim().slice(0, 30)}`));
}
function scopePanel(page: Page, kind: DevelopmentRequest['kind']) {
  return page.getByRole('region', { name: kind === 'idea' ? 'Idea development' : kind === 'adfilm' ? 'Ad-film breakdown' : 'Screenplay breakdown', exact: true });
}
async function choose(page: Page, panel: Locator, provider: 'Claude' | 'GPT', model: string, effort = 'High') {
  await panel.getByRole('group', { name: /provider$/ }).getByRole('button', { name: new RegExp('^' + provider) }).click();
  await panel.getByRole('button', { name: /model$/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a thinking model', exact: true });
  await expect(picker.getByRole('option', { name: 'Auto', exact: true })).toHaveCount(0);
  await picker.getByRole('option', { name: model, exact: true }).click();
  await panel.getByRole('combobox', { name: /effort$/ }).click();
  await page.getByRole('option', { name: new RegExp('^' + effort) }).click();
}

async function fixture(page: Page, options: { loseFirst?: boolean; grok?: boolean } = {}) {
  const offered = options.grok ? [...models, { id: 'spacexai/grok-4', name: 'Grok 4', vision: true, efforts: [{ value: 'auto', label: 'Provider default' }] }] : models;
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { 'X-Workbench-Scope': scope };
  const project = newProject('Agentic studio browser fixture');
  project.brief = 'Create a tactile thirty-second film about a ceramic lamp that brings warmth to an empty home.';
  project.audience = 'Design-conscious adults'; project.deliverables = '30-second hero film and 15-second cutdown';
  const saved = await page.request.put('/api/workbench/projects', { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), { key: scope, id: project.id });
  async function current() {
    const response = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).project as Project;
  }
  const jobs: DevelopmentJob[] = [], quotes: (DevelopmentRequest & { source: Project })[] = [], submissions: string[] = [];
  const resultPages = new Map<string, DevelopmentResult[]>();
  let lost = false, paid = 0;
  let delayedRead: { started: () => void; wait: Promise<void> } | null = null;
  function holdNextRead() {
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const entering = new Promise<void>(resolve => { started = resolve; });
    delayedRead = { started, wait };
    return { release, entering };
  }
  await page.route('**/api/workbench/atomik**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models, jobs: [] }) }));
  await page.route(/\/api\/(generate|audio)$/, route => { paid++; return route.abort('blockedbyclient'); });
  await page.route('**/api/workbench/development**', async route => {
    const request = route.request();
    expect(request.headers()['x-workbench-scope']).toBe(scope);
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (request.method() === 'GET') {
      const query = new URL(request.url()).searchParams;
      if (query.has('jobId')) {
        const job = jobs.find(value => value.id === query.get('jobId'));
        const pages = resultPages.get(job?.id ?? ''), offset = Number(query.get('offset'));
        expect(job).toBeTruthy();
        expect(pages?.[offset]).toBeTruthy();
        return json({ job: { ...job!, result: pages![offset], resultPage: { offset, totalChunks: pages!.length, hasMore: offset < pages!.length - 1 } } });
      }
      /* As the route: every kind of the project's runs, or the one request asked for by `requestId`. */
      const captured = structuredClone(jobs).filter(job => !query.has('requestId') || job.requestId === query.get('requestId')), held = delayedRead;
      delayedRead = null;
      if (held) { held.started(); await held.wait; }
      return json({ configured: true, models: offered, jobs: captured });
    }
    const body = request.postDataJSON() as DevelopmentRequest & { quoteOnly?: boolean; resume?: boolean };
    expect(body.projectId).toBe(project.id);
    expect(body.resume).not.toBe(true);
    const source = await current();
    const sourceHash = createHash('sha256').update(sourceCanonical(source, body.kind)).digest('hex');
    if (body.quoteOnly) {
      quotes.push({ ...body, source });
      return json({ quoteOnly: true, model: body.model, effort: body.effort, kind: body.kind, sourceHash, estimateCredits: 7, chunks: body.kind === 'adfilm' ? 2 : 1, calls: body.kind === 'adfilm' ? 6 : 3, sourceCharacters: body.kind === 'idea' ? source.brief.length : source.script?.length ?? 0 });
    }
    submissions.push(request.postData()!);
    expect(body.sourceHash).toBe(sourceHash);
    expect(body.maxCredits).toBe(7);
    if (options.loseFirst && !lost) { lost = true; return json({ error: 'The provider acknowledgement was lost. Recover this request.' }, 503); }
    const result: DevelopmentResult = {
      summary: body.kind === 'idea' ? 'Two reviewed cinematic directions.' : 'Complete source reviewed with shootable coverage.',
      recommendation: 'Build the film around a visible change in the room.',
      ideas: body.kind === 'idea' ? [
        { title: 'A room becomes a home', logline: 'One pool of light changes an empty room.', treatment: 'Begin with stillness; introduce warm light and a human gesture.', visualDirection: 'Locked wides, tactile details and motivated practical warmth.', critique: 'The human gesture needs to remain specific.' },
        { title: 'The hands behind the light', logline: 'A maker gives form to warmth.', treatment: 'Follow the lamp from clay to its place in a home.', visualDirection: 'Macro clay texture followed by calm domestic framing.', critique: 'Avoid compressing the making process into a generic montage.' },
      ] : [],
      scenes: body.kind === 'idea' ? [] : [{ id: 'source-1', heading: body.kind === 'adfilm' ? 'AD SEQUENCE · PRODUCT REVEAL' : 'INT. TEST STUDIO - DAY', sourceStart: 0, sourceEnd: source.script!.length, summary: 'Establish the room, then reveal the lamp.', beats: ['Hold the empty room.', 'Introduce the warm practical.'], shots: [{ description: 'Wide reveal of the lamp in the room.', framing: 'Wide, eye-level', movement: 'Locked frame', lighting: 'Warm practical against a cool ambient base', sound: 'A quiet room tone and switch click' }], characters: ['MAKER'], props: ['Ceramic lamp'], locations: ['Studio'], productionNotes: ['Preserve the practical level across coverage.'] }],
      critique: ['Keep the product legible in the final frame.'], assumptions: ['The proposed coverage is a creative suggestion.'],
    };
    const job: DevelopmentJob = { id: `development-${jobs.length + 1}`, requestId: body.requestId, projectId: project.id, productionProjectId: source.productionProjectId ?? null, kind: body.kind, model: body.model, effort: body.effort, instructions: body.instructions ?? '', sourceHash, status: 'succeeded', completedChunks: 1, totalChunks: 1, currentStage: 'complete', completedSteps: 3, totalSteps: 3, estimateCredits: 7, credits: 5, result, error: null, createdAt: Date.now(), updatedAt: Date.now() };
    if (body.kind === 'adfilm') {
      const boundary = source.script!.indexOf('05–30s');
      expect(boundary).toBeGreaterThan(0);
      const first = { ...result, scenes: [{ ...result.scenes[0], sourceEnd: boundary }] };
      const second = { ...result, summary: 'The final product reveal and end frame.', scenes: [{ ...result.scenes[0], id: 'source-2', heading: 'AD SEQUENCE · END FRAME', sourceStart: boundary, sourceEnd: source.script!.length }] };
      resultPages.set(job.id, [first, second]);
      Object.assign(job, { result: first, resultPage: { offset: 0, totalChunks: 2, hasMore: true }, completedChunks: 2, totalChunks: 2, completedSteps: 6, totalSteps: 6 });
    }
    jobs.unshift(job);
    return json({ job }, 202);
  });
  return { current, jobs, quotes, submissions, paid: () => paid, scope, projectId: project.id, holdNextRead };
}

test('agentic screenplay and ad-film imports offer Claude and ChatGPT, persist reviewed scenes and reject stale results', async ({ page }, info) => {
  test.skip(!['workbench-360x640', 'workbench-1440x900'].includes(info.project.name), 'bounded agentic development browser coverage');
  const f = await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(await legacyShell(page, '/workbench'));
  await goStage(page, 'brief');
  await page.locator('.stage-scroll').filter({ visible: true }).evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('script-import-options.png'), fullPage: true });
  await expect(page.getByRole('group', { name: 'Script format', exact: true }).getByRole('button', { name: /^Screenplay/ })).toHaveAttribute('aria-pressed', 'true');
  if (page.viewportSize()!.width < 760) expect(await underFloor(page.getByRole('group', { name: 'Script format', exact: true }))).toEqual([]);
  const bytes = screenplayPdf([['INT. TEST STUDIO - DAY', 'A maker sets a ceramic lamp on the table.', 'Warm light fills the empty room.']]);
  await page.getByLabel('Import screenplay file', { exact: true }).setInputFiles({ name: 'Complete screenplay.pdf', mimeType: 'application/pdf', buffer: bytes });
  const imported = page.getByRole('region', { name: 'Review screenplay import', exact: true });
  await expect(imported).toContainText('1 PDF pages');
  await imported.getByRole('button', { name: 'Import complete screenplay', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project screenplay', exact: true })).toContainText('A maker sets a ceramic lamp');
  await expect.poll(async () => (await f.current()).scriptSource?.filename).toBe('Complete screenplay.pdf');
  const original = (await f.current()).assets.find(asset => asset.name === 'Complete screenplay.pdf')!;
  expect(await page.request.get(original.url).then(response => response.body())).toEqual(bytes);
  let panel = scopePanel(page, 'screenplay');
  await panel.getByRole('group', { name: /provider$/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('script-agent-controls.png'), fullPage: true });
  await choose(page, panel, 'Claude', 'Claude Sonnet 4.6');
  await panel.getByRole('textbox', { name: 'Screenplay breakdown instructions', exact: true }).fill('Prioritize motivated lighting and a clear visual reveal.');
  await panel.getByRole('button', { name: 'Review development estimate', exact: true }).click();
  await expect(panel).toContainText('3 agent steps');
  expect(f.quotes.at(-1)).toMatchObject({ kind: 'screenplay', model: 'anthropic/claude-sonnet-4.6', effort: 'high' });
  await panel.getByRole('button', { name: 'Start script breakdown', exact: true }).click();
  await expect(panel).toContainText('Complete source reviewed with shootable coverage.');
  if (page.viewportSize()!.width < 760) {
    await panel.locator('details').evaluateAll(list => list.forEach(el => { (el as HTMLDetailsElement).open = true; }));
    expect(await underFloor(panel)).toEqual([]);
  }
  await panel.getByRole('button', { name: 'Add 1 scene node', exact: true }).click();
  await expect.poll(async () => (await f.current()).nodes.filter(node => node.developmentSource?.jobId === f.jobs[0].id).length).toBe(1);
  await page.reload();
  await goStage(page, 'brief');
  panel = scopePanel(page, 'screenplay');
  await expect(panel.getByRole('button', { name: 'Add 0 scene nodes', exact: true })).toBeDisabled();
  await page.getByRole('group', { name: 'Script format', exact: true }).getByRole('button', { name: /^Ad-film script/ }).click();
  await page.getByLabel('Import ad-film script file', { exact: true }).setInputFiles({ name: 'Lamp commercial.txt', mimeType: 'text/plain', buffer: Buffer.from('00–05s · OPEN\nVISUAL: An empty room.\nAUDIO: Room tone.\n\n05–30s · REVEAL\nVISUAL: The lamp turns on. End on the product.\nVO: Bring warmth home.') });
  await imported.getByRole('checkbox', { name: /^Replace the current script/ }).check();
  await imported.getByRole('button', { name: 'Import complete ad-film script', exact: true }).click();
  await expect.poll(async () => (await f.current()).scriptSource?.filename).toBe('Lamp commercial.txt');
  panel = scopePanel(page, 'adfilm');
  await choose(page, panel, 'GPT', 'GPT-5.5');
  await panel.getByRole('button', { name: 'Review development estimate', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Start script breakdown', exact: true })).toBeVisible();
  expect(f.quotes.at(-1)).toMatchObject({ kind: 'adfilm', model: 'openai/gpt-5.5', effort: 'high', source: { scriptFormat: 'adfilm' } });
  await panel.getByRole('button', { name: 'Start script breakdown', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Add 1 scene node', exact: true })).toBeEnabled();
  await expect(panel).toContainText('Source section 1 of 2');
  await panel.getByRole('button', { name: 'Next source section', exact: true }).click();
  await expect(panel).toContainText('Source section 2 of 2');
  await expect(panel).toContainText('AD SEQUENCE · END FRAME');
  await expect(panel.getByRole('button', { name: 'Next source section', exact: true })).toBeDisabled();
  await page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/development' && response.request().method() === 'GET' && !new URL(response.url()).searchParams.has('jobId'));
  await expect(panel).toContainText('Source section 2 of 2');
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download complete breakdown', exact: true }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(`adfilm-${f.jobs[0].id}.json`);
  const complete = JSON.parse(await readFile((await downloaded.path())!, 'utf8')) as DevelopmentJob;
  expect(complete.resultPage).toBeUndefined();
  expect(complete.result?.scenes.map(scene => scene.id)).toEqual(['source-1', 'source-2']);
  expect(complete.result?.scenes[0].sourceStart).toBe(0);
  expect(complete.result?.scenes[0].sourceEnd).toBe(complete.result?.scenes[1].sourceStart);
  expect(complete.result?.scenes[1].sourceEnd).toBe((await f.current()).script!.length);
  await panel.getByRole('button', { name: 'Previous source section', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('agentic-paginated-breakdown.png'), fullPage: true });
  await page.getByRole('textbox', { name: 'Project ad-film script', exact: true }).fill('A changed commercial script requiring a fresh breakdown.');
  await expect(panel).toContainText('The source or creative brief has changed since this run.');
  await expect(panel.getByRole('button', { name: 'Add 1 scene node', exact: true })).toBeDisabled();
  expect(f.submissions).toHaveLength(2);
  expect(f.paid()).toBe(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('agentic-script-development.png'), fullPage: true });
});

test('idea development recovers the exact request after a lost response and reload, then saves the selected direction once', async ({ page }, info) => {
  test.skip(!['workbench-360x640', 'workbench-1440x900'].includes(info.project.name), 'bounded recovery browser coverage');
  const f = await fixture(page, { loseFirst: true });
  await page.goto(await legacyShell(page, '/workbench'));
  await goStage(page, 'brief');
  let panel = scopePanel(page, 'idea');
  await choose(page, panel, 'GPT', 'GPT-5.5');
  await panel.getByRole('group', { name: /provider$/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('idea-agent-controls.png'), fullPage: true });
  await panel.getByRole('textbox', { name: 'Idea development instructions', exact: true }).fill('Give the product a human emotional context.');
  await panel.getByRole('button', { name: 'Review development estimate', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Start idea development', exact: true })).toBeVisible();
  // This poll starts before the ambiguous submission and returns afterwards.
  const held = f.holdNextRead();
  await held.entering;
  await panel.getByRole('button', { name: 'Start idea development', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Recover development request', exact: true })).toBeEnabled();
  const oldPoll = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/development' && response.request().method() === 'GET' && !new URL(response.url()).searchParams.has('requestId'));
  held.release();
  await oldPoll;
  await expect(panel.getByRole('button', { name: 'Recover development request', exact: true })).toBeEnabled();
  expect(f.submissions).toHaveLength(1);
  const first = f.submissions[0];
  await expect(panel.getByRole('group', { name: /provider$/ }).getByRole('button').first()).toBeDisabled();
  await page.reload();
  await goStage(page, 'brief');
  panel = scopePanel(page, 'idea');
  await expect(panel).toContainText('Recovery uses GPT-5.5 · High · up to 7 credits.');
  await panel.getByRole('button', { name: 'Recover development request', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('agentic-recovery-controls.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Recover development request', exact: true }).click();
  await expect(panel).toContainText('Two reviewed cinematic directions.');
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]).toBe(first);
  expect(JSON.parse(first)).toMatchObject({ kind: 'idea', model: 'openai/gpt-5.5', effort: 'high', maxCredits: 7 });
  await panel.getByRole('button', { name: 'Add to creative direction', exact: true }).first().click();
  await expect.poll(async () => (await f.current()).direction).toContain('A room becomes a home');
  const applied = await f.current();
  expect(applied.developmentApplications).toEqual([`${f.jobs[0].id}:idea:0`]);
  await page.reload();
  await goStage(page, 'brief');
  await expect(page.getByRole('textbox', { name: 'Creative direction', exact: true })).toHaveValue(applied.direction);
  await expect(scopePanel(page, 'idea').getByRole('button', { name: 'Add to creative direction', exact: true }).first()).toBeDisabled();
  expect(f.paid()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('agentic-idea-development.png'), fullPage: true });
  await page.evaluate(key => localStorage.setItem(key, '{malformed recovery record'), developmentPendingKey(f.scope, f.projectId));
  await page.reload();
  await goStage(page, 'brief');
  panel = scopePanel(page, 'idea');
  await expect(panel).toContainText('Two reviewed cinematic directions.');
  await expect(panel).toContainText('new paid requests remain paused');
  await expect(panel.getByRole('button', { name: 'Review development estimate', exact: true })).toBeDisabled();
  expect(f.submissions).toHaveLength(2);
});

test('an agent run on the project neither blocks nor relabels the idea panel, and Grok is offered when connected', async ({ page }, info) => {
  test.skip(!['workbench-360x640', 'workbench-1440x900'].includes(info.project.name), 'bounded agentic development browser coverage');
  const f = await fixture(page, { grok: true });
  /* The Production agent is writing storyboard frames, and its own unconfirmed request sits in the project's shared recovery slot. */
  const frames = { projectId: f.projectId, requestId: 'agent-frames-request', kind: 'frames', model: 'anthropic/claude-sonnet-4.6', effort: 'auto', sourceHash: 'a'.repeat(64), maxCredits: 4 };
  f.jobs.push({ id: 'development-agent', requestId: 'agent-frames-running', projectId: f.projectId, productionProjectId: null, kind: 'frames', model: 'anthropic/claude-sonnet-4.6', effort: 'auto', instructions: '', sourceHash: 'a'.repeat(64), status: 'running', completedChunks: 0, totalChunks: 1, currentStage: 'draft', completedSteps: 0, totalSteps: 3, estimateCredits: 4, credits: null, result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() });
  await page.addInitScript(({ key, record }) => localStorage.setItem(key, record), { key: developmentPendingKey(f.scope, f.projectId), record: JSON.stringify({ version: 1, scope: f.scope, projectId: f.projectId, body: JSON.stringify(frames) }) });
  await page.goto(await legacyShell(page, '/workbench'));
  await goStage(page, 'brief');
  const panel = scopePanel(page, 'idea');
  const review = panel.getByRole('button', { name: 'Review development estimate', exact: true });
  await expect(review).toBeEnabled();
  await expect(panel).not.toContainText('unconfirmed');
  await expect(panel).not.toContainText('Development in progress');
  const providers = panel.getByRole('group', { name: /provider$/ }).getByRole('button');
  await expect(providers).toHaveText([/^Claude/, /^GPT/, /^Grok/]);
  await providers.filter({ hasText: /^Grok/ }).click();
  await expect(panel.getByRole('button', { name: /model$/ })).toContainText('Grok');
  await review.click();
  await expect(panel.getByRole('button', { name: 'Start idea development', exact: true })).toBeEnabled();
  expect(f.quotes.at(-1)).toMatchObject({ kind: 'idea', model: 'spacexai/grok-4', effort: 'auto' });
  await panel.getByRole('button', { name: 'Start idea development', exact: true }).click();
  await expect(panel).toContainText('Two reviewed cinematic directions.');
  /* The agent's own record was left for the agent to recover. */
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key) ?? 'null', developmentPendingKey(f.scope, f.projectId))).body).toBe(JSON.stringify(frames));
  expect(f.submissions).toHaveLength(1);
  expect(f.paid()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (page.viewportSize()!.width < 760) {
    /* The phone floor: no panel text under 12px (provider notes, labels, run status, section heads). */
    await panel.locator('details').first().evaluate(el => { (el as HTMLDetailsElement).open = true; });
    expect(await underFloor(panel)).toEqual([]);
  }
});

test('notifications remain interactive and model options stay above a live import toast', async ({ page }, info) => {
  test.skip(info.project.name !== 'workbench-360x640', 'phone popup and notification overlap regression');
  const f = await fixture(page);
  await page.goto(await legacyShell(page, '/workbench'));
  await goStage(page, 'brief');
  await page.getByRole('group', { name: 'Script format', exact: true }).getByRole('button', { name: /^Ad-film script/ }).click();
  const panel = scopePanel(page, 'adfilm');
  await panel.getByRole('group', { name: /provider$/ }).getByRole('button', { name: /^GPT/ }).click();
  await page.getByLabel('Import ad-film script file', { exact: true }).setInputFiles({ name: 'Popup layering.txt', mimeType: 'text/plain', buffer: Buffer.from('00–05s · OPEN\nVISUAL: The lamp turns on.\nAUDIO: Room tone.') });
  await page.getByRole('region', { name: 'Review screenplay import', exact: true }).getByRole('button', { name: 'Import complete ad-film script', exact: true }).click();
  const notice = page.locator('[data-sonner-toast][data-visible="true"]').filter({ hasText: 'Complete ad-film script imported.' });
  await expect(notice).toBeVisible();
  // Verify notification pointers before opening the picker. Hover also pauses
  // its dismissal while this assertion runs on slower hosted browsers.
  await notice.hover();
  await expect(notice).toHaveAttribute('data-expanded', 'true');
  expect(await notice.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
  await panel.getByRole('button', { name: /model$/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a thinking model', exact: true });
  const option = picker.getByRole('option', { name: 'GPT-5.5', exact: true });
  await expect(option).toBeVisible();
  await expect(notice).toBeVisible();
  const hit = await option.evaluate(element => {
    const box = element.getBoundingClientRect();
    const toast = [...document.querySelectorAll('[data-sonner-toast][data-visible="true"]')].find(node => node.textContent?.includes('Complete ad-film script imported.'))!.getBoundingClientRect();
    const left = Math.max(box.left, toast.left), right = Math.min(box.right, toast.right);
    const top = Math.max(box.top, toast.top), bottom = Math.min(box.bottom, toast.bottom);
    const overlap = right > left && bottom > top;
    const target = document.elementFromPoint(overlap ? (left + right) / 2 : box.left + box.width / 2, overlap ? (top + bottom) / 2 : box.top + box.height / 2);
    return { overlap, receivesPointer: element.contains(target) };
  });
  expect(hit).toEqual({ overlap: true, receivesPointer: true });
  await option.click();
  await expect(picker).toHaveCount(0);
  await panel.getByRole('combobox', { name: /effort$/ }).click();
  const effort = page.getByRole('option', { name: /^High/ });
  await expect(effort).toBeVisible();
  expect(await effort.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
  await effort.click();
  await expect(panel.getByRole('combobox', { name: /effort$/ })).toContainText('High');
  expect(f.submissions).toEqual([]);
  expect(f.paid()).toBe(0);
});
