import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';
import { seedProject, type Asset, type Project } from '../../lib/workbench/studio';
import { developmentAnswerTokens, redraftTooLong, AGENT_SCRIPT_CHARS } from '../../lib/workbench/development-plan';
import type { DevelopmentRequest } from '../../lib/workbench/development-types';
import { developmentReady, listDevelopmentJobs, prepareDevelopmentJob, quoteDevelopmentJob, rigAssetChoices, runDevelopmentStep, DEVELOPMENT_LIST_MAX, DEVELOPMENT_LIST_PER_KIND, type DevelopmentCall, type DevelopmentDependencies } from '../../lib/workbench/development-server';
import { atomikReasoningAllowance } from '../../lib/atomik-reasoning';
import type { CatalogModel } from '../../lib/catalog';

/* Production agents: the room each answer gets, what each agent is shown, and what the stages can read back. */

const dir = mkdtempSync(path.join(tmpdir(), 'particl-development-scope-'));
process.env.PLATFORM_DATABASE_URL = 'file:' + path.join(dir, 'platform.db');
process.env.KEYRING_SECRET ??= 'unit-test-keyring-secret-unit-test-keyring';
const model: CatalogModel = { id: 'anthropic/claude-sonnet-4.6', name: 'Claude', owner: 'anthropic', type: 'language', description: '', contextWindow: 1_000_000, maxTokens: 64000, pricing: { input: .0000001, output: .0000003 } };
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'unit', name: 'Unit', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys: { gateway: 'test-only-never-sent' }, usesPlatformKeys: false, allowanceUsd: null,
    gatewayKeyId: null, ownerId: 'owner', createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
function harness(reply: (input: DevelopmentCall) => unknown, models: CatalogModel[] = [model]) {
  const calls: DevelopmentCall[] = [];
  let reservations = 0;
  const deps: DevelopmentDependencies = {
    models: async () => models, allowance: async () => ({ ok: true }),
    auth: async () => ({ token: 'test-only-not-sent', method: 'api-key' }), funding: async () => {}, reservation: async () => true,
    reserve: async () => { reservations++; }, meter: async () => {},
    call: async input => { calls.push(input); return { text: JSON.stringify(input.stage === 'critique' ? { issues: ['Check continuity.'], revisions: ['Keep it.'] } : reply(input)), inputTokens: 200, outputTokens: 100, costUsd: .002 }; },
  };
  return { deps, calls, reservations: () => reservations };
}
async function save(project: Project) {
  await ready();
  await db().execute({ sql: 'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: ['owner:' + project.id, 'owner', project.id, project.name, JSON.stringify(project), Date.now()] });
}
function project(): Project {
  const p = seedProject(); p.id = 'development-' + randomUUID(); p.productionProjectId = 'real-' + randomUUID();
  return p;
}
const request = (p: Project, kind: DevelopmentRequest['kind'], extra: Partial<DevelopmentRequest> = {}): DevelopmentRequest =>
  ({ projectId: p.id, requestId: randomUUID(), kind, model: model.id, effort: 'auto', ...extra });
async function approve(input: DevelopmentRequest, deps: Partial<DevelopmentDependencies>) {
  const quote = await quoteDevelopmentJob(input, 'owner', deps);
  return { ...input, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits, maxUsd: quote.estimateUsd };
}
/** A saved run of any kind and status, with its result when it has one. */
async function insertRun(p: Project, at: number, kind: DevelopmentRequest['kind'], extra: Partial<DevelopmentRequest> = {}, status = 'succeeded', result?: Record<string, unknown>) {
  const id = 'wb_development_' + randomUUID(), input = request(p, kind, extra);
  await db().execute({ sql: `INSERT INTO workbench_development_jobs(id,owner,project_id,production_project_id,request_id,fingerprint,request_body,source_hash,snapshot,model_body,chunks,status,estimate_usd,estimate_credits,funded_by_platform,settled,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,1,?,?)`, args: [id, 'owner', p.id, p.productionProjectId!, input.requestId, 'f', JSON.stringify(input), 'h', '{}', '{}', '[{}]', status, at, at] });
  if (result) await db().execute({ sql: "INSERT INTO workbench_development_steps(job_id,step_index,chunk_index,stage,status,estimate_usd,max_tokens,result,updated_at) VALUES(?,2,0,'refine','succeeded',0,1,?,?)",
    args: [id, JSON.stringify({ summary: '', recommendation: '', ideas: [], scenes: [], critique: [], assumptions: [], ...result }), at] });
  return id;
}
const picture = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: 'image', category: 'Shot', url: `/api/media/${id}`, description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [], ...extra });
const sheet = { scriptSha256: 'a'.repeat(64), updatedAt: '2026-09-25T00:00:00Z', scenes: [{ id: 'scene-1', heading: 'EXT. HARBOUR - DUSK', summary: 'The fox crosses.', beats: [{ id: 'b1', text: 'The fox crosses the ice.' }], shots: [{ id: 'shot-1', description: 'Wide on the ice', framing: 'Wide', movement: 'Locked', lighting: 'Dusk', sound: 'Wind' }], characters: ['Mara'], locations: ['Harbour'], props: [] }] };

test('rig wiring and casting get a breakdown\'s answer room, not a planner\'s 4,000 tokens', () => {
  expect(developmentAnswerTokens('rig')).toBe(16_000);
  expect(developmentAnswerTokens('cast')).toBe(16_000);
  expect(developmentAnswerTokens('environment')).toBe(16_000);
  expect(developmentAnswerTokens('sketch')).toBe(4000);
});

test('a wired shot\'s draft and refine steps are sent with the larger ceiling', async () => {
  await runInTenant(workspace(), async () => {
    const p = project();
    await save(p);
    const h = harness(() => ({ prompt: 'Wired.', notes: '', inputs: [], firstFrame: null, critique: [], assumptions: [] }));
    const { job } = await prepareDevelopmentJob(await approve(request(p, 'rig', { nodeId: 'scene' }), h.deps), 'owner', undefined, h.deps);
    for (let i = 0; i < 3; i++) await runDevelopmentStep(job.id, 'owner', h.deps);
    expect(h.calls.map((c) => [c.stage, c.maxTokens])).toEqual([['draft', 16000], ['critique', 4000], ['refine', 16000]]);
  });
});

test('the Rig agent is offered the shot\'s own pictures first and the newest of the rest, never only the oldest 150', () => {
  const p = project();
  const old = Array.from({ length: 200 }, (_, i) => picture(`old-${i + 1}`));
  p.assets = [...p.assets, ...old,
    picture('frame', { generationId: 'gen-frame', category: 'Storyboard' }), picture('mara', { generationId: 'gen-mara', category: 'Character' }),
    picture('plate', { category: 'Environment' }), picture('newest')];
  p.production = {
    boards: { style: 'live', model: 'gemini-3.1-flash-image', frames: { 'shot-1': { prompt: '', takes: [{ genId: 'gen-frame', style: 'live', at: '' }], selected: 'gen-frame' } } },
    cast: { entries: [{ id: 'c1', name: 'Mara', kind: 'character', description: '', prompt: 'Mara', takes: [{ genId: 'gen-mara', at: '' }], selected: 'gen-mara' }] },
    environment: { world: '', model: 'gemini-3.1-flash-image', entries: [{ id: 'e1', name: 'Harbour', notes: '', prompt: '', references: [], plates: [{ assetId: 'plate', at: '', source: 'render' }], selected: 'plate' }] },
  };
  const node = { ...p.nodes.find((n) => n.id === 'scene')!, boardShotId: 'shot-1' };
  const ids = rigAssetChoices(p, node).map((a) => a.id);
  expect(ids).toHaveLength(150);
  /* What the shot already uses (its own picture and its linked inputs), then its frame, the cast and the places. */
  expect(ids.slice(0, 6)).toEqual(['hero', 'environment', 'character', 'frame', 'mara', 'plate']);
  expect(ids).toContain('newest');
  expect(ids).toContain('old-200');
  expect(ids).not.toContain('old-1');
  expect(new Set(ids).size).toBe(ids.length);
});

test('a picture past the project\'s first 150 can be wired, so a paid answer is not refused for choosing it', async () => {
  await runInTenant(workspace(), async () => {
    const p = project();
    p.assets = [...p.assets, ...Array.from({ length: 200 }, (_, i) => picture(`old-${i + 1}`)), picture('late-frame', { category: 'Storyboard' })];
    await save(p);
    const h = harness(() => ({ prompt: 'Wired.', notes: '', inputs: ['late-frame'], firstFrame: null, critique: [], assumptions: [] }));
    const { job } = await prepareDevelopmentJob(await approve(request(p, 'rig', { nodeId: 'scene' }), h.deps), 'owner', undefined, h.deps);
    for (let i = 0; i < 3; i++) await runDevelopmentStep(job.id, 'owner', h.deps);
    /* The list poll leaves wirings off; the shot reads the one it takes by its id. */
    const [listed] = await listDevelopmentJobs('owner', p.id, undefined, h.deps);
    expect(listed.status).toBe('succeeded');
    expect(listed.result).toBeNull();
    const [saved] = await listDevelopmentJobs('owner', p.id, undefined, h.deps, job.id);
    expect(saved.error).toBeNull();
    expect(saved.result?.rig?.inputs).toEqual(['late-frame']);
  });
});

test('a script too long for the writer to return whole is refused before any quote or payment', async () => {
  expect(redraftTooLong(20_000, 24_000)).toBeNull();
  expect(redraftTooLong(80_000, 24_000)).toBeNull();
  expect(redraftTooLong(190_000, 24_000)).toEqual({ pages: 106, maxPages: 46 });
  expect(redraftTooLong(145_000, 64_000)).toEqual({ pages: 81, maxPages: 77 });
  await runInTenant(workspace(), async () => {
    const p = project();
    p.script = 'EXT. HARBOUR - DUSK\n\n' + 'The fox crosses the ice, one careful step at a time.\n\n'.repeat(3600);
    p.production = { beats: sheet };
    await save(p);
    const h = harness(() => ({}));
    const pages = Math.ceil(p.script.length / 1800);
    await expect(quoteDevelopmentJob(request(p, 'write', { fromBeats: true }), 'owner', h.deps)).rejects.toThrow(`too long to redraft in one pass: about ${pages} pages, and Claude returns up to about 46`);
    expect(h.calls).toHaveLength(0);
    expect(h.reservations()).toBe(0);
  });
  await runInTenant(workspace(), async () => {
    const p = project();
    p.script = 'EXT. HARBOUR - DUSK\n\nThe fox crosses the ice.\n';
    p.production = { beats: sheet };
    await save(p);
    const quote = await quoteDevelopmentJob(request(p, 'write', { fromBeats: true }), 'owner', harness(() => ({})).deps);
    expect(quote.calls).toBe(3);
  });
});

test('cast and environment read the whole script or ask for beats; they never read a silent first part', async () => {
  for (const kind of ['cast', 'environment'] as const) {
    await runInTenant(workspace(), async () => {
      const p = project();
      p.script = 'INT. ROOM - DAY\n' + 'Mara waits.\n'.repeat(Math.ceil(AGENT_SCRIPT_CHARS / 10));
      await save(p);
      await expect(quoteDevelopmentJob(request(p, kind), 'owner', harness(() => ({})).deps)).rejects.toThrow('Break it into beats first');
    });
    await runInTenant(workspace(), async () => {
      const p = project();
      p.script = 'INT. ROOM - DAY\n' + 'Mara waits.\n'.repeat(Math.ceil(AGENT_SCRIPT_CHARS / 10));
      p.production = { beats: sheet };
      await save(p);
      expect((await quoteDevelopmentJob(request(p, kind), 'owner', harness(() => ({})).deps)).calls).toBe(3);
    });
    await runInTenant(workspace(), async () => {
      const p = project();
      p.script = 'INT. ROOM - DAY\nMara waits.\nEXT. PIER - NIGHT\nThe late arrival steps off the boat.';
      await save(p);
      const h = harness(() => ({}));
      await quoteDevelopmentJob(request(p, kind), 'owner', h.deps);
    });
  }
});

test('each stage finds its own runs: ten Rig shots wired in a row do not push the Brief\'s draft or older shots out', async () => {
  await runInTenant(workspace(), async () => {
    const p = project();
    await save(p);
    await developmentReady();
    let at = 1_000;
    const insert = (kind: DevelopmentRequest['kind'], extra: Partial<DevelopmentRequest> = {}) => insertRun(p, at++, kind, extra);
    const draft = await insert('write');
    const cast = await insert('cast');
    const shots: string[] = [];
    for (let i = 0; i < 14; i++) shots.push(await insert('rig', { nodeId: `node-${i}` }));
    const again = await insert('rig', { nodeId: 'node-0' });
    const castRuns: string[] = [];
    for (let i = 0; i < 12; i++) castRuns.push(await insert('cast'));
    const jobs = await listDevelopmentJobs('owner', p.id, undefined, harness(() => ({})).deps);
    const ids = new Set(jobs.map((job) => job.id));
    expect(ids.has(draft)).toBe(true);
    /* Every Rig shot keeps its newest run; node-0's older run is past the newest ten of its kind. */
    for (const id of shots.slice(1)) expect(ids.has(id)).toBe(true);
    expect(ids.has(again)).toBe(true);
    expect(ids.has(shots[0])).toBe(false);
    /* A kind with no target keeps its newest ten. */
    expect(jobs.filter((job) => job.kind === 'cast').map((job) => job.id)).toEqual(castRuns.slice(-DEVELOPMENT_LIST_PER_KIND).reverse());
    expect(ids.has(cast)).toBe(false);
    expect(jobs.map((job) => job.createdAt)).toEqual([...jobs.map((job) => job.createdAt)].sort((a, b) => b - a));
  });
});

test('past the cap, targeted runs give way first: hundreds of wired shots never push out the Brief draft, the cast or a running job', async () => {
  await runInTenant(workspace(), async () => {
    const p = project();
    await save(p);
    await developmentReady();
    let at = 1_000;
    const draft = await insertRun(p, at++, 'write', {}, 'succeeded', { script: { title: 'Ice', logline: '', text: 'EXT. HARBOUR - DUSK', notes: [] } });
    const olderCast = await insertRun(p, at++, 'cast', {}, 'succeeded', { cast: [] });
    const cast = await insertRun(p, at++, 'cast', {}, 'succeeded', { cast: [] });
    /* Still running, though a later run of the same shot has finished. */
    const running = await insertRun(p, at++, 'rig', { nodeId: 'node-0' }, 'running');
    const shots: string[] = [];
    for (let i = 0; i < DEVELOPMENT_LIST_MAX + 50; i++) shots.push(await insertRun(p, at++, 'rig', { nodeId: `node-${i}` }, 'succeeded', { rig: { nodeId: `node-${i}`, prompt: 'Wired.', notes: '', inputs: [], firstFrame: null } }));
    const jobs = await listDevelopmentJobs('owner', p.id, undefined, harness(() => ({})).deps);
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(jobs).toHaveLength(DEVELOPMENT_LIST_MAX);
    for (const id of [draft, olderCast, cast, running]) expect(byId.has(id)).toBe(true);
    /* The rest of the room goes to the newest shots; the oldest give way. */
    const room = DEVELOPMENT_LIST_MAX - 4;
    for (const id of shots.slice(-room)) expect(byId.has(id)).toBe(true);
    for (const id of shots.slice(0, -room)) expect(byId.has(id)).toBe(false);
    expect(jobs.map((job) => job.createdAt)).toEqual([...jobs.map((job) => job.createdAt)].sort((a, b) => b - a));
    /* A poll carries the results the stages apply, not every run's: the newest draft and cast, no wirings (a shot reads its own by id). */
    expect(byId.get(draft)!.result?.script?.title).toBe('Ice');
    expect(byId.get(cast)!.result?.cast).toEqual([]);
    expect(byId.get(olderCast)!.result).toBeNull();
    expect(jobs.filter((job) => job.kind === 'rig' && job.result)).toHaveLength(0);
  });
});

test('a shot\'s newest finished run stays listed when a later retry failed, with its result when the stage applies it from the list', async () => {
  await runInTenant(workspace(), async () => {
    const p = project();
    await save(p);
    await developmentReady();
    let at = 1_000;
    const wired = await insertRun(p, at++, 'rig', { nodeId: 'node-a' }, 'succeeded', { rig: { nodeId: 'node-a', prompt: 'Wired.', notes: '', inputs: [], firstFrame: null } });
    const condensed = await insertRun(p, at++, 'condense', { nodeId: 'node-a' }, 'succeeded', { condensed: { nodeId: 'node-a', key: 'k', text: 'Short.' } });
    const framed = await insertRun(p, at++, 'frames', { shotId: 'shot-a' }, 'succeeded', { frames: [{ shotId: 'shot-a', prompt: 'Wide on the ice.' }] });
    for (let i = 0; i < DEVELOPMENT_LIST_PER_KIND + 2; i++) {
      await insertRun(p, at++, 'rig', { nodeId: `node-${i}` });
      await insertRun(p, at++, 'condense', { nodeId: `node-${i}` });
      await insertRun(p, at++, 'frames', { shotId: `shot-${i}` });
    }
    const failed = [await insertRun(p, at++, 'rig', { nodeId: 'node-a' }, 'failed'), await insertRun(p, at++, 'condense', { nodeId: 'node-a' }, 'failed'), await insertRun(p, at++, 'frames', { shotId: 'shot-a' }, 'failed')];
    const jobs = await listDevelopmentJobs('owner', p.id, undefined, harness(() => ({})).deps);
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const id of [wired, condensed, framed, ...failed]) expect(byId.has(id)).toBe(true);
    expect(byId.get(condensed)!.result?.condensed?.text).toBe('Short.');
    expect(byId.get(framed)!.result?.frames?.[0].prompt).toBe('Wide on the ice.');
    expect(byId.get(wired)!.result).toBeNull();
    const [read] = await listDevelopmentJobs('owner', p.id, undefined, harness(() => ({})).deps, wired);
    expect(read.result?.rig?.prompt).toBe('Wired.');
  });
});

test('the Rig agent is offered every chosen look and every place before any entry\'s older takes', () => {
  const p = project();
  const cast = Array.from({ length: 9 }, (_, c) => `c${c}`);
  /* Twenty takes each, stored newest first (take 0 is the newest); the look chosen is an older take. */
  const takes = cast.flatMap((c) => Array.from({ length: 20 }, (_, i) => picture(`${c}-take-${19 - i}`, { generationId: `gen-${c}-${19 - i}`, category: 'Character' })));
  p.assets = [...p.assets, ...Array.from({ length: 200 }, (_, i) => picture(`old-${i + 1}`)), ...takes,
    picture('frame-old', { category: 'Storyboard' }), picture('frame-new', { category: 'Storyboard' }),
    picture('plate-1-old', { category: 'Environment' }), picture('plate-1-new', { category: 'Environment' }), picture('plate-2', { category: 'Environment' }),
    picture('ref-2a', { category: 'Environment' }), picture('ref-2b', { category: 'Environment' }), picture('newest')];
  p.production = {
    boards: { style: 'live', model: 'gemini-3.1-flash-image', frames: { 'shot-1': { prompt: '', takes: [{ genId: 'frame-new', style: 'live', at: '' }, { genId: 'frame-old', style: 'live', at: '' }], selected: 'frame-old' } } },
    cast: { entries: cast.map((c) => ({ id: c, name: c, kind: 'character' as const, description: '', prompt: c, takes: Array.from({ length: 20 }, (_, i) => ({ genId: `gen-${c}-${i}`, at: '' })), selected: `gen-${c}-7` })) },
    environment: { world: '', model: 'gemini-3.1-flash-image', entries: [
      { id: 'e1', name: 'Harbour', notes: '', prompt: '', references: [], plates: [{ assetId: 'plate-1-new', at: '', source: 'render' }, { assetId: 'plate-1-old', at: '', source: 'render' }], selected: 'plate-1-old' },
      { id: 'e2', name: 'Hut', notes: '', prompt: '', references: ['ref-2a', 'ref-2b'], plates: [{ assetId: 'plate-2', at: '', source: 'upload' }] },
    ] },
  };
  const node = { ...p.nodes.find((n) => n.id === 'scene')!, boardShotId: 'shot-1' };
  const ids = rigAssetChoices(p, node).map((a) => a.id);
  expect(ids).toHaveLength(150);
  expect(new Set(ids).size).toBe(ids.length);
  /* What the shot uses and its frame's pick, then every chosen look, every place's pick and its references. */
  expect(ids.slice(0, 4)).toEqual(['hero', 'environment', 'character', 'frame-old']);
  expect(ids.slice(4, 16)).toEqual([...cast.map((c) => `${c}-take-7`), 'plate-1-old', 'ref-2b', 'ref-2a']);
  expect(ids[16]).toBe('frame-new');
  /* Each entry's newest take and every plate come before any entry's older takes; the oldest takes give way. */
  for (const id of [...cast.map((c) => `${c}-take-0`), 'plate-1-new', 'plate-2']) expect(ids.indexOf(id)).toBeLessThan(ids.indexOf('c0-take-1'));
  expect(ids).not.toContain('c0-take-19');
  expect(ids).not.toContain('newest');
});

test('a redraft is sized by the room the reasoning leaves, not the whole output ceiling', async () => {
  /* Sonnet 4.5 answers within 8,192 tokens; a 4,096 thinking budget leaves about 4,096 for the script (about 14,000 characters). */
  const sonnet: CatalogModel = { ...model, id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', maxTokens: 64_000 };
  /* A 32k model at high effort keeps 16,384 tokens for the answer (about 57,000 characters). */
  const effortful: CatalogModel = { ...model, id: 'openai/gpt-5.6-sol', name: 'GPT Sol', owner: 'openai', maxTokens: 32_768, reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }] };
  expect(atomikReasoningAllowance(sonnet, 'budget:4096')).toBe(4096);
  expect(atomikReasoningAllowance(sonnet, 'none')).toBe(0);
  expect(atomikReasoningAllowance(effortful, 'high')).toBe(16_384);
  expect(atomikReasoningAllowance(model, 'auto')).toBe(0);
  const scene = 'The fox crosses the ice, one careful step at a time.\n\n';
  for (const [chosen, chars, heavy, light] of [[sonnet, 20_000, 'budget:4096', 'none'], [effortful, 60_000, 'high', 'low']] as const) {
    await runInTenant(workspace(), async () => {
      const p = project();
      p.script = 'EXT. HARBOUR - DUSK\n\n' + scene.repeat(Math.ceil(chars / scene.length));
      p.production = { beats: sheet };
      await save(p);
      const h = harness(() => ({}), [chosen]);
      await expect(quoteDevelopmentJob(request(p, 'write', { fromBeats: true, model: chosen.id, effort: heavy }), 'owner', h.deps)).rejects.toThrow(`too long for ${chosen.name} to redraft whole at this effort`);
      expect(h.calls).toHaveLength(0);
      expect(h.reservations()).toBe(0);
      expect((await quoteDevelopmentJob(request(p, 'write', { fromBeats: true, model: chosen.id, effort: light }), 'owner', h.deps)).calls).toBe(3);
    });
  }
});
