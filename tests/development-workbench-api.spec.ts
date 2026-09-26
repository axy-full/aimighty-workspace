import { test, expect } from '@playwright/test';
import { createClient } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';
import { newProject, type Project } from '../lib/workbench/studio';
import { sourceCanonical, type DevelopmentJob, type DevelopmentQuote, type DevelopmentRequest, type DevelopmentState } from '../lib/workbench/development-types';
import { signInLocally, localPlatformDbUrl } from './helpers/workbenchLocal';

/** Exercises the actual authenticated routes, background phases and both ledgers.
 * signInLocally refuses non-local/non-mock hosts before any fixture write. */
test('real development HTTP persists every script section, resumes idempotently, settles once and isolates projects', async ({ request, playwright }) => {
  const account = await signInLocally(request);
  const me = await request.get('/api/me').then(response => response.json());
  const headers = { 'X-Workbench-Scope': `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantRow = (await platform.execute({ sql: 'SELECT db_url FROM workspaces WHERE id=?', args: [account.workspace.id] })).rows[0];
  expect(String(tenantRow.db_url)).toMatch(/^file:/);
  const tenant = createClient({ url: String(tenantRow.db_url), timeout: 10_000 });
  const outsider = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || 'http://localhost:4551' });
  const anonymous = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || 'http://localhost:4551' });
  try {
    await platform.execute({ sql: 'INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)', args: [randomUUID(), account.workspace.id, 5000, 'Local mock agentic workflow test', 'admin', 'test', Date.now()] });
    const project = newProject(`Development HTTP ${randomUUID().slice(0, 8)}`);
    project.brief = 'A filmmaker follows a ceramic lamp through three rooms. Keep all source actions and propose motivated coverage.';
    project.scriptFormat = 'screenplay';
    project.script = [1, 2, 3].map(number => `INT. ROOM ${number} - DAY\n${'The maker moves the lamp into the light, studies its shadow, and waits.\n'.repeat(80)}The room settles into silence.\n\n`).join('');
    const saved = await request.put('/api/workbench/projects', { headers, data: { project, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    const savedIdentity = await saved.json() as { productionProjectId: string };
    const projectUrl = `/api/workbench/projects?id=${project.id}`;
    const stateUrl = `/api/workbench/development?projectId=${project.id}`;
    const initialResponse = await request.get(stateUrl, { headers });
    expect(initialResponse.ok(), await initialResponse.text()).toBe(true);
    const initial = await initialResponse.json() as DevelopmentState;
    expect(initial.configured).toBe(true);
    expect(initial.jobs).toEqual([]);
    expect(initial.models.length).toBeGreaterThan(0);
    expect(initial.models.every(model => /^(anthropic\/claude-|openai\/|spacexai\/grok-)/.test(model.id))).toBe(true);
    const model = initial.models.find(value => value.id.includes('haiku')) ?? initial.models.find(value => value.id.startsWith('anthropic/')) ?? initial.models[0];
    const input: DevelopmentRequest = { projectId: project.id, requestId: randomUUID(), kind: 'screenplay', model: model.id, effort: 'auto', instructions: 'Preserve the entire source, including the final room.' };
    const quoted = await request.post('/api/workbench/development', { headers, data: { ...input, quoteOnly: true } });
    expect(quoted.ok(), await quoted.text()).toBe(true);
    const quote = await quoted.json() as DevelopmentQuote;
    expect(quote).toMatchObject({ quoteOnly: true, model: model.id, kind: 'screenplay', effort: 'auto', sourceCharacters: project.script.length });
    expect(quote.chunks).toBeGreaterThanOrEqual(2);
    expect(quote.calls).toBe(quote.chunks * 3);
    expect(quote.sourceHash).toBe(createHash('sha256').update(sourceCanonical(project, 'screenplay')).digest('hex'));
    expect(quote.estimateUsd).toBeUndefined();
    expect((await platform.execute({ sql: 'SELECT id FROM meter_events WHERE workspace_id=?', args: [account.workspace.id] })).rows).toHaveLength(0);
    const approved = { ...input, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits };
    const submitted = await request.post('/api/workbench/development', { headers, data: approved });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    const accepted = (await submitted.json()).job as DevelopmentJob;
    expect(accepted.projectId).toBe(project.id);
    expect(accepted.requestId).toBe(input.requestId);
    expect(accepted.id).toMatch(/^wb_development_/);
    let completed = accepted;
    await expect.poll(async () => {
      const response = await request.get(stateUrl, { headers });
      expect(response.ok(), await response.text()).toBe(true);
      const state = await response.json() as DevelopmentState;
      completed = state.jobs.find(job => job.id === accepted.id)!;
      expect(completed).toBeTruthy();
      expect(['failed', 'uncertain'], completed.error ?? '').not.toContain(completed.status);
      if (completed.status === 'queued') {
        const resumed = await request.post('/api/workbench/development', { headers, data: { resume: true, projectId: project.id, jobId: accepted.id } });
        expect(resumed.ok(), await resumed.text()).toBe(true);
      }
      return completed.status;
    }, { timeout: 60_000, intervals: [100, 250, 500, 1000] }).toBe('succeeded');
    expect(completed.completedSteps).toBe(quote.calls);
    expect(completed.completedChunks).toBe(quote.chunks);
    expect(completed.resultPage).toEqual({ offset: 0, totalChunks: quote.chunks, hasMore: true });
    expect(completed.costUsd).toBeUndefined();
    const scenes = [];
    for (let offset = 0; offset < quote.chunks; offset++) {
      const pageResponse = await request.get(`${stateUrl}&jobId=${accepted.id}&offset=${offset}`, { headers });
      expect(pageResponse.ok(), await pageResponse.text()).toBe(true);
      const page = (await pageResponse.json()).job as DevelopmentJob;
      expect(page.resultPage).toEqual({ offset, totalChunks: quote.chunks, hasMore: offset + 1 < quote.chunks });
      expect(page.result?.critique).toContain('Mock review only; no provider was called.');
      scenes.push(...page.result!.scenes);
    }
    expect(scenes[0].sourceStart).toBe(0);
    expect(scenes.at(-1)!.sourceEnd).toBe(project.script.length);
    for (let index = 1; index < scenes.length; index++) expect(scenes[index].sourceStart).toBe(scenes[index - 1].sourceEnd);
    expect(scenes.map(scene => project.script!.slice(scene.sourceStart, scene.sourceEnd)).join('')).toBe(project.script);
    expect(new Set(scenes.map(scene => scene.id)).size).toBe(scenes.length);
    expect((await request.get(`${stateUrl}&jobId=${accepted.id}&offset=${quote.chunks}`, { headers })).status()).toBe(404);
    expect((await request.get(`${stateUrl}&jobId=${accepted.id}&offset=-1`, { headers })).status()).toBe(400);
    const phasesBefore = (await tenant.execute({ sql: 'SELECT * FROM workbench_development_steps WHERE job_id=? ORDER BY step_index', args: [accepted.id] })).rows;
    expect(phasesBefore).toHaveLength(quote.calls);
    expect(phasesBefore.every(step => step.status === 'succeeded' && step.response && step.result)).toBe(true);
    const ledgerBefore = (await platform.execute({ sql: 'SELECT * FROM meter_events WHERE id=?', args: [accepted.id] })).rows;
    expect(ledgerBefore).toHaveLength(1);
    expect(ledgerBefore[0]).toMatchObject({ workspace_id: account.workspace.id, project_id: savedIdentity.productionProjectId, status: 'succeeded', engine_cost_usd: 0, billed_credits: 0 });
    expect((await tenant.execute({ sql: 'SELECT settled FROM workbench_development_jobs WHERE id=?', args: [accepted.id] })).rows[0].settled).toBe(1);
    const debitsBefore = (await platform.execute({ sql: 'SELECT * FROM billing_debits WHERE workspace_id=? AND event_id=?', args: [account.workspace.id, accepted.id] })).rows;
    expect(debitsBefore).toHaveLength(1);
    expect(Number(debitsBefore[0].credits)).toBe(0);
    const replayed = await request.post('/api/workbench/development', { headers, data: approved });
    expect(replayed.ok(), await replayed.text()).toBe(true);
    expect((await replayed.json()).job.id).toBe(accepted.id);
    const resumed = await request.post('/api/workbench/development', { headers, data: { resume: true, projectId: project.id, jobId: accepted.id } });
    expect(resumed.ok(), await resumed.text()).toBe(true);
    expect((await resumed.json()).job.status).toBe('succeeded');
    expect((await tenant.execute({ sql: 'SELECT * FROM workbench_development_steps WHERE job_id=? ORDER BY step_index', args: [accepted.id] })).rows).toEqual(phasesBefore);
    expect((await platform.execute({ sql: 'SELECT * FROM meter_events WHERE id=?', args: [accepted.id] })).rows).toEqual(ledgerBefore);
    expect((await platform.execute({ sql: 'SELECT * FROM billing_debits WHERE workspace_id=? AND event_id=?', args: [account.workspace.id, accepted.id] })).rows).toEqual(debitsBefore);
    expect((await request.post('/api/workbench/development', { headers, data: { ...approved, instructions: 'A different request under the same identity.' } })).status()).toBe(409);

    const freshInput = { ...input, requestId: randomUUID() };
    const freshQuoteResponse = await request.post('/api/workbench/development', { headers, data: { ...freshInput, quoteOnly: true } });
    expect(freshQuoteResponse.ok(), await freshQuoteResponse.text()).toBe(true);
    const freshQuote = await freshQuoteResponse.json() as DevelopmentQuote;
    const latest = await request.get(projectUrl, { headers }).then(response => response.json()) as { project: Project; revision: number };
    latest.project.brief += ' A revised creative constraint changes the source context.';
    const updated = await request.put('/api/workbench/projects', { headers, data: latest });
    expect(updated.ok(), await updated.text()).toBe(true);
    const stale = await request.post('/api/workbench/development', { headers, data: { ...freshInput, sourceHash: freshQuote.sourceHash, maxCredits: freshQuote.estimateCredits } });
    expect(stale.status(), await stale.text()).toBe(409);
    expect(await stale.text()).toContain('source changed');
    for (const mismatched of [`particl-active-${account.workspace.id}-previous-account`, `particl-active-previous-workspace-${me.id}`]) {
      expect((await request.get(stateUrl, { headers: { 'X-Workbench-Scope': mismatched } })).status()).toBe(409);
      expect((await request.post('/api/workbench/development', { headers: { 'X-Workbench-Scope': mismatched }, data: approved })).status()).toBe(409);
    }
    expect((await request.post('/api/workbench/development', { headers: { ...headers, Origin: 'https://untrusted.example.invalid' }, data: approved })).status()).toBe(403);
    expect((await anonymous.get(stateUrl)).status()).toBe(401);
    expect((await anonymous.post('/api/workbench/development', { data: approved })).status()).toBe(401);
    await signInLocally(outsider);
    const otherMe = await outsider.get('/api/me').then(response => response.json());
    const otherHeaders = { 'X-Workbench-Scope': `particl-active-${otherMe.workspace.id}-${otherMe.id}` };
    expect((await outsider.get(stateUrl, { headers: otherHeaders })).status()).toBe(404);
    expect((await outsider.get(`${stateUrl}&jobId=${accepted.id}&offset=0`, { headers: otherHeaders })).status()).toBe(404);
    expect((await outsider.post('/api/workbench/development', { headers: otherHeaders, data: approved })).status()).toBe(404);
    // A collaborator in the same workspace must still not see another owner's private development source or job.
    await platform.execute({ sql: 'INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)', args: [account.workspace.id, otherMe.id, 'member', 0, Date.now()] });
    const switched = await outsider.post('/api/workspaces/switch', { headers: otherHeaders, data: { id: account.workspace.id } });
    expect(switched.ok(), await switched.text()).toBe(true);
    const collaboratorHeaders = { 'X-Workbench-Scope': `particl-active-${account.workspace.id}-${otherMe.id}` };
    expect((await outsider.get(stateUrl, { headers: collaboratorHeaders })).status()).toBe(404);
    expect((await outsider.get(`${stateUrl}&jobId=${accepted.id}&offset=0`, { headers: collaboratorHeaders })).status()).toBe(404);
    expect((await outsider.post('/api/workbench/development', { headers: collaboratorHeaders, data: { resume: true, projectId: project.id, jobId: accepted.id } })).status()).toBe(404);
    expect((await platform.execute({ sql: 'SELECT id FROM meter_events WHERE workspace_id=?', args: [account.workspace.id] })).rows).toHaveLength(1);
    expect((await tenant.execute({ sql: 'SELECT id FROM workbench_development_jobs WHERE project_id=?', args: [project.id] })).rows).toHaveLength(1);
  } finally {
    platform.close(); tenant.close();
    await outsider.dispose(); await anonymous.dispose();
  }
});
