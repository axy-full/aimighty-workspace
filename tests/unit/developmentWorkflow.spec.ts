import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';
import { seedProject } from '../../lib/workbench/studio';
import { developmentChunks, validateDevelopmentResult, developmentInstructions } from '../../lib/workbench/development-plan';
import { sourceCanonical, type DevelopmentRequest, type DevelopmentResult } from '../../lib/workbench/development-types';
import { developmentModels, developmentProviderOptions, developmentSourceHash, listDevelopmentJobs, prepareDevelopmentJob, quoteDevelopmentJob, runDevelopmentStep, executeDevelopmentAgent, type DevelopmentCall, type DevelopmentDependencies } from '../../lib/workbench/development-server';
import type { CatalogModel } from '../../lib/catalog';
import type { MeterEvent } from '../../lib/meter';

const dir = mkdtempSync(path.join(tmpdir(), 'particl-development-'));
process.env.PLATFORM_DATABASE_URL = 'file:' + path.join(dir, 'platform.db');
process.env.KEYRING_SECRET ??= 'unit-test-keyring-secret-unit-test-keyring';
const model: CatalogModel = { id: 'anthropic/claude-sonnet-4.6', name: 'Claude', owner: 'anthropic', type: 'language', description: '', contextWindow: 200000, maxTokens: 8192, pricing: { input: .0000001, output: .0000003 } };
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'unit', name: 'Unit', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys: { gateway: 'test-only-never-sent' }, usesPlatformKeys: false, allowanceUsd: null,
    gatewayKeyId: null, ownerId: 'owner', createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
function output(input: DevelopmentCall): DevelopmentResult {
  return { summary: 'A source-grounded production plan.', recommendation: 'Use motivated camera movement.',
    ideas: input.kind === 'idea' ? ['Route A', 'Route B'].map(title => ({ title, logline: 'A character pursues a concrete need.', treatment: 'The conflict escalates before a earned ending.', visualDirection: 'Natural light.', critique: 'Check audience fit.' })) : [],
    scenes: input.chunk.segments.map(segment => ({ id: segment.id, heading: segment.heading, sourceStart: segment.start, sourceEnd: segment.end,
      summary: 'Dramatic action grounded in this segment.', beats: ['Establish need.', 'Escalate conflict.'],
      shots: [{ description: 'Establish the subject.', framing: 'Wide', movement: 'Locked', lighting: 'Window key', sound: 'Room tone' }],
      characters: ['Mira'], props: ['Mirror'], locations: ['Dunes'], productionNotes: ['Track scarf continuity.'] })), critique: ['Confirm continuity.'], assumptions: ['Proposed framing.'] };
}
function harness() {
  const events: MeterEvent[] = [], calls: DevelopmentCall[] = [];
  let reservations = 0;
  const deps: DevelopmentDependencies = {
    models: async () => [model], allowance: async () => ({ ok: true }),
    auth: async () => ({ token: 'test-only-not-sent', method: 'api-key' }), funding: async () => {}, reservation: async () => true,
    reserve: async () => { reservations++; }, meter: async event => { events.push(event); },
    call: async input => { calls.push(input); return { text: JSON.stringify(input.stage === 'critique' ? { issues: ['Check continuity.'], revisions: ['Preserve the scarf.'] } : output(input)), inputTokens: 200, outputTokens: 100, costUsd: .002 }; },
  };
  return { deps, events, calls, reservations: () => reservations };
}
async function fixture(kind: DevelopmentRequest['kind'] = 'screenplay') {
  await ready();
  const project = seedProject(); project.id = 'development-' + randomUUID(); project.productionProjectId = 'real-' + randomUUID();
  project.script = 'TITLE PAGE\n\nEXT. DUNES - DAY\nMira follows her reflection.\n\nINT. ROOM - NIGHT\nShe opens a letter.';
  await db().execute({ sql: 'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: ['owner:' + project.id, 'owner', project.id, project.name, JSON.stringify(project), Date.now()] });
  const request: DevelopmentRequest = { projectId: project.id, requestId: randomUUID(), kind, model: model.id, effort: 'auto', instructions: 'Make this shootable.' };
  return { project, request };
}
async function approve(request: DevelopmentRequest, deps: Partial<DevelopmentDependencies>) {
  const quote = await quoteDevelopmentJob(request, 'owner', deps);
  return { ...request, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits, maxUsd: quote.estimateUsd };
}

test('a million-character screenplay is partitioned without omissions or broken surrogate pairs', () => {
  const script = ('TITLE\nEXT. DUNES - DAY\n' + 'Mira walks 🌅.\n'.repeat(100)).repeat(700).slice(0, 1_000_000);
  const chunks = developmentChunks(script), segments = chunks.flatMap(chunk => chunk.segments);
  expect(segments[0].start).toBe(0); expect(segments.at(-1)!.end).toBe(script.length);
  expect(segments.map(segment => script.slice(segment.start, segment.end)).join('')).toBe(script);
  for (let index = 1; index < segments.length; index++) expect(segments[index].start).toBe(segments[index - 1].end);
  expect(chunks.every(chunk => chunk.end - chunk.start <= 8000 && chunk.segments.length <= 8)).toBe(true);
  expect(() => developmentChunks('x'.repeat(1_000_001))).toThrow('1,000,000');
});

test('coverage validation rejects omitted, duplicated and shifted source segments', () => {
  const chunk = developmentChunks('INT. ROOM - DAY\nHello\nEXT. DUNES - NIGHT\nGoodbye')[0];
  const result = output({ chunk, kind: 'screenplay' } as DevelopmentCall);
  expect(validateDevelopmentResult(result, 'screenplay', chunk).scenes).toHaveLength(2);
  expect(() => validateDevelopmentResult({ ...result, scenes: result.scenes.slice(0, 1) }, 'screenplay', chunk)).toThrow('every assigned');
  expect(() => validateDevelopmentResult({ ...result, scenes: [result.scenes[0], result.scenes[0]] }, 'screenplay', chunk)).toThrow('duplicated');
  expect(() => validateDevelopmentResult({ ...result, scenes: result.scenes.map(scene => ({ ...scene, sourceEnd: scene.sourceEnd + 1 })) }, 'screenplay', chunk)).toThrow('source coverage');
});

test('source identity includes whole script, context, format and direction; irrelevant media edits do not invalidate it', () => {
  const project = seedProject(); project.script = 'Whole screenplay';
  const hash = developmentSourceHash(sourceCanonical(project, 'screenplay'));
  expect(developmentSourceHash(sourceCanonical({ ...project, script: project.script + ' changed last page' }, 'screenplay'))).not.toBe(hash);
  expect(developmentSourceHash(sourceCanonical({ ...project, scriptFormat: 'adfilm' }, 'screenplay'))).not.toBe(hash);
  expect(developmentSourceHash(sourceCanonical({ ...project, direction: 'Other direction' }, 'screenplay'))).not.toBe(hash);
  expect(developmentSourceHash(sourceCanonical({ ...project, assets: [] } as typeof project, 'screenplay'))).toBe(hash);
  expect(sourceCanonical({ ...project, script: 'different' }, 'idea')).toBe(sourceCanonical(project, 'idea'));
});

test('the model menu offers priced Claude/OpenAI models and native effort retains its provider value', () => {
  const openai = { ...model, id: 'openai/gpt-6-astra', owner: 'openai', reasoningOptions: [{ type: 'effort' as const, values: ['low', 'medium', 'high', 'max'] }] };
  expect(developmentModels([model, openai, { ...model, id: 'google/gemini-3.1-pro-preview' }, { ...model, id: 'anthropic/claude-opus-4.6', pricing: null }]).map(model => model.id)).toEqual([model.id, openai.id]);
  expect(developmentProviderOptions(openai, 'medium')).toEqual({ openai: { reasoningEffort: 'medium' } });
  expect(developmentProviderOptions(openai, 'max')).toEqual({ gateway: { only: ['openai'] }, openai: { reasoningEffort: 'max' } });
  expect(developmentInstructions('adfilm', 'draft')).toContain('call to action');
  expect(developmentInstructions('screenplay', 'critique')).toContain('untrusted source material');
});

test('quote is read-only and accounts for every phase, complete source, prior outputs and model effort', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const quote = await quoteDevelopmentJob(request, 'owner', h.deps);
    expect(quote.calls).toBe(quote.chunks * 3); expect(quote.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(quote.estimateUsd).toBeGreaterThan(.015); expect(h.reservations()).toBe(0); expect(h.calls).toHaveLength(0);
    expect(await listDevelopmentJobs('owner', request.projectId, undefined, h.deps)).toEqual([]);
    await expect(prepareDevelopmentJob(request, 'owner', undefined, h.deps)).rejects.toThrow('quote');
    await expect(prepareDevelopmentJob({ ...await approve(request, h.deps), maxUsd: 0 }, 'owner', undefined, h.deps)).rejects.toThrow('estimate changed');
  });
});

test('duplicate submissions and worker retries reserve once and execute each paid phase exactly once', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness(), approved = await approve(request, h.deps);
    const first = await prepareDevelopmentJob(approved, 'owner', undefined, h.deps);
    const duplicate = await prepareDevelopmentJob(approved, 'owner', undefined, h.deps);
    expect(duplicate.job.id).toBe(first.job.id); expect(duplicate.scheduled).toBe(false); expect(h.reservations()).toBe(1);
    for (let index = 0; index < 5; index++) await runDevelopmentStep(first.job.id, 'owner', h.deps);
    expect(h.calls.map(call => call.stage)).toEqual(['draft', 'critique', 'refine']);
    expect(h.calls[1].prompt).toContain('savedDraft'); expect(h.calls[2].prompt).toContain('independentCritique');
    const [job] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(job.status).toBe('succeeded'); expect(job.completedSteps).toBe(3); expect(job.costUsd).toBeCloseTo(.006);
    expect(job.result!.scenes).toHaveLength(2); expect(h.events.at(-1)?.status).toBe('succeeded');
    await expect(prepareDevelopmentJob({ ...approved, instructions: 'Changed request' }, 'owner', undefined, h.deps)).rejects.toThrow('different workflow');
  });
});

test('a stale quote or another owner cannot submit or access the saved source', async () => {
  await runInTenant(workspace(), async () => {
    const { request, project } = await fixture(), h = harness(), approved = await approve(request, h.deps);
    project.script += '\nThe final page changed.';
    await db().execute({ sql: 'UPDATE workbench_projects SET body=? WHERE owner=? AND project_id=?', args: [JSON.stringify(project), 'owner', project.id] });
    await expect(prepareDevelopmentJob(approved, 'owner', undefined, h.deps)).rejects.toThrow('source changed');
    await expect(quoteDevelopmentJob(request, 'intruder', h.deps)).rejects.toThrow('Save this project');
    await expect(listDevelopmentJobs('intruder', request.projectId, undefined, h.deps)).rejects.toThrow('Save this project');
    expect(h.reservations()).toBe(0);
  });
});

test('ambiguous provider failure retains reservation and never advances or retries the paid attempt', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const { job } = await prepareDevelopmentJob(await approve(request, h.deps), 'owner', undefined, h.deps);
    h.deps.call = async input => { h.calls.push(input); throw new Error('Connection reset after submit'); };
    await runDevelopmentStep(job.id, 'owner', h.deps); await runDevelopmentStep(job.id, 'owner', h.deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, request.requestId, h.deps);
    expect(saved.status).toBe('uncertain'); expect(saved.costUsd).toBeNull(); expect(h.calls).toHaveLength(1);
    expect(h.events.at(-1)?.engineCostUsd).toBe(job.estimateUsd);
  });
});

test('invalid paid output is retained, charged once and blocks all future phases', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const { job } = await prepareDevelopmentJob(await approve(request, h.deps), 'owner', undefined, h.deps);
    h.deps.call = async input => { h.calls.push(input); return { text: '{"bad":"result"}', costUsd: .003 }; };
    await runDevelopmentStep(job.id, 'owner', h.deps); await runDevelopmentStep(job.id, 'owner', h.deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(saved.status).toBe('failed'); expect(saved.costUsd).toBe(.003); expect(h.calls).toHaveLength(1);
    expect((await db().execute({ sql: 'SELECT response FROM workbench_development_steps WHERE job_id=? AND step_index=0', args: [job.id] })).rows[0].response).toBe('{"bad":"result"}');
  });
});

test('a resumed full script retains all segments and idea development produces distinct critiqued routes', async () => {
  for (const kind of ['screenplay', 'adfilm', 'idea'] as const) await runInTenant(workspace(), async () => {
    const { request, project } = await fixture(kind), h = harness();
    if (kind === 'screenplay') {
      project.script = 'INT. LONG SCENE - DAY\n' + 'Mira walks toward the mirror.\n'.repeat(450);
      await db().execute({ sql: 'UPDATE workbench_projects SET body=? WHERE project_id=?', args: [JSON.stringify(project), project.id] });
    }
    const { job } = await prepareDevelopmentJob(await approve(request, h.deps), 'owner', undefined, h.deps);
    await runDevelopmentStep(job.id, 'owner', h.deps);
    const [partial] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(partial.status).toBe('queued'); expect(partial.completedSteps).toBe(1);
    for (let step = 1; step < job.totalSteps; step++) await runDevelopmentStep(job.id, 'owner', h.deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(saved.status).toBe('succeeded'); expect(h.calls).toHaveLength(job.totalSteps);
    if (kind === 'idea') expect(saved.result!.ideas).toHaveLength(2);
    else {
      const scenes = [];
      for (let offset = 0; offset < saved.totalChunks; offset++) {
        const [page] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps, saved.id, offset);
        expect(page.resultPage).toEqual({ offset, totalChunks: saved.totalChunks, hasMore: offset + 1 < saved.totalChunks });
        scenes.push(...page.result!.scenes);
      }
      expect(scenes.map(scene => project.script!.slice(scene.sourceStart, scene.sourceEnd)).join('')).toBe(project.script);
    }
  });
});

test('a stale started phase is fenced as uncertain, while queued phases remain resumable', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const { job } = await prepareDevelopmentJob(await approve(request, h.deps), 'owner', undefined, h.deps);
    await db().execute({ sql: "UPDATE workbench_development_steps SET status='running',updated_at=? WHERE job_id=? AND step_index=0", args: [Date.now() - 400_000, job.id] });
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(saved.status).toBe('uncertain'); await runDevelopmentStep(job.id, 'owner', h.deps); expect(h.calls).toHaveLength(0);
  });
});

test('installed SDK emits v4 Gateway protocol with correct OIDC/key authentication and native effort, without retries', async () => {
  const chunk = developmentChunks('INT. ROOM - DAY\nMira enters.')[0];
  const input: DevelopmentCall = { model: { ...model, id: 'openai/gpt-6-astra', owner: 'openai', reasoningOptions: [{ type: 'effort', values: ['medium'] }] },
    effort: 'medium', stage: 'draft', kind: 'screenplay', instructions: 'Return JSON.', prompt: 'Source.', maxTokens: 4000, chunk };
  for (const method of ['oidc', 'api-key'] as const) {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ content: [{ type: 'text', text: '{"ok":true}' }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] });
    };
    const result = await executeDevelopmentAgent(input, { method, token: 'test-token-not-real' }, fakeFetch);
    expect(result).toEqual({ text: '{"ok":true}', inputTokens: 100, outputTokens: 20 });
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/v4/ai/language-model');
    expect(calls[0].headers.get('authorization')).toBe('Bearer test-token-not-real');
    expect(calls[0].headers.get('ai-gateway-auth-method')).toBe(method);
    expect(calls[0].headers.get('ai-language-model-id')).toBe(input.model.id);
    expect(calls[0].body.providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } });
    expect(calls[0].body.maxOutputTokens).toBe(4000);
  }
  let attempts = 0;
  await expect(executeDevelopmentAgent(input, { method: 'oidc', token: 'test-token' }, async () => {
    attempts++; return Response.json({ error: { message: 'Simulated upstream outage' } }, { status: 503 });
  })).rejects.toMatchObject({ providerSubmitted: true });
  expect(attempts).toBe(1);
  const legacy = { ...model, id: 'anthropic/claude-sonnet-4.5', maxTokens: 8192 };
  let budgetWire: Record<string, unknown> | undefined;
  await executeDevelopmentAgent({ ...input, model: legacy, effort: 'budget:4096', maxTokens: 8096 }, { method: 'api-key', token: 'test-token' }, async (_url, init) => {
    budgetWire = JSON.parse(String(init?.body));
    return Response.json({ content: [{ type: 'text', text: '{}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] });
  });
  // The Anthropic provider adds budgetTokens to this field. The wire ceiling
  // remains the exact 8,096 total tokens covered by the approved quote.
  expect(budgetWire?.maxOutputTokens).toBe(4000);
  expect(budgetWire?.providerOptions).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } });
});

test('credential preflight failure creates no reservation and a later local failure incurs no uncertainty', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness(), approved = await approve(request, h.deps);
    h.deps.auth = async () => { throw new Error('Workspace gateway is not connected'); };
    await expect(prepareDevelopmentJob(approved, 'owner', undefined, h.deps)).rejects.toThrow('not connected');
    expect(h.reservations()).toBe(0); expect(h.calls).toHaveLength(0);
    h.deps.auth = async () => ({ token: 'test', method: 'api-key' });
    const { job } = await prepareDevelopmentJob(approved, 'owner', undefined, h.deps);
    h.deps.auth = async () => { throw new Error('Credentials removed'); };
    await runDevelopmentStep(job.id, 'owner', h.deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(saved.status).toBe('failed'); expect(saved.costUsd).toBe(0); expect(h.calls).toHaveLength(0);
  });
});

test('real ledger funding guard prevents a BYOK reservation from switching to platform spend mid-workflow', async () => {
  const { reserveGenerationSpend } = await import('../../lib/generationRequests');
  const { meter } = await import('../../lib/meter');
  const { platformDb } = await import('../../lib/platform');
  const ws = workspace();
  await runInTenant(ws, async () => {
    const { request } = await fixture(), h = harness();
    const deps: Partial<DevelopmentDependencies> = { models: h.deps.models, allowance: h.deps.allowance, auth: h.deps.auth, call: h.deps.call, reserve: reserveGenerationSpend, meter };
    const { job } = await prepareDevelopmentJob(await approve(request, deps), 'owner', undefined, deps);
    await runDevelopmentStep(job.id, 'owner', deps);
    ws.keys = {}; ws.usesPlatformKeys = true;
    await runDevelopmentStep(job.id, 'owner', deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, deps);
    const ledger = (await platformDb().execute({ sql: 'SELECT * FROM meter_events WHERE id=?', args: [job.id] })).rows[0];
    expect(h.calls).toHaveLength(1); expect(saved.status).toBe('failed'); expect(saved.credits).toBe(0);
    expect(Number(ledger.paid_by_platform)).toBe(0); expect(Number(ledger.billed_credits)).toBe(0);
    expect(Number(ledger.engine_cost_usd)).toBe(.002); expect(ledger.status).toBe('failed');
  });
});

test('real ledger reservation is released after interrupted admission, while an unreserved admission creates no bill', async () => {
  const { reserveGenerationSpend } = await import('../../lib/generationRequests');
  const { meter } = await import('../../lib/meter');
  const { platformDb } = await import('../../lib/platform');
  for (const reserved of [true, false]) await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const deps: Partial<DevelopmentDependencies> = { models: h.deps.models, allowance: h.deps.allowance, auth: h.deps.auth, call: h.deps.call,
      reserve: reserved ? reserveGenerationSpend : async () => {}, meter };
    const { job } = await prepareDevelopmentJob(await approve(request, deps), 'owner', undefined, deps);
    await db().execute({ sql: "UPDATE workbench_development_jobs SET status='queued',updated_at=? WHERE id=?", args: [Date.now() - 400_000, job.id] });
    await runDevelopmentStep(job.id, 'owner', deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, deps);
    const ledger = (await platformDb().execute({ sql: 'SELECT * FROM meter_events WHERE id=?', args: [job.id] })).rows[0];
    expect(saved.status).toBe('failed'); expect(saved.costUsd).toBe(0); expect(h.calls).toHaveLength(0);
    if (reserved) { expect(ledger.status).toBe('failed'); expect(Number(ledger.engine_cost_usd)).toBe(0); }
    else expect(ledger).toBeUndefined();
  });
});

test('terminal settlement survives a real ledger outage and retries independently of paid work', async () => {
  const { reserveGenerationSpend } = await import('../../lib/generationRequests');
  const { meter } = await import('../../lib/meter');
  const { platformDb } = await import('../../lib/platform');
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    let unavailable = true;
    const deps: Partial<DevelopmentDependencies> = { models: h.deps.models, allowance: h.deps.allowance, auth: h.deps.auth, call: h.deps.call, reserve: reserveGenerationSpend,
      meter: async (event, options) => { if (unavailable) throw new Error('Simulated ledger outage'); return meter(event, options); } };
    const { job } = await prepareDevelopmentJob(await approve(request, deps), 'owner', undefined, deps);
    for (let step = 0; step < 3; step++) await runDevelopmentStep(job.id, 'owner', deps);
    expect((await db().execute({ sql: 'SELECT status,settled FROM workbench_development_jobs WHERE id=?', args: [job.id] })).rows[0]).toMatchObject({ status: 'succeeded', settled: 0 });
    expect((await platformDb().execute({ sql: 'SELECT status FROM meter_events WHERE id=?', args: [job.id] })).rows[0].status).toBe('running');
    unavailable = false;
    await runDevelopmentStep(job.id, 'owner', deps);
    const ledger = (await platformDb().execute({ sql: 'SELECT status,engine_cost_usd FROM meter_events WHERE id=?', args: [job.id] })).rows[0];
    expect(ledger.status).toBe('succeeded'); expect(Number(ledger.engine_cost_usd)).toBeCloseTo(.006); expect(h.calls).toHaveLength(3);
    expect((await db().execute({ sql: 'SELECT settled FROM workbench_development_jobs WHERE id=?', args: [job.id] })).rows[0].settled).toBe(1);
  });
});

test('a late provider answer cannot overwrite an exact stale phase fence or resume another phase', async () => {
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const { job } = await prepareDevelopmentJob(await approve(request, h.deps), 'owner', undefined, h.deps);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.deps.call = async input => { h.calls.push(input); entered(); await wait; return { text: JSON.stringify(output(input)), costUsd: .002 }; };
    const active = runDevelopmentStep(job.id, 'owner', h.deps); await started;
    await db().execute({ sql: 'UPDATE workbench_development_steps SET updated_at=? WHERE job_id=? AND step_index=0', args: [Date.now() - 400_000, job.id] });
    const [fenced] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps); expect(fenced.status).toBe('uncertain');
    release(); await active; await runDevelopmentStep(job.id, 'owner', h.deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, h.deps);
    expect(saved.status).toBe('uncertain'); expect(h.calls).toHaveLength(1);
  });
});

test('a lost reservation acknowledgement reconciles the committed ledger before closing admission', async () => {
  const { reserveGenerationSpend } = await import('../../lib/generationRequests');
  const { meter } = await import('../../lib/meter');
  const { platformDb } = await import('../../lib/platform');
  await runInTenant(workspace(), async () => {
    const { request } = await fixture(), h = harness();
    const deps: Partial<DevelopmentDependencies> = { models: h.deps.models, allowance: h.deps.allowance, auth: h.deps.auth, call: h.deps.call, meter,
      reserve: async (event, options) => { await reserveGenerationSpend(event, options); throw new Error('Lost commit acknowledgement'); } };
    await expect(prepareDevelopmentJob(await approve(request, deps), 'owner', undefined, deps)).rejects.toThrow('Lost commit acknowledgement');
    const [saved] = await listDevelopmentJobs('owner', request.projectId, request.requestId, deps);
    expect(saved.status).toBe('failed'); expect(saved.costUsd).toBe(0); expect(h.calls).toHaveLength(0);
    const ledger = (await platformDb().execute({ sql: 'SELECT status,engine_cost_usd FROM meter_events WHERE id=?', args: [saved.id] })).rows[0];
    expect(ledger.status).toBe('failed'); expect(Number(ledger.engine_cost_usd)).toBe(0);
    expect((await db().execute({ sql: 'SELECT settled FROM workbench_development_jobs WHERE id=?', args: [saved.id] })).rows[0].settled).toBe(1);
  });
});

test('a definitively invalid paid answer settles its bill and resolves the accepted recovery intent', async () => {
  const { reserveGenerationSpend } = await import('../../lib/generationRequests');
  const { meter } = await import('../../lib/meter');
  const { platformDb } = await import('../../lib/platform');
  const ws = workspace();
  await runInTenant(ws, async () => {
    const { request } = await fixture(), h = harness();
    const deps: Partial<DevelopmentDependencies> = { models: h.deps.models, allowance: h.deps.allowance, auth: h.deps.auth, reserve: reserveGenerationSpend, meter,
      call: async () => ({ text: '{"invalid":"paid answer"}', costUsd: .004 }) };
    const { job } = await prepareDevelopmentJob(await approve(request, deps), 'owner', undefined, deps);
    await runDevelopmentStep(job.id, 'owner', deps);
    const [saved] = await listDevelopmentJobs('owner', request.projectId, undefined, deps);
    expect(saved.status).toBe('failed'); expect(saved.costUsd).toBe(.004);
    const intent = (await platformDb().execute({ sql: 'SELECT state FROM recovery_intents WHERE workspace_id=? AND id=?', args: [ws.id, job.id] })).rows[0];
    expect(intent.state).toBe('resolved');
    const ledger = (await platformDb().execute({ sql: 'SELECT status,engine_cost_usd FROM meter_events WHERE id=?', args: [job.id] })).rows[0];
    expect(ledger.status).toBe('failed'); expect(Number(ledger.engine_cost_usd)).toBe(.004);
  });
});
