import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';
import { seedProject } from '../../lib/workbench/studio';
import { CREW } from '../../lib/workbench/crew';
import { atomikContext, atomikModels, atomikRequestSchema, atomikSystem, listAtomikJobs, prepareAtomikJob, quoteAtomikJob, runAtomikJob, type AtomikDependencies } from '../../lib/workbench/atomik-server';
import type { MeterEvent } from '../../lib/meter';
import type { CatalogModel } from '../../lib/catalog';

const dir = mkdtempSync(path.join(tmpdir(), 'particl-workbench-atomik-'));
const model: CatalogModel = { id: 'test/economy', name: 'Economy', owner: 'test', type: 'language', description: '', contextWindow: 200000, maxTokens: 8192, pricing: { input: '0.0000001', output: '0.0000003' } };
const validReply = { intent: 'shots', summary: 'Mira enters the dunes after the sphere catches first light.', steps: ['Open on the mirrored dunes for 96 frames at 24 fps.', 'Hold the encounter for 144 frames; keep Mira’s ivory scarf consistent.'] };
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'unit', name: 'Unit', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys: { gateway: 'test-only-never-sent' }, usesPlatformKeys: false, allowanceUsd: null,
    gatewayKeyId: null, ownerId: 'owner', createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
function harness() {
  const events: MeterEvent[] = [];
  let calls = 0, reservations = 0;
  const deps: AtomikDependencies = {
    models: async () => [model], allowance: async () => ({ ok: true }),
    limits: async () => ({ allow: true, limits: { concurrency: 3, rendersPerHour: 30, storageBytes: 1000000 }, standing: { running: 0, startedLastHour: 0, usedBytes: 0 } }),
    reserve: async () => { reservations++; }, meter: async e => { events.push(e); },
    auth: async () => ({}), run: async () => { calls++; return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReply) } }], usage: { prompt_tokens: 210, completion_tokens: 60, cost: .003 } }) }; },
  };
  return { deps, events, calls: () => calls, reservations: () => reservations };
}
async function fixture() {
  await ready();
  const project = seedProject();
  project.id = 'production-' + randomUUID();
  project.productionProjectId = 'real-project-' + randomUUID();
  await db().execute({ sql: 'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: ['owner:' + project.id, 'owner', project.id, project.name, JSON.stringify(project), Date.now()] });
  const input = atomikRequestSchema.parse({ projectId: project.id, requestId: randomUUID(), request: 'Make a shot proposal from the Mira brief', model: 'auto', depth: 'Quick', refs: ['hero', 'character'] });
  return { project, input };
}

test('the crew has seven requested departments and Genie is a general assistant', () => {
  expect(CREW.map(c => c.id).sort()).toEqual(['continuity','costume','design','director','dop','editor','producer']);
  const input = atomikRequestSchema.parse({ projectId: 'p', requestId: 'request-123', request: 'Create a treatment' });
  expect(atomikSystem(input)).toContain('You are Genie');
  expect(atomikSystem({ ...input, role: 'costume' })).toContain('Your sole department is Wardrobe & silhouette');
});

test('catalog selection uses priced language models and chooses economy by cost', () => {
  const expensive = { ...model, id: 'test/premium', pricing: { input: .00001, output: .00005 } };
  expect(atomikModels([expensive, { ...model, id: 'test/unpriced', pricing: null }, { ...model, id: 'test/image', type: 'image' }, model]).map(m => m.id)).toEqual(['test/economy','test/premium']);
});

test('context is tied to supplied references and never pretends to inspect pictures', async () => {
  const project = seedProject();
  project.script = 'EXT. MIRRORED DUNES - DAY\nMira turns away from her reflection.';
  const input = atomikRequestSchema.parse({ projectId: project.id, requestId: 'request-123', request: 'Check continuity', refs: ['hero'] });
  const context = JSON.parse(atomikContext(project, input, { hero: 'User supplied continuity notes' }));
  expect(context.project.screenplay).toContain('Mira turns');
  expect(context.selectedReferences).toHaveLength(1);
  expect(context.selectedReferences[0].uploadedText).toContain('continuity notes');
  expect(JSON.parse(atomikContext(project, input)).selectedReferences[0].evidence).toContain('has not been viewed');
  expect(() => atomikContext(project, { ...input, refs: ['missing'] })).toThrow('no longer part');
});

test('duplicate submissions have one durable claim, one reservation and one paid execution', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    const first = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    const duplicate = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    expect(first.scheduled).toBe(true);
    expect(duplicate.scheduled).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    await runAtomikJob(first.job.id, 'owner', h.deps);
    await runAtomikJob(first.job.id, 'owner', h.deps);
    expect(h.calls()).toBe(1);
    expect(h.reservations()).toBe(1);
    const jobs = await listAtomikJobs('owner', input.projectId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('succeeded');
    expect(jobs[0].plan?.summary).toEqual(validReply.summary);
    expect(jobs[0].plan?.applied).toBe(false);
    expect(jobs[0].costUsd).toBe(.003);
    expect(h.events.at(-1)?.engineCostUsd).toBe(.003);
    expect(h.events.at(-1)?.projectId).toContain('real-project-');
    expect(Number((await db().execute('SELECT cost_usd FROM atomik_spend')).rows[0].cost_usd)).toBe(.003);
  });
});

test('changed idempotency inputs and another owner cannot reuse a saved production', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    await prepareAtomikJob(input, 'owner', undefined, h.deps);
    await expect(prepareAtomikJob({ ...input, request: 'A different request' }, 'owner', undefined, h.deps)).rejects.toThrow('different instructions');
    await expect(prepareAtomikJob(input, 'other-owner', undefined, h.deps)).rejects.toThrow('Save this production');
    await expect(listAtomikJobs('other-owner', input.projectId)).rejects.toThrow('Save this production');
    expect(h.calls()).toBe(0);
  });
});

test('ambiguous provider interruption keeps the reservation and never submits again', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    let calls = 0;
    h.deps.run = async () => { calls++; throw new Error('network disconnected after submission'); };
    const { job } = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    await runAtomikJob(job.id, 'owner', h.deps);
    await runAtomikJob(job.id, 'owner', h.deps);
    const duplicate = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    expect(calls).toBe(1);
    expect(duplicate.scheduled).toBe(false);
    expect(duplicate.job.status).toBe('uncertain');
    expect(duplicate.job.costUsd).toBeNull();
    expect(h.events.at(-1)?.engineCostUsd).toBe(job.estimateUsd);
  });
});

test('invalid model output is saved as a paid failed attempt without a retry', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    h.deps.run = async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...validReply, unexpected: true }) } }], usage: { cost: .004 } }) });
    const { job } = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    await runAtomikJob(job.id, 'owner', h.deps);
    const saved = (await listAtomikJobs('owner', input.projectId))[0];
    expect(saved.status).toBe('failed');
    expect(saved.plan).toBeNull();
    expect(saved.costUsd).toBe(.004);
    expect(saved.error).toContain('invalid proposal');
  });
});

test('reservation failure and a per-request budget ceiling prevent provider calls', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    h.deps.reserve = async () => { throw new Error('No credits remain'); };
    await expect(prepareAtomikJob(input, 'owner', undefined, h.deps)).rejects.toThrow('No credits');
    expect(h.calls()).toBe(0);
    expect((await listAtomikJobs('owner', input.projectId))[0].costUsd).toBe(0);
    h.deps.models = async () => [{ ...model, pricing: { input: 1, output: 1 } }];
    await expect(prepareAtomikJob({ ...input, requestId: randomUUID() }, 'owner', undefined, h.deps)).rejects.toThrow('spending limit');
    expect(h.calls()).toBe(0);
  });
});

test('text jobs count towards the workspace concurrency limit before any reservation', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    h.deps.limits = async () => ({ allow: true, limits: { concurrency: 1, rendersPerHour: 30, storageBytes: 1000000 }, standing: { running: 0, startedLastHour: 0, usedBytes: 0 } });
    await prepareAtomikJob(input, 'owner', undefined, h.deps);
    await expect(prepareAtomikJob({ ...input, requestId: randomUUID() }, 'owner', undefined, h.deps)).rejects.toThrow('Waiting for a slot');
    expect(h.reservations()).toBe(1);
  });
});


test('a quote reveals the reserved credit amount without starting or saving a paid job', async () => {
  await runInTenant({ ...workspace(), keys: {}, usesPlatformKeys: true }, async () => {
    const { input } = await fixture();
    const h = harness();
    const quote = await quoteAtomikJob(input, 'owner', h.deps);
    expect(quote.model).toBe('test/economy');
    expect(quote.estimateCredits).toBeGreaterThan(0);
    expect(h.calls()).toBe(0);
    expect(h.reservations()).toBe(0);
    expect(h.events).toHaveLength(0);
    expect(await listAtomikJobs('owner', input.projectId)).toEqual([]);
    await expect(prepareAtomikJob({ ...input, maxCredits: 0 }, 'owner', undefined, h.deps)).rejects.toThrow('estimate changed');
    expect(h.reservations()).toBe(0);
  });
});

test('simultaneous retries claim a request once across independent callers', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    const results = await Promise.all([
      prepareAtomikJob(input, 'owner', undefined, h.deps),
      prepareAtomikJob(input, 'owner', undefined, h.deps),
    ]);
    expect(new Set(results.map(r => r.job.id)).size).toBe(1);
    expect(results.filter(r => r.scheduled)).toHaveLength(1);
    expect(h.reservations()).toBe(1);
  });
});


test('a stale queued job becomes uncertain without inventing a charge or resubmitting', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    const { job } = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    await db().execute({ sql: 'UPDATE workbench_atomik_jobs SET updated_at=? WHERE id=?', args: [Date.now() - 240000, job.id] });
    const saved = await listAtomikJobs('owner', input.projectId, { meter: h.deps.meter });
    expect(saved[0].status).toBe('uncertain');
    expect(h.events.at(-1)?.status).toBe('failed');
    expect(h.events.at(-1)?.engineCostUsd).toBeUndefined();
    await runAtomikJob(job.id, 'owner', h.deps);
    expect(h.calls()).toBe(0);
  });
});

test('request identity lookup recovers an older job outside the recent history window', async () => {
  await runInTenant(workspace(), async () => {
    const { input } = await fixture();
    const h = harness();
    const { job } = await prepareAtomikJob(input, 'owner', undefined, h.deps);
    await db().batch(Array.from({ length: 101 }, (_, i) => ({
      sql: `INSERT INTO workbench_atomik_jobs(id,owner,project_id,production_project_id,request_id,fingerprint,request_body,model,status,provider_body,estimate_usd,estimate_credits,created_at,updated_at)
        SELECT ?,owner,project_id,production_project_id,?,fingerprint,?,model,'failed',provider_body,0,0,?,? FROM workbench_atomik_jobs WHERE id=?`,
      args: ['history-job-' + i, 'history-request-' + i, JSON.stringify({ ...input, requestId: 'history-request-' + i }), job.createdAt + i + 1, job.updatedAt, job.id],
    })), 'write');
    expect((await listAtomikJobs('owner', input.projectId)).some(item => item.id === job.id)).toBe(false);
    const found = await listAtomikJobs('owner', input.projectId, undefined, input.requestId);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(job.id);
    expect(await listAtomikJobs('owner', input.projectId, undefined, 'missing-request')).toEqual([]);
  });
});
