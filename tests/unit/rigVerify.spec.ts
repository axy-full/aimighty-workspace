import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';
import { newProject, type Asset, type CanvasNode, type Project } from '../../lib/workbench/studio';
import { canvasNodeSchema } from '../../lib/workbench/studio-schema';
import { developmentStages } from '../../lib/workbench/development-plan';
import { developmentInput } from '../../lib/workbench/development-client';
import type { DevelopmentRequest } from '../../lib/workbench/development-types';
import { executeDevelopmentAgent, listDevelopmentJobs, prepareDevelopmentJob, quoteDevelopmentJob, runDevelopmentStep, type DevelopmentCall, type DevelopmentDependencies, type DevelopmentError } from '../../lib/workbench/development-server';
import {
  VERIFY_RUBRIC, VERIFY_THRESHOLDS, checkVerdict, framesKey, holdWorthSaying, masterSetKey, mediaIdentity, overallVerdict, verdictLine, verificationFor, verificationStanding,
  verifyCardFor, verifyFrameUrl, verifyKeyOf, verifyParts, verifySubject, withVerifyLast, type TakeVerification,
} from '../../lib/workbench/verify';
import { VERIFY_CHECK_TOKENS, VERIFY_IMAGE_TOKENS, VERIFY_SUMMARY_TOKENS, mockColourScore, readVerifyAnswer, verifyChunk, verifyLikelyTokens, verifyPrompt, type VerifySnapshot } from '../../lib/workbench/verify-judge';
import { ALREADY_CHECKED, CHECK_RUNNING, listVerifications, mockVerifyReply, verifyKeyHashes } from '../../lib/workbench/verify-server';
import { ATOMIK_IMAGE_TOKENS } from '../../lib/workbench/atomik-reference-types';
import { textCostUsd, type CatalogModel } from '../../lib/catalog';
import { billCredits } from '../../lib/creditTerms';
import type { MeterEvent } from '../../lib/meter';

/* The agentic Rig, step 5 (plan PR 7): a Verify card checks a take against its masters, priced first, free to read again. */

const dir = mkdtempSync(path.join(tmpdir(), 'particl-rig-verify-'));
process.env.PLATFORM_DATABASE_URL = 'file:' + path.join(dir, 'platform.db');
process.env.KEYRING_SECRET ??= 'unit-test-keyring-secret-unit-test-keyring';
/** Test fixture only: a priced vision model (prices are the fixture's, not a real rate card). */
const model: CatalogModel = { id: 'anthropic/claude-sonnet-4.6', name: 'Claude', owner: 'anthropic', type: 'language', description: '', contextWindow: 1_000_000, maxTokens: 64000,
  pricing: { input: .0000001, output: .0000003 }, inputModalities: ['text', 'image'], outputModalities: ['text'] };
const blind: CatalogModel = { ...model, inputModalities: ['text'] };
/** Test fixture only: a vision model that thinks, priced so its ceiling and its usual use differ by whole credits (the fixture's prices, not a real rate card). */
const thinker: CatalogModel = { ...model, tags: ['reasoning'], pricing: { input: .00002, output: .0001 } };
/** A workspace on the platform's keys: its checks are priced and charged in credits. */
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'unit', name: 'Unit', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null,
    gatewayKeyId: null, ownerId: 'owner', createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
/** The same workspace and database, as another server instance reaches them: with its own in-process queue of starts (prepareDevelopmentJob's spans one instance). */
const elsewhere = (ws: TenantWorkspace): TenantWorkspace => ({ ...ws, dbUrl: ws.dbUrl.replace(/^file:/, 'file://') });
/** The scripted judge: scores per check, as a model would answer. */
function harness(scores: Record<string, number | { score: number; seen?: boolean }>, models: CatalogModel[] = [model]) {
  const calls: DevelopmentCall[] = [], events: MeterEvent[] = [], reserved: MeterEvent[] = [];
  let reservations = 0;
  const deps: DevelopmentDependencies = {
    models: async () => models, allowance: async () => ({ ok: true }),
    auth: async () => ({ token: 'test-only-not-sent', method: 'api-key' }), funding: async () => {}, reservation: async () => true,
    reserve: async (event) => { reservations++; reserved.push(event); }, meter: async (event) => { events.push(event); },
    call: async (input) => {
      calls.push(input);
      const asked = (JSON.parse(input.prompt) as { checks: { check: string }[] }).checks.map((c) => c.check);
      return { text: JSON.stringify({ checks: asked.filter((c) => c in scores).map((check) => {
        const s = scores[check], score = typeof s === 'number' ? s : s.score;
        return { check, score, seen: typeof s === 'number' ? true : s.seen ?? true, reasons: [`Scripted ${check}.`], frame: 1, verdict: 'pass' };
      }), summary: 'Scripted judge.' }), inputTokens: 5000, outputTokens: 300 };
    },
  };
  return { deps, calls, events, reserved, reservations: () => reservations };
}
/** An allowance check that lets starts through only once `n` have reached it: each has passed the free check (nothing stored, nothing running) and none has claimed yet. */
function meeting(n: number): DevelopmentDependencies['allowance'] {
  let arrived = 0, open!: () => void;
  const met = new Promise<void>((resolve) => { open = resolve; });
  return async () => { if (++arrived === n) open(); await met; return { ok: true }; };
}

const sample = (id: string, name: string, category: string, file: 'hero' | 'character' | 'environment', extra: Partial<Asset> = {}): Asset => ({
  id, name, kind: 'image', category, url: `/campaign/${file}.webp`, description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [], ...extra,
});
const card = (id: string, title: string, type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title, type, x: 0, y: 0, width: 220, linked: [], ...extra });
/** Test fixtures only: a cast card, a place, a ref, a shot with a take, and its Verify card. */
function fixture(): Project {
  const project = newProject('Verify study');
  project.id = 'verify-' + randomUUID();
  project.productionProjectId = 'prod-' + randomUUID();
  project.assets = [
    sample('face', 'Wren study', 'Character', 'character'),
    sample('plate', 'Dunes plate', 'Environment', 'environment'),
    sample('frame', 'Harbour still', 'Reference', 'hero'),
    sample('take', 'The opening v1', 'Take', 'character', { nodeId: 'open' }),
    sample('face2', 'Wren, new wardrobe', 'Character', 'hero'),
  ];
  project.nodes = [
    card('wren', 'Wren', 'character', { assetId: 'face', elementId: 'el-wren' }),
    card('dunes', 'The dunes', 'element', { assetId: 'plate' }),
    card('board', 'Harbour board', 'media', { assetId: 'frame' }),
    card('open', 'The opening', 'scene', { assetId: 'take', linked: ['wren', 'dunes', 'board'], width: 238 }),
    card('check', 'Verify · The opening', 'review', { linked: ['open', 'wren', 'dunes', 'board'], verify: { rubric: 1, frames: { videoAt: [0.1, 0.5, 0.9], max: 3 } } }),
  ];
  return project;
}
async function save(project: Project) {
  await ready();
  await db().execute({ sql: 'INSERT OR REPLACE INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: ['owner:' + project.id, 'owner', project.id, project.name, JSON.stringify(project), Date.now()] });
}
const request = (project: Project, extra: Partial<DevelopmentRequest> = {}): DevelopmentRequest => ({ projectId: project.id, requestId: randomUUID(), kind: 'verify', model: model.id, effort: 'auto', nodeId: 'check', ...extra });
async function approve(input: DevelopmentRequest, deps: Partial<DevelopmentDependencies>) {
  const quote = await quoteDevelopmentJob(input, 'owner', deps);
  return { quote, approved: { ...input, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits, maxUsd: quote.estimateUsd } };
}

test('the thresholds decide each verdict: pass and fail at their bounds, anything between or unseen is unsure, and unsure needs a person', () => {
  const t = VERIFY_THRESHOLDS.identity;
  expect(checkVerdict('identity', t.pass)).toBe('pass');
  expect(checkVerdict('identity', t.pass - 0.001)).toBe('unsure');
  expect(checkVerdict('identity', t.fail + 0.001)).toBe('unsure');
  expect(checkVerdict('identity', t.fail)).toBe('fail');
  expect(checkVerdict('identity', 1, false)).toBe('unsure');
  for (const bad of [null, undefined, Number.NaN, -0.1, 1.2]) expect(checkVerdict('props', bad as number)).toBe('unsure');
  for (const check of Object.keys(VERIFY_THRESHOLDS) as (keyof typeof VERIFY_THRESHOLDS)[]) expect(VERIFY_THRESHOLDS[check].fail).toBeLessThan(VERIFY_THRESHOLDS[check].pass);
  expect(overallVerdict([{ verdict: 'pass' }, { verdict: 'pass' }])).toBe('pass');
  expect(overallVerdict([{ verdict: 'pass' }, { verdict: 'unsure' }])).toBe('needs_you');
  expect(overallVerdict([{ verdict: 'unsure' }, { verdict: 'fail' }])).toBe('fail');
  expect(overallVerdict([])).toBe('needs_you');
  const row = (check: 'identity' | 'props' | 'artifacts', verdict: 'pass' | 'fail' | 'unsure') => ({ check, verdict, score: null, reasons: [], frame: null });
  expect(verdictLine([row('identity', 'fail'), row('props', 'unsure'), row('artifacts', 'pass')])).toBe('Identity failed · Props unsure');
  expect(verdictLine([row('props', 'unsure')])).toBe('Props unsure');
  expect(verdictLine([row('identity', 'pass'), row('artifacts', 'pass')])).toBe('2 checks passed');
  expect(verifyFrameUrl({ t: 0.5, uploadId: 'still-1', sha256: 'x' }, 'upload:clip')).toBe('/api/workbench/preview/upload/still-1');
  expect(verifyFrameUrl(null, 'generation:g1')).toBe('/api/workbench/preview/generation/g1');
  expect(verifyFrameUrl(undefined, 'sample:/campaign/hero.webp')).toBe('/campaign/hero.webp');
  expect(verifyFrameUrl(undefined, 'sample:https://example.test/x.png')).toBeNull();
});

test('the code reads the judge: a missing, unseen or out-of-range check is unsure, a claimed verdict is ignored, frames and reasons are bounded', () => {
  const v = { nodeId: 'check', key: { takeId: 'upload:t', masterSet: '', rubric: 1, framesKey: 'video:0.1,0.5,0.9' }, checks: ['identity', 'wardrobe', 'props', 'artifacts'] as const, frames: [0, 1, 2].map((i) => ({ t: i, uploadId: `f${i}`, sha256: 'x', image: i + 1 })) };
  const result = readVerifyAnswer({ verdict: 'pass', checks: [
    { check: 'identity', score: 0.95, seen: true, reasons: ['a', 'b', 'c', 'd'], frame: 2, verdict: 'pass' },
    { check: 'identity', score: 0.1, seen: true, reasons: [], frame: 1 },
    { check: 'wardrobe', score: 0.99, seen: false, reasons: ['Back to camera.'], frame: 9 },
    { check: 'props', score: 7, seen: true, reasons: [], frame: null },
    { check: 'invented', score: 1, seen: true, reasons: [], frame: 1 },
  ] }, { ...v, checks: [...v.checks] });
  expect(result.checks.map((c) => [c.check, c.verdict])).toEqual([['identity', 'pass'], ['wardrobe', 'unsure'], ['props', 'unsure'], ['artifacts', 'unsure']]);
  expect(result.checks[0]).toMatchObject({ reasons: ['a', 'b', 'c'], frame: 1, score: 0.95 });
  expect(result.checks[1].frame).toBeNull();
  expect(result.checks[1].reasons).toContain('The take does not show what this check needs.');
  expect(result.checks[2].score).toBeNull();
  expect(result.checks[3].reasons).toEqual(['The judge did not answer this check.']);
  expect(result.verdict).toBe('needs_you');
  expect(result.takeId).toBe('upload:t');
});

test('a card checks its one take against its Cast, Environment and Element cards; Refs are context; problems are named', () => {
  const project = fixture();
  const subject = verifySubject(project, project.nodes.find((n) => n.id === 'check')!);
  expect(subject.problem).toBeNull();
  expect(subject.take?.identity).toBe('sample:/campaign/character.webp');
  expect(subject.masters.map((m) => [m.node.id, m.kind])).toEqual([['wren', 'cast'], ['dunes', 'environment']]);
  expect(subject.context.map((n) => n.id)).toEqual(['board']);
  expect(subject.checks).toEqual(['identity', 'wardrobe', 'environment', 'artifacts']);
  const key = verifyKeyOf(subject)!;
  expect(key).toEqual({ takeId: 'sample:/campaign/character.webp', masterSet: 'cast:sample:/campaign/character.webp|environment:sample:/campaign/environment.webp', rubric: VERIFY_RUBRIC, framesKey: 'still' });
  const withNodes = (nodes: CanvasNode[]) => verifySubject({ ...project, nodes }, nodes.find((n) => n.id === 'check')!).problem;
  const at = (patch: Partial<CanvasNode>, id = 'check') => project.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
  expect(withNodes(at({ linked: ['wren'] }))).toMatch(/Wire a shot/);
  expect(withNodes([...project.nodes, card('two', 'Second', 'generate')].map((n) => (n.id === 'check' ? { ...n, linked: [...n.linked, 'two'] } : n)))).toMatch(/one shot/);
  expect(withNodes(at({ assetId: undefined }, 'open').map((n) => n))).toBeNull();
  expect(verifySubject({ ...project, assets: project.assets.filter((a) => a.id !== 'take'), nodes: at({ assetId: undefined }, 'open') }, project.nodes[4]).problem).toMatch(/no take yet/);
  expect(withNodes(at({ assetId: undefined }, 'wren'))).toMatch(/Wren has no picture yet/);
  const video = { ...project, assets: [...project.assets, { ...sample('clip', 'Turntable', 'Element', 'hero'), kind: 'video' as const, url: '/api/uploads/clip-1', uploadId: 'clip-1' }] };
  expect(verifySubject(video, { ...project.nodes[4], linked: ['open', 'lamp'] }).problem).toBeNull();
  expect(verifySubject({ ...video, nodes: [...video.nodes, card('lamp', 'Lamp', 'element', { assetId: 'clip', refKind: 'element' })] }, { ...project.nodes[4], linked: ['open', 'lamp'] }).problem).toMatch(/is a video/);
  const many = Array.from({ length: 6 }, (_, i) => card(`m${i}`, `Master ${i}`, 'character', { assetId: 'face' }));
  expect(verifySubject({ ...project, nodes: [...project.nodes, ...many] }, { ...project.nodes[4], linked: ['open', ...many.map((m) => m.id)] }).problem).toMatch(/at most 5 masters/);
});

test('the key: identities of immutable media, a master set that ignores order and duplicates, frames by kind', () => {
  expect(mediaIdentity({ generationId: 'g1', url: '/x', kind: 'image' })).toBe('generation:g1');
  expect(mediaIdentity({ url: '/api/uploads/u1', kind: 'image' })).toBe('upload:u1');
  expect(mediaIdentity({ url: '/api/media/g2', kind: 'video' })).toBe('generation:g2');
  expect(mediaIdentity({ url: '/campaign/hero.webp', kind: 'image' })).toBe('sample:/campaign/hero.webp');
  expect(mediaIdentity({ url: 'https://example.test/a.png', kind: 'image' })).toBeNull();
  const a = [{ kind: 'element' as const, identity: 'upload:b' }, { kind: 'cast' as const, identity: 'upload:a' }];
  expect(masterSetKey(a)).toBe(masterSetKey([...a].reverse()));
  expect(masterSetKey([...a, a[0]])).toBe(masterSetKey(a));
  expect(masterSetKey([{ kind: 'cast', identity: 'upload:a' }])).not.toBe(masterSetKey([{ kind: 'element', identity: 'upload:a' }]));
  expect(framesKey({ kind: 'video' })).toBe('video:0.1,0.5,0.9');
  expect(framesKey({ kind: 'image' })).toBe('still');
  const hashes = verifyKeyHashes({ takeId: 'upload:t', masterSet: 'cast:upload:a', rubric: 1, framesKey: 'still' });
  expect(hashes.masterSetHash).toMatch(/^[a-f0-9]{64}$/);
  expect(hashes.framesHash).not.toBe(verifyKeyHashes({ takeId: 'upload:t', masterSet: 'cast:upload:a', rubric: 1, framesKey: 'video:0.1,0.5,0.9' }).framesHash);
});

test('a stored check stands against what its card checks now: the same key anywhere is current, a new master is older, a new take is earlier', () => {
  const project = fixture(), node = project.nodes[4];
  const subject = verifySubject(project, node), key = verifyKeyOf(subject)!;
  const stored = (over: Partial<TakeVerification>): TakeVerification => ({ id: 'v' + Math.random(), takeId: key.takeId, verifyNodeId: 'check', masterSet: key.masterSet, rubric: 1, framesKey: 'still',
    masters: [], frames: [], checks: [], verdict: 'pass', judgeModel: model.id, credits: 2, ownKey: false, createdAt: 1, ...over });
  expect(verificationFor([stored({ verifyNodeId: 'another-card' })], 'check', subject)?.standing).toBe('current');
  const changed = { ...project, nodes: project.nodes.map((n) => (n.id === 'wren' ? { ...n, assetId: 'face2' } : n)) };
  const now = verifySubject(changed, node);
  expect(verificationFor([stored({})], 'check', now)?.standing).toBe('older-master');
  expect(verificationStanding(stored({ takeId: 'upload:older' }), verifyParts(now))).toBe('older-take');
  expect(verificationStanding(stored({ rubric: 0 }), verifyParts(subject))).toBe('older-rubric');
  expect(verificationFor([stored({ verifyNodeId: 'another-card', masterSet: 'x' })], 'check', subject)).toBeNull();
});

test('Verify this take makes one card wired to the shot and its masters, reuses it after, and the card keeps its last verdict', () => {
  const project = fixture();
  const base = { ...project, nodes: project.nodes.filter((n) => n.id !== 'check') };
  const made = verifyCardFor(base, 'open', 'node-verify');
  const verify = made.project.nodes.find((n) => n.id === 'node-verify')!;
  expect(verify).toMatchObject({ type: 'review', linked: ['open', 'wren', 'dunes'], verify: { rubric: 1, frames: { videoAt: [0.1, 0.5, 0.9], max: 3 } } });
  expect(canvasNodeSchema.safeParse(verify).success).toBe(true);
  expect(verifyCardFor(made.project, 'open').id).toBe('node-verify');
  expect(verifyCardFor(made.project, 'open').project).toBe(made.project);
  /* A master wired into the shot later joins its card. */
  const more = { ...made.project, assets: [...made.project.assets, sample('prop', 'Lamp', 'Element', 'hero')], nodes: [...made.project.nodes.map((n) => (n.id === 'open' ? { ...n, linked: [...n.linked, 'lamp'] } : n)), card('lamp', 'Lamp', 'element', { assetId: 'prop' })] };
  expect(verifyCardFor(more, 'open').project.nodes.find((n) => n.id === 'node-verify')!.linked).toEqual(['open', 'wren', 'dunes', 'lamp']);
  expect(() => verifyCardFor(made.project, 'wren')).toThrow('Choose a shot first.');
  const last = { id: 'wb_development_1', takeId: 'upload:t', verdict: 'fail' as const, at: 5 };
  const withLast = withVerifyLast(made.project, 'node-verify', last);
  expect(withLast.nodes.find((n) => n.id === 'node-verify')!.verify?.last).toEqual(last);
  expect(canvasNodeSchema.parse(withLast.nodes.find((n) => n.id === 'node-verify')).verify?.last).toEqual(last);
  expect(withVerifyLast(withLast, 'node-verify', last)).toBe(withLast);
  expect(withVerifyLast(made.project, 'wren', last)).toBe(made.project);
});

test('the mock judge scores by average colour: the same picture passes, a near one is unsure, another fails, and no provider is called', async () => {
  const still = async (r: number, g: number, b: number) => 'data:image/jpeg;base64,' + (await sharp({ create: { width: 48, height: 48, channels: 3, background: { r, g, b } } }).jpeg({ quality: 80 }).toBuffer()).toString('base64');
  expect(mockColourScore([10, 10, 10], [10, 10, 10])).toBe(1);
  expect(mockColourScore([255, 0, 0], [0, 0, 255])).toBe(0);
  const snapshot = { take: { assetId: 't', title: 'Shot', name: 't', kind: 'image' as const, version: 1, identity: 'upload:t' }, frames: [{ t: null, uploadId: null, sha256: 'a', image: 1 }],
    masters: [{ nodeId: 'm', kind: 'cast' as const, title: 'Wren', assetId: 'm', name: 'm', version: 1, identity: 'upload:m', sha256: 'b', image: 2 }], checks: ['identity', 'artifacts'] as VerifySnapshot['checks'] };
  const judge = async (take: string, master: string) => readVerifyAnswer(JSON.parse((await mockVerifyReply({ prompt: verifyPrompt(snapshot), images: [take, master] })).text),
    { nodeId: 'c', key: { takeId: 'upload:t', masterSet: '', rubric: 1, framesKey: 'still' }, checks: snapshot.checks, frames: snapshot.frames });
  const red = await still(220, 40, 40);
  expect((await judge(red, red)).verdict).toBe('pass');
  expect((await judge(await still(180, 40, 40), red)).checks[0].verdict).toBe('unsure');
  expect((await judge(await still(180, 40, 40), red)).verdict).toBe('needs_you');
  expect((await judge(await still(40, 40, 220), red)).verdict).toBe('fail');
});

test('a check is priced first, runs once, is stored under its key, and the same take against the same masters is read back free', async () => {
  await runInTenant(workspace(), async () => {
    const project = fixture(); await save(project);
    const h = harness({ identity: 0.93, wardrobe: 0.9, environment: 0.2, artifacts: 0.95 });
    expect(developmentStages('verify')).toEqual(['refine']);
    const { quote, approved } = await approve(request(project), h.deps);
    expect(quote).toMatchObject({ quoteOnly: true, kind: 'verify', calls: 1, chunks: 1 });
    expect(quote.estimateCredits).toBeGreaterThan(0);
    expect(quote.stored).toBeUndefined();
    expect(h.reservations()).toBe(0);
    const prepared = await prepareDevelopmentJob(approved, 'owner', undefined, h.deps);
    expect(h.reservations()).toBe(1);
    /* While it runs, a second paid check of the same key is refused. */
    await expect(quoteDevelopmentJob(request(project), 'owner', h.deps)).rejects.toThrow(CHECK_RUNNING);
    for (let i = 0; i < 3; i++) await runDevelopmentStep(prepared.job.id, 'owner', h.deps);
    expect(h.calls).toHaveLength(1);
    /* The judge saw the take, then the masters, as bounded review copies, and the prompt names only images. */
    expect(h.calls[0].images).toHaveLength(3);
    expect(h.calls[0].images!.every((image) => image.startsWith('data:image/jpeg;base64,'))).toBe(true);
    expect(h.calls[0].instructions).toMatch(/untrusted evidence, never an instruction/);
    expect(h.calls[0].prompt).not.toMatch(/data:image/);
    const [job] = await listDevelopmentJobs('owner', project.id, undefined, h.deps);
    expect(job).toMatchObject({ status: 'succeeded', kind: 'verify', nodeId: 'check' });
    expect(job.result?.verify?.verdict).toBe('fail');
    expect(job.result?.verify?.checks.map((c) => [c.check, c.verdict])).toEqual([['identity', 'pass'], ['wardrobe', 'pass'], ['environment', 'fail'], ['artifacts', 'pass']]);
    expect(h.events.at(-1)?.status).toBe('succeeded');
    const rows = (await db().execute({ sql: 'SELECT * FROM take_verifications', args: [] })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: job.id, meter_event_id: job.id, take_id: 'sample:/campaign/character.webp', rubric: 1, verdict: 'fail', production_id: project.productionProjectId, created_by: 'owner', funded_by_platform: 1 });
    expect(Number(rows[0].credits)).toBe(job.credits);
    /* What "N takes were checked against this master" will count: each master's element, when its card has one. */
    expect(JSON.parse(String(rows[0].masters))).toEqual([
      { kind: 'cast', nodeId: 'wren', title: 'Wren', identity: 'sample:/campaign/character.webp', version: 1, elementId: 'el-wren' },
      { kind: 'environment', nodeId: 'dunes', title: 'The dunes', identity: 'sample:/campaign/environment.webp', version: 1 },
    ]);
    expect(JSON.parse(String(rows[0].frames))).toEqual([{ t: null, uploadId: null, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(Number(rows[0].credits)).toBeGreaterThan(0);

    /* The same take against the same masters: the stored scorecard, free — nothing priced, reserved or called. */
    const again = await quoteDevelopmentJob(request(project), 'owner', h.deps);
    expect(again).toMatchObject({ estimateCredits: 0, calls: 0, stored: { id: job.id, verdict: 'fail', standing: 'current' } });
    await expect(prepareDevelopmentJob({ ...approved, requestId: randomUUID() }, 'owner', undefined, h.deps)).rejects.toThrow(ALREADY_CHECKED);
    expect(h.reservations()).toBe(1);
    expect(h.calls).toHaveLength(1);
    /* The key is unique: a second row for it is refused by the table itself. */
    const copy = { ...rows[0], id: 'another' } as Record<string, unknown>;
    const columns = Object.keys(copy);
    await expect(db().execute({ sql: `INSERT INTO take_verifications(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, args: columns.map((c) => copy[c] as string | number) })).rejects.toThrow(/UNIQUE/);

    /* A new master version is a new key: "checked against an older master", and a new check is priced again. */
    const changed = { ...project, nodes: project.nodes.map((n) => (n.id === 'wren' ? { ...n, assetId: 'face2' } : n)) };
    await save(changed);
    const listed = await listVerifications('owner', project.id);
    expect(listed.verifications.map((v) => [v.id, v.standing, v.mastersCurrent])).toEqual([[job.id, 'older-master', false]]);
    const priced = await quoteDevelopmentJob(request(changed), 'owner', h.deps);
    expect(priced.stored).toBeUndefined();
    expect(priced.estimateCredits).toBeGreaterThan(0);
    expect(priced.sourceHash).not.toBe(quote.sourceHash);
  });
});

test('an unsure check needs a person; a check needs a model that can see; frames only for a video take; no attachments', async () => {
  await runInTenant(workspace(), async () => {
    const project = fixture(); await save(project);
    const h = harness({ identity: { score: 0.97, seen: false }, wardrobe: 0.95, environment: 0.9, artifacts: 0.6 });
    const { approved } = await approve(request(project), h.deps);
    const prepared = await prepareDevelopmentJob(approved, 'owner', undefined, h.deps);
    for (let i = 0; i < 3; i++) await runDevelopmentStep(prepared.job.id, 'owner', h.deps);
    const [job] = await listDevelopmentJobs('owner', project.id, undefined, h.deps);
    expect(job.result?.verify?.verdict).toBe('needs_you');
    expect(job.result?.verify?.checks.filter((c) => c.verdict === 'unsure').map((c) => c.check)).toEqual(['identity', 'artifacts']);

    /* Another take, so another key: nothing is stored for it yet. */
    const other = fixture();
    other.assets = other.assets.map((a) => (a.id === 'take' ? { ...a, url: '/campaign/hero.webp' } : a));
    await save(other);
    await expect(quoteDevelopmentJob(request(other), 'owner', harness({}, [blind]).deps)).rejects.toThrow(/cannot see images/);
    await expect(quoteDevelopmentJob(request(other, { attachmentAssetIds: ['frame'] }), 'owner', h.deps)).rejects.toThrow(/take and its masters only/);
    await expect(quoteDevelopmentJob(request(other, { videoFrames: [{ assetId: 'take', uploadId: 'up-1', timeSeconds: 1 }] }), 'owner', h.deps)).rejects.toThrow(/Only a video take/);
    await expect(quoteDevelopmentJob({ ...request(other), kind: 'condense', videoFrames: [{ assetId: 'take', uploadId: 'up-1', timeSeconds: 1 }] }, 'owner', h.deps)).rejects.toThrow(/Only a Verify check takes sampled frames/);
    const video = { ...other, assets: other.assets.map((a) => (a.id === 'take' ? { ...a, kind: 'video' as const, url: '/api/uploads/clip-1', uploadId: 'clip-1' } : a)) };
    await save(video);
    await expect(quoteDevelopmentJob(request(video), 'owner', h.deps)).rejects.toThrow(/three review frames/);
    await expect(quoteDevelopmentJob(request(video, { nodeId: 'wren' }), 'owner', h.deps)).rejects.toThrow(/Choose a Verify card/);
    expect(h.calls).toHaveLength(1);
  });
});

test('a check is quoted at what one usually uses while its job holds the ceiling: the approval binds the estimate shown, and the charge is what it used', async () => {
  /* What one check usually uses: its text, its pictures at the low-detail allowance, its answer, and a quarter of the thinking its effort allows. */
  expect(verifyLikelyTokens({ textBytes: 3000, images: 3, checks: 4, thinkingAllowance: 4096 }))
    .toEqual({ inputTokens: 1000 + 3 * VERIFY_IMAGE_TOKENS, outputTokens: VERIFY_SUMMARY_TOKENS + 4 * VERIFY_CHECK_TOKENS + 1024 });
  expect(verifyLikelyTokens({ textBytes: Number.NaN, images: -1, checks: 0, thinkingAllowance: 0 })).toEqual({ inputTokens: 0, outputTokens: VERIFY_SUMMARY_TOKENS });
  expect(VERIFY_IMAGE_TOKENS * 8).toBe(ATOMIK_IMAGE_TOKENS);
  /* The hold is said beside the estimate only when it is at least twice it. */
  expect([holdWorthSaying(4, 19), holdWorthSaying(5, 9), holdWorthSaying(1, 2), holdWorthSaying(3, 3), holdWorthSaying(1, undefined), holdWorthSaying(0, 0)]).toEqual([true, false, true, false, false, false]);
  await runInTenant(workspace(), async () => {
    const project = fixture(); await save(project);
    const h = harness({ identity: 0.93, wardrobe: 0.9, environment: 0.9, artifacts: 0.95 }, [thinker]);
    const { quote, approved } = await approve(request(project), h.deps);
    expect(quote.estimateCredits).toBeGreaterThan(0);
    expect(quote.holdCredits).toBeGreaterThanOrEqual(2 * quote.estimateCredits);
    /* A start that did not see this price is refused before anything is claimed or reserved. */
    await expect(prepareDevelopmentJob({ ...approved, requestId: randomUUID(), maxCredits: quote.estimateCredits - 1 }, 'owner', undefined, h.deps)).rejects.toThrow('The estimate changed');
    expect(h.reservations()).toBe(0);
    /* The approved estimate starts it; what is reserved and kept for review is the ceiling. */
    const prepared = await prepareDevelopmentJob(approved, 'owner', undefined, h.deps);
    const row = (await db().execute({ sql: 'SELECT estimate_usd,estimate_credits FROM workbench_development_jobs WHERE id=?', args: [prepared.job.id] })).rows[0];
    expect(Number(row.estimate_credits)).toBe(quote.holdCredits);
    expect(h.reserved.map((e) => e.engineCostUsd)).toEqual([Number(row.estimate_usd)]);
    expect(Number(row.estimate_usd)).toBeGreaterThanOrEqual(2 * quote.estimateUsd!);
    for (let i = 0; i < 3; i++) await runDevelopmentStep(prepared.job.id, 'owner', h.deps);
    /* The charge is what the judge used (the scripted reply's tokens), inside the hold. */
    const [job] = await listDevelopmentJobs('owner', project.id, undefined, h.deps);
    expect(job.status).toBe('succeeded');
    expect(job.credits).toBe(billCredits(textCostUsd(thinker, 5000, 300)!, 'text'));
    expect(job.credits!).toBeLessThanOrEqual(quote.holdCredits!);
    /* A check whose provider outcome is unknown is never sent again, and what was held for it (not the lower estimate) stays reserved for review. */
    const changed = { ...project, nodes: project.nodes.map((n) => (n.id === 'wren' ? { ...n, assetId: 'face2' } : n)) };
    await save(changed);
    const u = harness({}, [thinker]);
    u.deps.call = async (call) => { u.calls.push(call); throw Object.assign(new Error('The connection closed.'), { providerSubmitted: true }); };
    const unknown = await prepareDevelopmentJob((await approve(request(changed), u.deps)).approved, 'owner', undefined, u.deps);
    await runDevelopmentStep(unknown.job.id, 'owner', u.deps);
    await runDevelopmentStep(unknown.job.id, 'owner', u.deps);
    const [lost] = await listDevelopmentJobs('owner', project.id, unknown.job.requestId, u.deps);
    expect(lost.status).toBe('uncertain');
    expect(lost.error).toContain('What was held for it remains reserved for review.');
    expect(u.calls).toHaveLength(1);
    expect(u.events.map((e) => [e.status, e.engineCostUsd, e.unbilled])).toEqual([['failed', u.reserved[0].engineCostUsd, undefined]]);
    /* Every other agent step is still quoted at its ceiling, with nothing more held. */
    await save({ ...project, brief: 'A courier crosses the dunes at dawn.' });
    const idea = await quoteDevelopmentJob({ ...request(project), kind: 'idea', nodeId: undefined }, 'owner', h.deps);
    expect(idea.estimateCredits).toBeGreaterThan(0);
    expect(idea.holdCredits).toBeUndefined();
  });
});

test('two starts of one key on two server instances at once: one claims it before anything is reserved, the other is refused free, and it is sent and charged once', async () => {
  const here = workspace(), there = elsewhere(here);
  const project = fixture();
  await runInTenant(here, () => save(project));
  const h = harness({ identity: 0.93, wardrobe: 0.9, environment: 0.9, artifacts: 0.95 });
  const { approved } = await runInTenant(here, () => approve(request(project), h.deps));
  const verifyJobs = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM workbench_development_jobs WHERE json_extract(request_body,'$.kind')='verify'")).rows[0].n);

  /* Two people press Verify on the same take and masters, served by two instances: both pass the free check before either claims. */
  const met = { ...h.deps, allowance: meeting(2) };
  const starts = await Promise.allSettled([here, there].map((ws) => runInTenant(ws, () => prepareDevelopmentJob({ ...approved, requestId: randomUUID() }, 'owner', undefined, met))));
  const won = starts.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const lost = starts.flatMap((s) => (s.status === 'rejected' ? [s.reason as DevelopmentError] : []));
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ status: 409, message: CHECK_RUNNING });
  expect(h.reservations()).toBe(1);
  await runInTenant(here, async () => {
    expect(await verifyJobs()).toBe(1);
    for (let i = 0; i < 3; i++) await runDevelopmentStep(won[0].job.id, 'owner', h.deps);
    expect((await db().execute('SELECT COUNT(*) AS n FROM take_verifications')).rows[0].n).toBe(1);
  });
  expect(h.calls).toHaveLength(1);
  expect(h.events.map((e) => [e.id, e.status])).toEqual([[won[0].job.id, 'succeeded']]);

  /* A new master, a new key. One instance passes the free check and waits; the other checks the key to the end; then the first claims: the stored scorecard answers it, free. */
  const changed = { ...project, nodes: project.nodes.map((n) => (n.id === 'wren' ? { ...n, assetId: 'face2' } : n)) };
  await runInTenant(here, () => save(changed));
  const next = await runInTenant(here, () => approve(request(changed), h.deps));
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  const late = runInTenant(here, () => prepareDevelopmentJob({ ...next.approved, requestId: randomUUID() }, 'owner', undefined, { ...h.deps, allowance: async () => { reached(); await held; return { ok: true }; } }));
  late.catch(() => {});
  try {
    await waiting;
    const first = await runInTenant(there, () => prepareDevelopmentJob({ ...next.approved, requestId: randomUUID() }, 'owner', undefined, h.deps));
    await runInTenant(there, async () => { for (let i = 0; i < 3; i++) await runDevelopmentStep(first.job.id, 'owner', h.deps); });
  } finally { release(); }
  await expect(late).rejects.toMatchObject({ status: 409, message: ALREADY_CHECKED });
  expect(h.reservations()).toBe(2);
  expect(h.calls).toHaveLength(2);

  /* The same request sent twice at once (a retry racing its original): one job answers both, reserved once. */
  const third = { ...project, nodes: project.nodes.map((n) => (n.id === 'wren' ? { ...n, assetId: 'plate' } : n)) };
  await runInTenant(here, () => save(third));
  const once = { ...(await runInTenant(here, () => approve(request(third), h.deps))).approved, requestId: randomUUID() };
  const twice = { ...h.deps, allowance: meeting(2) };
  const both = await Promise.all([here, there].map((ws) => runInTenant(ws, () => prepareDevelopmentJob(once, 'owner', undefined, twice))));
  expect(both[0].job.id).toBe(both[1].job.id);
  expect(both.map((b) => b.scheduled).sort()).toEqual([false, true]);
  expect(h.reservations()).toBe(3);
  await runInTenant(here, async () => expect(await verifyJobs()).toBe(3));
});

test('a check sends its review copies at low detail, through the Gateway and straight to OpenAI; other steps send theirs as before', async () => {
  const still = 'data:image/jpeg;base64,' + (await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg({ quality: 80 }).toBuffer()).toString('base64');
  const call = (m: CatalogModel, kind: DevelopmentCall['kind'] = 'verify'): DevelopmentCall => ({ model: m, effort: 'auto', stage: 'refine', kind, instructions: 'Return JSON.', prompt: '{}', maxTokens: 4000, chunk: verifyChunk(['identity', 'artifacts']), images: [still, still] });
  /* Through the Gateway (Claude): every picture carries the low-detail option. */
  const sent: Record<string, unknown>[] = [];
  const gateway: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ content: [{ type: 'text', text: '{}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] });
  };
  const pictures = (body: Record<string, unknown>) => ((body.prompt as { content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { type: string; providerOptions?: unknown }[]).filter((part) => part.type === 'file');
  await executeDevelopmentAgent(call(model), { method: 'api-key', token: 'test-token-not-real' }, gateway);
  expect(pictures(sent[0]).map((part) => part.providerOptions)).toEqual([{ openai: { imageDetail: 'low' } }, { openai: { imageDetail: 'low' } }]);
  await executeDevelopmentAgent(call(model, 'sketch'), { method: 'api-key', token: 'test-token-not-real' }, gateway);
  expect(pictures(sent[1]).map((part) => part.providerOptions)).toEqual([undefined, undefined]);
  /* Straight to OpenAI on the platform's own OpenAI key (a key a workspace saved never funds new work): every picture is
     an input image at low detail. */
  const fakeKey = 'test-openai-key-never-sent';
  const gpt: CatalogModel = { ...model, id: 'openai/gpt-6-astra', name: 'GPT fixture', owner: 'openai' };
  const direct: Record<string, unknown>[] = [];
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = fakeKey;
  try {
    await runInTenant(workspace(), () => executeDevelopmentAgent(call(gpt), { method: 'api-key', token: fakeKey, vendor: 'openai' }, async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      direct.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'completed', output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{}', annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, error: null, incomplete_details: null });
    }));
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
  }
  const images = ((direct[0].input as { content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { type: string; detail?: string }[]).filter((part) => part.type === 'input_image');
  expect(images.map((part) => part.detail)).toEqual(['low', 'low']);
});

test('a recovered verify request is accepted as saved, and frames on any other kind are not', () => {
  const body = { projectId: 'p1', requestId: 'req-verify-1', kind: 'verify', model: model.id, effort: 'auto', nodeId: 'check', sourceHash: 'a'.repeat(64), maxCredits: 3,
    videoFrames: [{ assetId: 'clip', uploadId: 'up_1', timeSeconds: 0.5 }] };
  expect(developmentInput({ version: 1, scope: 's', projectId: 'p1', body: JSON.stringify(body) }).kind).toBe('verify');
  expect(() => developmentInput({ version: 1, scope: 's', projectId: 'p1', body: JSON.stringify({ ...body, kind: 'rig' }) })).toThrow();
  expect(() => developmentInput({ version: 1, scope: 's', projectId: 'p1', body: JSON.stringify({ ...body, videoFrames: [1, 2, 3, 4] }) })).toThrow();
  expect(() => developmentInput({ version: 1, scope: 's', projectId: 'p1', body: JSON.stringify({ ...body, attachmentAssetIds: ['a'] }) })).toThrow();
});
