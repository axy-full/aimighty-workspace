import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { TenantWorkspace } from '../../lib/tenant';
import type { MeterEvent } from '../../lib/meter';
import type { AstraSandboxHandle, AstraSandboxSdk } from '../../lib/astra-blender/sandbox';
import { workerPool, WORKER_SECRET, WORKER_URLS } from './astraWorkerFake';

/* The durable render job on the self-hosted backend: the same claim, settle and
   reconcile as on Vercel, against an in-memory worker pool behind a stubbed
   fetch. No network, no render, no paid call. */
const directory = mkdtempSync(path.join(tmpdir(), 'astra-selfhost-jobs-'));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, 'platform.db')}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, 'primary.db')}`;
process.env.KEYRING_SECRET ??= 'unit-test-keyring-secret-unit-test-keyring';
process.env.ENGINE_MOCK = '1';
process.env.ASTRA_BLENDER_RATE_CARD = JSON.stringify({ cpuUsdPerHour: 0.128, memoryUsdPerGbHour: 0.0212, egressUsdPerGb: 0.15, createUsd: 0.0000006 });
const [W1, W2, W3] = WORKER_URLS;
const SELFHOST = { ASTRA_RENDER_BACKEND: 'selfhost', ASTRA_WORKER_URLS: WORKER_URLS.join(','), ASTRA_WORKER_SECRET: WORKER_SECRET };
const VERCEL = { ASTRA_RENDER_BACKEND: 'vercel', ASTRA_BLENDER_SNAPSHOT_ID: 'snap_verified-test', VERCEL_TOKEN: 'unit-test-token', VERCEL_TEAM_ID: 'team_unit_test', VERCEL_PROJECT_ID: 'prj_unit_test' };
const KEYS = ['VERCEL', 'ASTRA_WORKER_SECRETS', ...new Set([...Object.keys(SELFHOST), ...Object.keys(VERCEL)])];
let saved: Record<string, string | undefined> = {};
function use(values: Record<string, string>) { for (const key of KEYS) delete process.env[key]; Object.assign(process.env, values); }
test.beforeAll(() => { saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]])); });
test.beforeEach(async () => { use(SELFHOST); (await import('../../lib/astra-blender/selfhost-sdk')).forgetAstraWorkerSessions(); });
test.afterAll(() => { for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: true, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: 'u_test', createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
async function context(name: string, run: (modules: Awaited<ReturnType<typeof setup>>) => Promise<void>) { const { runInTenant } = await import('../../lib/tenant'); await runInTenant(workspace(name), async () => run(await setup())); }
async function setup() {
    const jobs = await import('../../lib/astra-blender/render-jobs'); const { db } = await import('../../lib/db'); const { newProject } = await import('../../lib/workbench/studio'); const { createAstraScene } = await import('../../lib/astra-blender/scene'); const { astraSceneDigest } = await import('../../lib/astra-blender/proposal');
    await jobs.astraRenderReady();
    const project = { ...newProject('Native test'), id: 'project-test', assets: [], productionProjectId: 'production-test', astraBlender: createAstraScene('product') };
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('production-test','Native test',?)", args: [Date.now()] });
    await db().execute({ sql: 'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: ['draft-test', 'u_test', project.id, project.name, JSON.stringify(project), Date.now()] });
    const input = { projectId: project.id, requestId: 'request-native-1', source: 'scene' as const, sourceDigest: await astraSceneDigest(project.astraBlender) };
    const { quote } = await jobs.quoteAstraRender(input, 'u_test');
    const row = async (id: string) => (await db().execute({ sql: 'SELECT * FROM astra_render_jobs WHERE id=?', args: [id] })).rows[0] as Record<string, unknown>;
    return { ...jobs, db, project, row, input: { ...input, quoteDigest: quote.quoteDigest, maxCredits: quote.estimateCredits }, quote };
}
/* The job's collaborators, recorded: the reservation, the funding check and every meter write. */
function collaborators(sdk: AstraSandboxSdk) {
    const reserved: MeterEvent[] = [], metered: MeterEvent[] = [], funding: string[] = [];
    const deps: import('../../lib/astra-blender/render-jobs').AstraRenderDependencies = {
        sandbox: { sdk }, reserve: async (event) => { reserved.push(event); }, assertFunding: async (_id, engine) => { funding.push(engine); }, meter: async (event) => { metered.push(event); },
        loadInputs: async () => ({ bindings: {}, inputs: [] }),
        storeArtifacts: async (jobId, data, onStored) => { const { astraArtifactPlan } = await import('../../lib/astra-blender/render-storage'); for (const artifact of astraArtifactPlan(jobId)) if (data[artifact.kind]) await onStored({ ...artifact, bytes: data[artifact.kind]!.length, sha256: 'a'.repeat(64), storedUrl: artifact.url }); },
    };
    return { deps, reserved, metered, funding };
}
async function selfhost(pool: ReturnType<typeof workerPool>) { const { createSelfhostSdk } = await import('../../lib/astra-blender/selfhost-sdk'); return collaborators(createSelfhostSdk({ config: { urls: WORKER_URLS, secrets: WORKER_URLS.map(() => WORKER_SECRET) }, fetch: pool.fetch })); }

test('a self-hosted render runs on the first free worker, meters selfhost-blender, and charges what the same usage charges on Vercel', async () => {
    let selfhostCost = 0, selfhostCredits = 0, selfhostEstimate = 0;
    await context('selfhost-run', async (m) => {
        const pool = workerPool(); pool.set(W1, 'busy');
        const f = await selfhost(pool);
        const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
        expect(f.reserved.map(event => [event.engine, event.model, event.status])).toEqual([['selfhost-blender', 'blender-5.2.2-cpu', 'running']]);
        expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
        expect(f.funding).toEqual(['selfhost-blender']);
        const job = (await m.listAstraRenderJobs('u_test', m.project.id))[0];
        expect(job.status).toBe('succeeded');
        expect(f.metered.map(event => [event.engine, event.model, event.status])).toEqual([['selfhost-blender', 'blender-5.2.2-cpu', 'succeeded']]);
        // Worker 2 ran the fixed launcher, exactly as the protocol names it, then was stopped (its reply carries the final usage).
        const sessionCalls = pool.calls.filter(call => call.origin === W2).map(call => `${call.method} ${call.path.replace(/astra-blender-[a-f0-9-]{36}/, ':name')}`);
        expect(sessionCalls[0]).toBe('POST /v1/sessions');
        expect(sessionCalls).toContain('POST /v1/sessions/:name/run');
        expect(sessionCalls.at(-1)).toBe('DELETE /v1/sessions/:name');
        expect(JSON.parse(pool.calls.find(call => call.path.endsWith('/run'))!.body!.toString())).toEqual({ cmd: '/usr/bin/python3', args: ['run.py'], cwd: '/vercel/sandbox/astra', timeoutMs: 165000 });
        expect(pool.calls.filter(call => call.method === 'PUT').map(call => call.query)).toEqual(['/vercel/sandbox/astra/scene.py', '/vercel/sandbox/astra/run.py']);
        expect(pool.running()).toEqual([]);
        expect(pool.sessions.get(W2)?.status).toBe('stopped');
        const row = await m.row(job.id);
        expect(JSON.parse(String(row.usage_json))).toEqual({ activeCpuMs: 12000, durationMs: 15000, egressBytes: 0 });
        expect(JSON.parse(String(row.source_json))).toMatchObject({ engine: 'selfhost-blender' });
        expect(JSON.parse(String(row.source_json))).not.toHaveProperty('snapshotId');
        selfhostCost = Number(row.cost_usd); selfhostCredits = Number(row.billed_credits); selfhostEstimate = Number(row.estimate_credits);
        const { astraComputeCost, astraComputeRates } = await import('../../lib/astra-blender/render-pricing');
        expect(selfhostCost).toBe(astraComputeCost({ activeCpuMs: 12000, durationMs: 15000, egressBytes: 0 }, astraComputeRates()!));
        expect(f.metered[0].engineCostUsd).toBe(selfhostCost);
        const { paidByPlatformEngine } = await import('../../lib/platformSpend');
        expect([paidByPlatformEngine('selfhost-blender'), paidByPlatformEngine('vercel-sandbox')]).toEqual([true, true]);
    });
    // The same reported numbers on a Vercel Sandbox bill the same dollars and credits; only the engine label differs.
    use(VERCEL);
    await context('vercel-same-usage', async (m) => {
        const handle: AstraSandboxHandle = { name: '', status: 'running', totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 0,
            writeFiles: async () => {}, runCommand: async () => ({ exitCode: 0 }), stop: async () => { handle.status = 'stopped'; },
            readFile: async ({ path }) => path.endsWith('.blend') ? Readable.from([Buffer.from('BLENDER-v502test')]) : path.endsWith('.png') ? Readable.from([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDpkAAAAASUVORK5CYII=', 'base64')]) : null };
        const f = collaborators({ create: async (options) => { handle.name = options.name!; return handle; }, get: async () => handle });
        const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
        await m.runAstraRender(first.job.id, f.deps);
        const row = await m.row(first.job.id);
        expect(row.status).toBe('succeeded');
        expect(f.metered.map(event => event.engine)).toEqual(['vercel-sandbox']);
        expect(f.funding).toEqual(['vercel-sandbox']);
        expect([Number(row.cost_usd), Number(row.billed_credits), Number(row.estimate_credits)]).toEqual([selfhostCost, selfhostCredits, selfhostEstimate]);
    });
    expect(selfhostCredits).toBeGreaterThan(0);
});

test('every worker busy: the job goes back to the queue, is neither charged nor refunded, and runs once a worker is free', async () => context('selfhost-busy', async (m) => {
    const pool = workerPool(); for (const origin of WORKER_URLS) pool.set(origin, 'busy');
    const f = await selfhost(pool);
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    expect(await m.runAstraRender(first.job.id, f.deps)).toBe('busy');
    let row = await m.row(first.job.id);
    expect(row).toMatchObject({ status: 'queued', funded: 1, settled: 0, runtime_id: null, claimed_at: null, cost_usd: null, billed_credits: null, error: m.ASTRA_WORKERS_BUSY });
    expect(f.metered).toEqual([]); // no final charge, and no zero-cost settlement (which would refund)
    expect(f.reserved).toHaveLength(1);
    expect(Number((await m.db().execute({ sql: 'SELECT COUNT(*) AS n FROM astra_render_storage WHERE job_id=?', args: [first.job.id] })).rows[0].n)).toBe(1);
    expect(pool.calls.map(call => `${call.method} ${call.origin}`)).toEqual(WORKER_URLS.map(origin => `POST ${origin}`));
    // Recovery leaves a queued job alone; the job is still in the pending list, and in its backoff.
    await m.reconcileAstraRender(first.job.id, f.deps);
    const pending = (await m.pendingAstraRenders(4)).find(job => job.id === first.job.id)!;
    expect(pending.status).toBe('queued');
    expect(m.astraRenderInBusyBackoff(pending)).toBe(true);
    expect(m.astraRenderInBusyBackoff(pending, Number(pending.updated_at) + m.ASTRA_BUSY_BACKOFF_MS)).toBe(false);
    // Asked again inside the backoff: still busy, and no worker is asked.
    pool.calls.length = 0;
    expect(await m.runAstraRender(first.job.id, f.deps)).toBe('busy');
    expect(pool.calls).toEqual([]);
    // After the backoff, with worker 3 free, it runs once and is charged once.
    await m.db().execute({ sql: 'UPDATE astra_render_jobs SET updated_at=? WHERE id=?', args: [Date.now() - m.ASTRA_BUSY_BACKOFF_MS - 1, first.job.id] });
    pool.set(W3, 'free');
    expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
    row = await m.row(first.job.id);
    expect(row).toMatchObject({ status: 'succeeded', settled: 1, error: null });
    expect(f.metered.map(event => [event.engine, event.status])).toEqual([['selfhost-blender', 'succeeded']]);
    expect(pool.calls.filter(call => call.method === 'POST' && call.path === '/v1/sessions').map(call => call.origin)).toEqual(WORKER_URLS);
}));

test('the worker handler reports busy so the Inngest function waits and runs it again', async () => context('selfhost-busy-handler', async () => {
    const { handleAstraRender } = await import('../../lib/worker-handlers');
    const { requireTenant } = await import('../../lib/tenant');
    const ws = requireTenant();
    const seen: string[] = [];
    const busy = await handleAstraRender({ jobId: 'astra_render_busy', workspaceId: ws.id }, { workspaceOf: async () => ws, run: async (id) => { seen.push(`run ${id}`); return 'busy'; }, reconcile: async (id) => { seen.push(`reconcile ${id}`); } });
    expect(busy).toEqual({ jobId: 'astra_render_busy', busy: true });
    expect(await handleAstraRender({ jobId: 'astra_render_done', workspaceId: ws.id }, { workspaceOf: async () => ws, run: async () => undefined, reconcile: async () => {} })).toEqual({ jobId: 'astra_render_done' });
    expect(seen).toEqual(['run astra_render_busy', 'reconcile astra_render_busy']);
    const { astraRenderWithWorkerWaits, ASTRA_BUSY_WAIT } = await import('../../lib/workers');
    const steps: string[] = [];
    let attempts = 0;
    const result = await astraRenderWithWorkerWaits({ jobId: 'astra_render_busy', workspaceId: ws.id },
        { run: async (id, work) => { steps.push(`run ${id}`); return work(); }, sleep: async (id, duration) => { steps.push(`sleep ${id} ${duration}`); } },
        async (data) => (++attempts < 3 ? { jobId: data.jobId, busy: true as const } : { jobId: data.jobId }));
    expect(result).toEqual({ jobId: 'astra_render_busy' });
    expect(steps).toEqual(['run render-persist-and-account', `sleep wait-for-a-render-worker-1 ${ASTRA_BUSY_WAIT}`, 'run render-persist-and-account-1', `sleep wait-for-a-render-worker-2 ${ASTRA_BUSY_WAIT}`, 'run render-persist-and-account-2']);
}));

test('a queued job past 30 minutes from approval is cancelled and refunded before any claim, and one that crosses it while every worker is busy is too', async () => context('selfhost-busy-expiry', async (m) => {
    const pool = workerPool();
    const f = await selfhost(pool);
    // Before the claim: no worker is asked, nothing is claimed, the reservation is released.
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    await m.db().execute({ sql: 'UPDATE astra_render_jobs SET created_at=?,error=?,updated_at=? WHERE id=?', args: [Date.now() - m.ASTRA_START_EXPIRY_MS - 1, m.ASTRA_WORKERS_BUSY, Date.now(), first.job.id] });
    expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
    const row = await m.row(first.job.id);
    expect(row).toMatchObject({ status: 'cancelled', settled: 1, runtime_id: null, claimed_at: null, billed_credits: 0 });
    expect(String(row.error)).toContain('did not start within 30 minutes');
    expect(pool.calls).toEqual([]);
    expect(f.metered.map(event => [event.engine, event.status, event.engineCostUsd])).toEqual([['selfhost-blender', 'failed', 0]]);
    expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
    expect(f.metered).toHaveLength(1);
    // Crossing the expiry during a busy attempt: the released claim is cancelled and refunded, not requeued.
    for (const origin of WORKER_URLS) pool.set(origin, 'busy');
    const second = await m.prepareAstraRender({ ...m.input, requestId: 'request-native-2' }, 'u_test', undefined, f.deps);
    const { createSelfhostSdk } = await import('../../lib/astra-blender/selfhost-sdk');
    let aged = false;
    f.deps.sandbox = { sdk: createSelfhostSdk({ config: { urls: WORKER_URLS, secrets: WORKER_URLS.map(() => WORKER_SECRET) }, fetch: async (input, init) => { if (!aged) { aged = true; await m.db().execute({ sql: 'UPDATE astra_render_jobs SET created_at=? WHERE id=?', args: [Date.now() - m.ASTRA_START_EXPIRY_MS - 1, second.job.id] }); } return pool.fetch(input, init); } }) };
    expect(await m.runAstraRender(second.job.id, f.deps)).toBeUndefined();
    expect(await m.row(second.job.id)).toMatchObject({ status: 'cancelled', settled: 1, runtime_id: null, billed_credits: 0 });
    expect(f.metered.at(-1)).toMatchObject({ status: 'failed', engineCostUsd: 0 });
}));

test('workers that refuse the render outright fail it before anything starts and release the reservation', async () => context('selfhost-refused', async (m) => {
    const pool = workerPool();
    const { createSelfhostSdk } = await import('../../lib/astra-blender/selfhost-sdk');
    const f = collaborators(createSelfhostSdk({ config: { urls: WORKER_URLS, secrets: WORKER_URLS.map(() => 'a-different-secret-that-is-long-enough-0') }, fetch: pool.fetch }));
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
    const row = await m.row(first.job.id);
    expect(row).toMatchObject({ status: 'failed', settled: 1, runtime_id: null, billed_credits: 0 });
    expect(String(row.error)).toContain('Nothing was billed');
    expect(f.metered.map(event => [event.status, event.engineCostUsd])).toEqual([['failed', 0]]);
    expect(pool.sessions.size).toBe(0);
}));

test('a cancel that lands while every worker is busy ends the job cancelled and refunded', async () => context('selfhost-busy-cancel', async (m) => {
    const pool = workerPool(); for (const origin of WORKER_URLS) pool.set(origin, 'busy');
    const f = await selfhost(pool);
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    // The cancel arrives after the claim and before the workers answer.
    const fetch = pool.fetch;
    let cancelled = false;
    const { createSelfhostSdk } = await import('../../lib/astra-blender/selfhost-sdk');
    f.deps.sandbox = { sdk: createSelfhostSdk({ config: { urls: WORKER_URLS, secrets: WORKER_URLS.map(() => WORKER_SECRET) }, fetch: async (input, init) => { if (!cancelled) { cancelled = true; await m.db().execute({ sql: 'UPDATE astra_render_jobs SET cancel_requested=1 WHERE id=?', args: [first.job.id] }); } return fetch(input, init); } }) };
    expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
    expect(await m.row(first.job.id)).toMatchObject({ status: 'cancelled', settled: 1, runtime_id: null, billed_credits: 0 });
    expect(f.metered.map(event => [event.status, event.engineCostUsd])).toEqual([['failed', 0]]);
}));

test('reconcile reads a self-hosted session by name, stops it 240 s after its claim, settles from the kept usage, and never creates', async () => context('selfhost-reconcile', async (m) => {
    const pool = workerPool();
    const f = await selfhost(pool);
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    const name = 'astra-blender-00000000-0000-4000-8000-0000000000aa';
    // A run whose host went away mid-render: claimed and running on worker 2. Created long ago, claimed just now.
    pool.hold(W2, name);
    await m.db().execute({ sql: "UPDATE astra_render_jobs SET status='running',runtime_id=?,claimed_at=?,created_at=? WHERE id=?", args: [name, Date.now() - 10_000, Date.now() - 3_600_000, first.job.id] });
    await m.reconcileAstraRender(first.job.id, f.deps);
    expect(pool.sessions.get(W2)?.name).toBe(name); // inside the run ceiling from its claim: left running
    expect((await m.row(first.job.id)).status).toBe('running');
    // Past 240 s from its claim: stopped on the worker that holds it, and its final usage kept.
    await m.db().execute({ sql: 'UPDATE astra_render_jobs SET claimed_at=? WHERE id=?', args: [Date.now() - 241_000, first.job.id] });
    pool.calls.length = 0;
    await m.reconcileAstraRender(first.job.id, f.deps);
    expect(pool.running()).toEqual([]);
    expect(pool.calls.filter(call => call.method === 'DELETE').map(call => call.origin)).toEqual([W2]);
    expect(JSON.parse(String((await m.row(first.job.id)).usage_json))).toEqual({ activeCpuMs: 12000, durationMs: 15000, egressBytes: 0 });
    // The next pass settles from the kept usage: a failed render that ran is charged what it used.
    await m.reconcileAstraRender(first.job.id, f.deps);
    const row = await m.row(first.job.id);
    expect(row).toMatchObject({ status: 'failed', settled: 1 });
    expect(f.metered.map(event => [event.engine, event.status])).toEqual([['selfhost-blender', 'failed']]);
    expect(Number(row.cost_usd)).toBeGreaterThan(0);
    expect(pool.calls.some(call => call.method === 'POST')).toBe(false);
}));

test('a self-hosted session no worker holds is left alone inside the run ceiling and held as uncertain after it', async () => context('selfhost-missing', async (m) => {
    const pool = workerPool();
    const f = await selfhost(pool);
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    const name = 'astra-blender-00000000-0000-4000-8000-0000000000bb';
    await m.db().execute({ sql: "UPDATE astra_render_jobs SET status='running',runtime_id=?,claimed_at=? WHERE id=?", args: [name, Date.now() - 5_000, first.job.id] });
    const { AstraWorkerSessionMissingError } = await import('../../lib/astra-blender/selfhost-sdk');
    await expect(m.reconcileAstraRender(first.job.id, f.deps)).rejects.toBeInstanceOf(AstraWorkerSessionMissingError);
    expect((await m.row(first.job.id)).status).toBe('running');
    await m.db().execute({ sql: 'UPDATE astra_render_jobs SET claimed_at=? WHERE id=?', args: [Date.now() - 241_000, first.job.id] });
    await m.reconcileAstraRender(first.job.id, f.deps);
    const row = await m.row(first.job.id);
    expect(row).toMatchObject({ status: 'uncertain', settled: 0, cost_usd: null, billed_credits: null });
    expect(f.metered).toEqual([]); // the reservation stays held: neither charged nor refunded
    // An unreachable worker is not "missing": nothing is concluded.
    pool.set(W1, 'down');
    await expect(m.reconcileAstraRender(first.job.id, f.deps)).rejects.toThrow('could not be reached');
    expect(pool.calls.some(call => call.method === 'POST')).toBe(false);
}));

test('a job runs only on the backend it was approved under, and rows from before the switch stay Vercel rows', async () => context('selfhost-switch', async (m) => {
    const pool = workerPool();
    const f = await selfhost(pool);
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    use(VERCEL);
    expect(await m.runAstraRender(first.job.id, f.deps)).toBeUndefined();
    expect(await m.row(first.job.id)).toMatchObject({ status: 'failed', settled: 1, runtime_id: null, billed_credits: 0 });
    expect(String((await m.row(first.job.id)).error)).toContain('changed after this render was approved');
    expect(f.metered.map(event => [event.engine, event.status, event.engineCostUsd])).toEqual([['selfhost-blender', 'failed', 0]]);
    expect(pool.calls).toEqual([]);
    // A row written before the switch has no engine: it reads, funds and settles as vercel-sandbox.
    use(SELFHOST);
    const second = await m.prepareAstraRender({ ...m.input, requestId: 'request-native-2' }, 'u_test', undefined, f.deps);
    const source = JSON.parse(String((await m.row(second.job.id)).source_json));
    delete source.engine;
    await m.db().execute({ sql: 'UPDATE astra_render_jobs SET source_json=? WHERE id=?', args: [JSON.stringify(source), second.job.id] });
    expect((await m.cancelAstraRenderJob('u_test', m.project.id, second.job.id, f.deps)).status).toBe('cancelled');
    expect(f.metered.at(-1)).toMatchObject({ engine: 'vercel-sandbox', status: 'failed', engineCostUsd: 0 });
}));

test('a job settled by another host never flips back to uncertain from a stale read (cancel or reconcile)', async () => context('selfhost-settled-stale', async (m) => {
    const pool = workerPool();
    const f = await selfhost(pool);
    const name = 'astra-blender-00000000-0000-4000-8000-0000000000cc';
    const settleElsewhere = async (id: string) => { await m.db().execute({ sql: "UPDATE astra_render_jobs SET status='cancelled',settled=1,billed_credits=0,error='refunded elsewhere' WHERE id=?", args: [id] }); };
    // Cancel: the runtime lookup fails after another host has settled (and refunded) the job.
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    await m.db().execute({ sql: "UPDATE astra_render_jobs SET status='running',runtime_id=?,claimed_at=? WHERE id=?", args: [name, Date.now(), first.job.id] });
    f.deps.sandbox = { sdk: { create: async () => { throw new Error('never creates'); }, get: async () => { await settleElsewhere(first.job.id); throw new Error('worker unreachable'); } } };
    await m.cancelAstraRenderJob('u_test', m.project.id, first.job.id, f.deps);
    expect(await m.row(first.job.id)).toMatchObject({ status: 'cancelled', settled: 1, error: 'refunded elsewhere' });
    // Reconcile: a stopped runtime with no usage, read just as another host settled the job.
    const second = await m.prepareAstraRender({ ...m.input, requestId: 'request-native-2' }, 'u_test', undefined, f.deps);
    await m.db().execute({ sql: "UPDATE astra_render_jobs SET status='running',runtime_id=?,claimed_at=? WHERE id=?", args: [name, Date.now(), second.job.id] });
    f.deps.sandbox = { sdk: { create: async () => { throw new Error('never creates'); }, get: async () => { await settleElsewhere(second.job.id); return { name, status: 'stopped', writeFiles: async () => {}, runCommand: async () => ({ exitCode: 0 }), readFile: async () => null, stop: async () => {} }; } } };
    await m.reconcileAstraRender(second.job.id, f.deps);
    expect(await m.row(second.job.id)).toMatchObject({ status: 'cancelled', settled: 1, error: 'refunded elsewhere' });
    expect(f.metered).toEqual([]);
}));

test('a cancel that read the job while it was claimed, then found it back in the queue after a busy release, refunds it', async () => context('selfhost-cancel-after-release', async (m) => {
    const pool = workerPool();
    const f = await selfhost(pool);
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    // The cancel reads the job while a run holds its claim...
    await m.db().execute({ sql: "UPDATE astra_render_jobs SET status='starting',runtime_id=?,claimed_at=? WHERE id=?", args: ['astra-blender-00000000-0000-4000-8000-0000000000dd', Date.now(), first.job.id] });
    // ...and every worker answers busy before the cancel's own update: the claim goes back to the queue.
    const client = m.db();
    const execute = client.execute.bind(client);
    let released = false;
    client.execute = (async (statement: Parameters<typeof execute>[0]) => {
        const sql = typeof statement === 'string' ? statement : String((statement as { sql: string }).sql);
        if (!released && sql.includes('SET cancel_requested=1')) {
            released = true;
            await execute({ sql: "UPDATE astra_render_jobs SET status='queued',runtime_id=NULL,claimed_at=NULL,error=? WHERE id=?", args: [m.ASTRA_WORKERS_BUSY, first.job.id] });
        }
        return execute(statement);
    }) as typeof client.execute;
    try {
        expect((await m.cancelAstraRenderJob('u_test', m.project.id, first.job.id, f.deps)).status).toBe('cancelled');
    } finally { client.execute = execute; }
    expect(released).toBe(true);
    expect(await m.row(first.job.id)).toMatchObject({ status: 'cancelled', settled: 1, runtime_id: null, billed_credits: 0 });
    expect(f.metered.map(event => [event.status, event.engineCostUsd])).toEqual([['failed', 0]]);
    expect(pool.calls).toEqual([]);
}));

test('a self-hosted session is stopped before the outputs are stored, so a slow storage write does not stretch its billed duration', async () => context('selfhost-stop-before-store', async (m) => {
    const pool = workerPool();
    pool.liveDuration = true;
    const f = await selfhost(pool);
    const store = f.deps.storeArtifacts!;
    let stoppedWhenStoring: string | undefined;
    let duringStore: Record<string, unknown> | undefined;
    f.deps.storeArtifacts = async (...args) => {
        stoppedWhenStoring = pool.sessions.get(W1)?.status;
        // The panel's poll reconciles while the outputs are being written: it must leave the job to the writer.
        await m.reconcileAstraRender(args[0], f.deps);
        duringStore = await m.row(args[0]);
        await new Promise(resolve => setTimeout(resolve, 1500)); // a slow storage write
        return store(...args);
    };
    const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps);
    const started = Date.now();
    await m.runAstraRender(first.job.id, f.deps);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(stoppedWhenStoring).toBe('stopped');
    expect(duringStore).toMatchObject({ status: 'saving', settled: 0 });
    const row = await m.row(first.job.id);
    expect(row.status).toBe('succeeded');
    const usage = JSON.parse(String(row.usage_json));
    expect(usage.durationMs).toBeLessThan(1500);
    expect(f.metered).toHaveLength(1);
    const { astraComputeCost, astraComputeRates } = await import('../../lib/astra-blender/render-pricing');
    expect(f.metered[0].engineCostUsd).toBe(astraComputeCost(usage, astraComputeRates()!));
    // One stop on the worker: the later stop in cleanup is not repeated once the first was confirmed.
    expect(pool.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
}));
