import { PROJECT_LIMITS, limitText } from "../workbench/project-limits";
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { z } from 'zod';
import { db } from '../db';
import { currentTenant, requireTenant, type TenantToken } from '../tenant';
import { creditsApply } from '../credits';
import { getAtomikProject } from '../workbench/atomik-server';
import { workbenchTransaction } from '../workbench/records';
import { workspaceLimits, quotaVerdict } from '../limits';
import { uploadReservationsReady } from '../uploadReservations';
import { reserveGenerationSpend } from '../generationRequests';
import { meter, assertMeterFunding, type MeterEvent } from '../meter';
import { platformDb } from '../platform';
import { billCredits } from '../creditTerms';
import { billingTransaction } from '../billingLedger';
import { resolveRecoveryJobTx } from '../recovery';
import { engineMock } from '../mock';
import { createAstraScene, type AstraScene } from './scene';
import { astraSceneDigest, validateAstraBindings } from './proposal';
import { astraNativeDigest, validateAstraNativeBindings, type AstraNativeSource } from './native';
import { astraRuntimeStatus, ASTRA_MAX_OUTPUT_BYTES, renderAstraScene, renderAstraNative, getAstraRenderStatus, cancelAstraRender, prepareAstraInputs, type AstraSandboxDependencies, type AstraRuntimeUsage } from './sandbox';
import { astraComputeRates, astraComputeCost, astraComputeCredits, ASTRA_MAX_USAGE, ASTRA_COMPUTE_MODEL, type AstraComputeRates } from './render-pricing';
import { loadAstraRenderInputs, storeAstraArtifacts, registerAstraArtifacts, type StoredAstraArtifact } from './render-storage';
import { ASTRA_COMPUTE_ENGINES, astraBackendOfEngine, astraRenderBackend, isAstraComputeEngine, type AstraComputeEngine } from './backend';
import { AstraWorkerBusyError, AstraWorkerRefusedError, AstraWorkerSessionMissingError } from './selfhost-sdk';
import type { AstraRenderJob, AstraRenderRequest, AstraRenderQuote, AstraRenderStatus } from './render-contract';
import type { Asset } from '../workbench/studio';
const initialized = new WeakMap<Client, Promise<void>>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const astraRenderRequestSchema = z.object({ projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/), source: z.enum(['scene', 'native']), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), quoteOnly: z.boolean().optional(), quoteDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), maxCredits: z.number().int().min(0).max(100000).optional() }).strict();
export class AstraRenderError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
type Snapshot = {
    scene: AstraScene;
    native?: AstraNativeSource;
    assets: Asset[];
    productionProjectId: string;
    rates: AstraComputeRates;
    /** Vercel only. */
    snapshotId?: string;
    /** The meter engine the job was approved under; absent on rows from before the backend switch (Vercel). */
    engine?: AstraComputeEngine;
};
type JobRecord = {
    id: string;
    owner: string;
    request_id: string;
    project_id: string;
    source: string;
    source_digest: string;
    fingerprint: string;
    status: AstraRenderStatus;
    funded: number;
    source_json: string;
    estimate_credits: number;
    max_cost_usd: number;
    cost_usd: number | null;
    billed_credits: number | null;
    runtime_id: string | null;
    cancel_requested: number;
    created_at: number;
    updated_at: number;
    error: string | null;
    artifacts_json: string;
    assets_registered: number;
    outputs_registered: number;
    usage_json: string | null;
    settled: number;
    claimed_at: number | null;
};
export type AstraRenderDependencies = {
    reserve?: typeof reserveGenerationSpend;
    meter?: typeof meter;
    assertFunding?: typeof assertMeterFunding;
    loadInputs?: typeof loadAstraRenderInputs;
    storeArtifacts?: typeof storeAstraArtifacts;
    registerArtifacts?: typeof registerAstraArtifacts;
    sandbox?: AstraSandboxDependencies;
};
export async function astraRenderReady() {
    await uploadReservationsReady();
    const client = db();
    if (!initialized.has(client))
        initialized.set(client, client.batch([`CREATE TABLE IF NOT EXISTS astra_render_jobs (
 id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,project_id TEXT NOT NULL,source TEXT NOT NULL,source_digest TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,funded INTEGER NOT NULL DEFAULT 0,source_json TEXT NOT NULL,estimate_credits INTEGER NOT NULL,max_cost_usd REAL NOT NULL,cost_usd REAL,billed_credits INTEGER,runtime_id TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT,artifacts_json TEXT NOT NULL DEFAULT '[]',assets_registered INTEGER NOT NULL DEFAULT 0,outputs_registered INTEGER NOT NULL DEFAULT 0,usage_json TEXT,settled INTEGER NOT NULL DEFAULT 0,UNIQUE(owner,request_id))`, `CREATE INDEX IF NOT EXISTS astra_render_pending ON astra_render_jobs(status,updated_at)`], 'write').then(async () => { const columns=await client.execute('PRAGMA table_info(astra_render_jobs)');const added=(name:string,ddl:string)=>columns.rows.some(column=>column.name===name)?null:client.execute(`ALTER TABLE astra_render_jobs ADD COLUMN ${ddl}`).catch(error=>{if(!/duplicate column/i.test(String(error)))throw error;});await added('outputs_registered','outputs_registered INTEGER NOT NULL DEFAULT 0');await added('claimed_at','claimed_at INTEGER'); }).catch(error => { initialized.delete(client); throw error; }));
    await initialized.get(client);
}
/* The compute vendor's dollars reach only a workspace that is not billed in credits: one that is reads
   what it was charged, `billedCredits`, and never the cost beside it. */
const computeDollars = (usd: number | null) => (creditsApply(currentTenant()?.workspace) ? {} : { costUsd: usd });
const publicJob = (row: JobRecord): AstraRenderJob => ({ id: row.id, requestId: row.request_id, projectId: row.project_id, source: row.source as 'scene' | 'native', sourceDigest: row.source_digest, status: row.status, estimateCredits: Number(row.estimate_credits), billedCredits: row.billed_credits == null ? null : Number(row.billed_credits), ...computeDollars(row.cost_usd == null ? null : Number(row.cost_usd)), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), error: row.error, artifacts: JSON.parse(row.artifacts_json).map((artifact: StoredAstraArtifact) => ({kind:artifact.kind,assetId:artifact.assetId,uploadId:artifact.uploadId,url:artifact.url,filename:artifact.filename,mime:artifact.mime,bytes:artifact.bytes})), assetsRegistered: Boolean(row.assets_registered) });
async function record(id: string): Promise<JobRecord | null> { await astraRenderReady(); return ((await db().execute({ sql: 'SELECT * FROM astra_render_jobs WHERE id=?', args: [id] })).rows[0] as unknown as JobRecord) ?? null; }
/** The engine a job was approved, reserved and is settled under; it never changes with the backend switch. */
const engineOf = (row: Pick<JobRecord, 'source_json'>): AstraComputeEngine => { const engine = (JSON.parse(row.source_json) as Snapshot).engine; return isAstraComputeEngine(engine) ? engine : ASTRA_COMPUTE_ENGINES.vercel; };
/** Reads, stops and settles a job on the backend it started on. */
const sandboxFor = (row: Pick<JobRecord, 'source_json'>, deps: AstraRenderDependencies): AstraSandboxDependencies => ({ ...deps.sandbox, backend: astraBackendOfEngine(engineOf(row)) });
const event = (row: JobRecord, status: MeterEvent['status'], cost?: number): MeterEvent => ({ id: row.id, kind: 'image', engine: engineOf(row), model: ASTRA_COMPUTE_MODEL, status, engineCostUsd: cost, projectId: (JSON.parse(row.source_json) as Snapshot).productionProjectId, createdBy: row.owner });
export function astraRenderAvailability() { const runtime = astraRuntimeStatus(); if (runtime.configured && !astraComputeRates())
    return { ...runtime, configured: false, reason: 'Native 3D compute rates must be configured before quoting a render.' }; return runtime; }
async function snapshot(input: AstraRenderRequest, owner: string): Promise<Snapshot> {
    const runtime = astraRenderAvailability();
    if (!runtime.configured)
        throw new AstraRenderError(runtime.reason!, 503);
    requireTenant();
    const project = await getAtomikProject(owner, input.projectId);
    if(project.assets.length>PROJECT_LIMITS.assets-3)throw new AstraRenderError(`Make room for three native render outputs in this project (maximum ${limitText(PROJECT_LIMITS.assets)} assets).`,422);
    if (!project.productionProjectId)
        throw new AstraRenderError('Save the project to link its budget first.', 409);
    const scene = project.astraBlender ?? createAstraScene('product'), native = input.source === 'native' ? project.astraNative : undefined;
    if (input.source === 'native' && !native)
        throw new AstraRenderError('Apply and save a reviewed native source first.', 422);
    const digest = native ? await astraNativeDigest(native) : await astraSceneDigest(scene);
    if (digest !== input.sourceDigest)
        throw new AstraRenderError('The source changed. Save it and review a new quote.', 409);
    const all = [...project.assets, ...(project.sharedAssets ?? [])];
    validateAstraBindings(scene, all);
    if (native)
        validateAstraNativeBindings(native, all);
    const ids = new Set([...scene.objects.flatMap(object => object.assetId ? [object.assetId] : []), ...(native?.assetIds ?? []), ...(native?.baseBlendAssetId ? [native.baseBlendAssetId] : [])]);
    const assets = Array.from(ids, id => all.find(asset => asset.id === id)!);
    if (assets.length > 64)
        throw new AstraRenderError('Use at most 64 combined scene and native inputs.', 422);
    const backend = astraRenderBackend()!;
    return { scene, ...(native ? { native } : {}), assets, productionProjectId: project.productionProjectId, rates: astraComputeRates()!, ...(backend === 'vercel' ? { snapshotId: process.env.ASTRA_BLENDER_SNAPSHOT_ID! } : {}), engine: ASTRA_COMPUTE_ENGINES[backend] };
}
function quoteFor(input: AstraRenderRequest, source: Snapshot): AstraRenderQuote & { maxCostUsd: number } { const bucket = Math.floor(Date.now() / 900000), maxCostUsd = astraComputeCost(ASTRA_MAX_USAGE, source.rates); return { estimateCredits: astraComputeCredits(maxCostUsd, source.engine), maxCostUsd, sourceDigest: input.sourceDigest, quoteDigest: hash({ source, bucket }), expiresAt: (bucket + 1) * 900000, billingNote: 'Reserves the maximum 180-second CPU render and bounded output transfer. Final compute charge uses reported CPU, memory duration and transfer; unknown usage stays reserved for reconciliation.' }; }
export async function quoteAstraRender(input: AstraRenderRequest, owner: string): Promise<{ runtime: ReturnType<typeof astraRenderAvailability>; quote: AstraRenderQuote }> { const { maxCostUsd, ...quote } = quoteFor(input, await snapshot(input, owner)); return { runtime: astraRenderAvailability(), quote: { ...quote, ...(creditsApply(currentTenant()?.workspace) ? {} : { maxCostUsd }) } }; }
export async function listAstraRenderJobs(owner: string, projectId: string, requestId?: string) { await getAtomikProject(owner, projectId); await astraRenderReady(); const rows = (await db().execute({ sql: `SELECT * FROM astra_render_jobs WHERE owner=? AND project_id=?${requestId ? ' AND request_id=?' : ''} ORDER BY created_at DESC LIMIT 25`, args: [owner, projectId, ...(requestId ? [requestId] : [])] })).rows; return rows.map(row => publicJob(row as unknown as JobRecord)); }
export async function prepareAstraRender(input: AstraRenderRequest, owner: string, token?: TenantToken, deps: AstraRenderDependencies = {}) {
    await astraRenderReady();
    const fingerprint = hash({ projectId: input.projectId, requestId: input.requestId, source: input.source, sourceDigest: input.sourceDigest, quoteDigest: input.quoteDigest, maxCredits: input.maxCredits });
    const prior = (await db().execute({ sql: 'SELECT * FROM astra_render_jobs WHERE owner=? AND request_id=?', args: [owner, input.requestId] })).rows[0] as unknown as JobRecord | undefined;
    if (prior) {
        await getAtomikProject(owner, input.projectId);
        if (prior.fingerprint !== fingerprint)
            throw new AstraRenderError('This request identity already belongs to a different render.', 409);
        return { job: publicJob(prior), scheduled: prior.status === 'queued' && Boolean(prior.funded), duplicate: true };
    }
    const source = await snapshot(input, owner), quote = quoteFor(input, source);
    if (!input.quoteDigest || quote.quoteDigest !== input.quoteDigest || input.maxCredits == null || input.maxCredits < quote.estimateCredits)
        throw new AstraRenderError('The reviewed render quote expired or changed. Review a new quote.', 409);
    // Read and validate before reserving paid compute; the worker validates again from the retained originals.
    const prepared = await (deps.loadInputs ?? loadAstraRenderInputs)(source.assets, owner);
    prepareAstraInputs(source.scene, prepared.bindings, prepared.inputs, source.native);
    const limits = await workspaceLimits(), id = `astra_render_${randomUUID().replaceAll('-', '')}`, at = Date.now();
    const inserted = await workbenchTransaction(async (tx) => {
        const duplicate = (await tx.execute({ sql: 'SELECT * FROM astra_render_jobs WHERE owner=? AND request_id=?', args: [owner, input.requestId] })).rows[0] as unknown as JobRecord | undefined;
        if (duplicate) {
            if (duplicate.fingerprint !== fingerprint)
                throw new AstraRenderError('This request identity is already in use.', 409);
            return duplicate;
        }
        const used = (await tx.execute(`SELECT (SELECT COALESCE(SUM(bytes),0) FROM generations WHERE deleted=0)+(SELECT COALESCE(SUM(COALESCE(bytes,0)+COALESCE(derivative_bytes,0)),0) FROM uploads)+(SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_sessions)+(SELECT COALESCE(SUM(bytes),0) FROM consumer_video_originals WHERE state<>'stored')+(SELECT COALESCE(SUM(reserved_bytes),0) FROM astra_render_storage) AS used`)).rows[0];
        const verdict = quotaVerdict({ usedBytes: Number(used.used), incomingBytes: ASTRA_MAX_OUTPUT_BYTES, quotaBytes: limits.storageBytes });
        if (!verdict.allow)
            throw new AstraRenderError(verdict.error!, 507);
        await tx.execute({ sql: 'INSERT INTO astra_render_jobs(id,owner,request_id,project_id,source,source_digest,fingerprint,status,source_json,estimate_credits,max_cost_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'queued\',?,?,?,?,?)', args: [id, owner, input.requestId, input.projectId, input.source, input.sourceDigest, fingerprint, JSON.stringify(source), quote.estimateCredits, quote.maxCostUsd, at, at] });
        await tx.execute({ sql: 'INSERT INTO astra_render_storage(job_id,reserved_bytes) VALUES(?,?)', args: [id, ASTRA_MAX_OUTPUT_BYTES] });
        return null;
    });
    if (inserted)
        return { job: publicJob(inserted), scheduled: inserted.status === 'queued' && Boolean(inserted.funded), duplicate: true };
    const row = (await record(id))!;
    try {
        await (deps.reserve ?? reserveGenerationSpend)(event(row, 'running', quote.maxCostUsd), { token });
        await db().execute({ sql: 'UPDATE astra_render_jobs SET funded=1,updated_at=? WHERE id=?', args: [Date.now(), id] });
        const accepted = (await record(id))!;
        if (accepted.cancel_requested)
            await settle(accepted, 'cancelled', null, deps);
    }
    catch (error) {
        // The reservation may have committed despite a lost reply. Reconcile it by the
        // same meter identity; no VM can start until funded=1 is durable.
        await db().execute({ sql: "UPDATE astra_render_jobs SET status='uncertain',error=?,updated_at=? WHERE id=?", args: ['Compute admission needs reconciliation. No runtime was started.', Date.now(), id] });
        await reconcileAstraRender(id, deps).catch(() => { });
        throw error;
    }
    const final = (await record(id))!;
    return { job: publicJob(final), scheduled: final.status === 'queued', duplicate: false };
}
/* A settled run's reservation is released even when it left files behind: those
   files are kept for good and artifacts_json still names them (owner, 2026-09-24),
   but a render that never reached the project does not hold the storage cap. */
async function releaseStorage(row: JobRecord) {
    await db().execute({ sql: 'DELETE FROM astra_render_storage WHERE job_id=?', args: [row.id] }); }
async function settle(row: JobRecord, status: 'succeeded' | 'failed' | 'cancelled', usage: AstraRuntimeUsage | null, deps: AstraRenderDependencies) {
    const source = JSON.parse(row.source_json) as Snapshot;
    const actual = row.runtime_id ? usage ? astraComputeCost(usage, source.rates) : null : 0;
    if (actual == null) {
        // A row read before another host settled it never reopens that settled (perhaps refunded) job.
        await db().execute({ sql: "UPDATE astra_render_jobs SET status='uncertain',error=?,updated_at=? WHERE id=? AND settled=0", args: ['Runtime usage is not yet available. The approved reservation is held; this run will not restart automatically.', Date.now(), row.id] });
        return;
    }
    // Never silently bill over the reviewed maximum; retain actual telemetry for operator reconciliation.
    if (actual > Number(row.max_cost_usd) + 1e-9) {
        await db().execute({ sql: "UPDATE astra_render_jobs SET status='uncertain',usage_json=?,error=?,updated_at=? WHERE id=? AND settled=0", args: [JSON.stringify(usage), 'Reported runtime usage exceeds the approved reservation. Billing needs review.', Date.now(), row.id] });
        return;
    }
    const credits = Number(row.estimate_credits) > 0 ? billCredits(actual, ASTRA_COMPUTE_MODEL) : 0;
    await db().execute({ sql: 'UPDATE astra_render_jobs SET usage_json=?,cost_usd=?,billed_credits=?,updated_at=? WHERE id=?', args: [JSON.stringify(usage), actual, credits, Date.now(), row.id] });
    await (deps.meter ?? meter)(event(row, status === 'succeeded' ? 'succeeded' : 'failed', actual), { critical: true });
    await db().execute({ sql: 'UPDATE astra_render_jobs SET status=?,settled=1,updated_at=? WHERE id=?', args: [status, Date.now(), row.id] });
    await releaseStorage((await record(row.id))!);
    await billingTransaction(tx => resolveRecoveryJobTx(tx, requireTenant().id, row.id));
}
/** A job left queued because every render worker was busy; it says so, and nothing is billed. */
export const ASTRA_WORKERS_BUSY = 'Every render worker is busy. This render starts when one is free; nothing is billed until it runs.';
/** How long a busy job waits before it asks the workers again. */
export const ASTRA_BUSY_BACKOFF_MS = 15_000;
/** A funded job that has not started after this long is cancelled and refunded (dispatch outage or busy workers alike). */
export const ASTRA_START_EXPIRY_MS = 30 * 60_000;
/** A render runs at most 180 seconds; past this from its claim, recovery stops it. */
const ASTRA_RUN_CEILING_MS = 240_000;
export function astraRenderInBusyBackoff(row: { error?: unknown; updated_at?: unknown }, at = Date.now()) {
    return row.error === ASTRA_WORKERS_BUSY && at - Number(row.updated_at) < ASTRA_BUSY_BACKOFF_MS;
}
/* Every worker answered that it did not start this job's runtime name (busy, or a refusal), so its claim
   bought nothing. Only that claim is undone, keyed by its own runtime name, in the statement that undoes it;
   a cancel that arrived meanwhile ends it as cancelled. Busy goes back to the queue, charged nothing and not
   refunded, unless it has waited past the start expiry; a refusal fails it and releases the reservation. */
async function releaseUnstartedClaim(row: JobRecord, runtimeId: string, busy: boolean, deps: AstraRenderDependencies): Promise<'busy' | undefined> {
    const requeue = busy && Date.now() - Number(row.created_at) < ASTRA_START_EXPIRY_MS;
    const status = requeue ? 'queued' : busy ? 'cancelled' : 'failed';
    const message = requeue ? ASTRA_WORKERS_BUSY : busy ? 'No render worker became free within 30 minutes. Nothing was billed.' : 'The render workers refused this render. Nothing was billed.';
    const undone = await db().execute({ sql: "UPDATE astra_render_jobs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE ? END,runtime_id=NULL,claimed_at=NULL,error=?,updated_at=? WHERE id=? AND runtime_id=? AND status IN ('starting','uncertain') AND settled=0", args: [status, message, Date.now(), row.id, runtimeId] });
    if (!undone.rowsAffected)
        return undefined;
    const current = (await record(row.id))!;
    if (current.status === 'queued')
        return 'busy';
    await settle(current, current.status === 'cancelled' ? 'cancelled' : 'failed', null, deps);
    return undefined;
}
/** Runs a funded queued job once. Answers 'busy' when it was left queued because every render worker was busy. */
export async function runAstraRender(id: string, deps: AstraRenderDependencies = {}): Promise<'busy' | undefined> {
    const row = await record(id);
    if (!row || row.status !== 'queued' || !row.funded)
        return undefined;
    if (astraRenderInBusyBackoff(row))
        return 'busy';
    let begun = false, created = false;
    let runtimeId: string | null = null;
    let usage: AstraRuntimeUsage | null = null;
    try {
        if (engineMock() && !deps.sandbox?.sdk)
            throw new Error('Native 3D compute is disabled while ENGINE_MOCK=1.');
        // Before the claim: an unconnected runtime fails here and the reservation is released.
        const runtime = astraRuntimeStatus();
        if (!runtime.configured)
            throw new Error(runtime.reason!);
        const source = JSON.parse(row.source_json) as Snapshot;
        // A job runs on the backend it was approved and reserved under, or not at all (refunded here, before the claim).
        const backend = astraBackendOfEngine(engineOf(row));
        if (backend !== astraRenderBackend())
            throw new Error('The 3D render service changed after this render was approved. Nothing was billed; render it again.');
        const inputs = await (deps.loadInputs ?? loadAstraRenderInputs)(source.assets, row.owner);
        prepareAstraInputs(source.scene, inputs.bindings, inputs.inputs, source.native);
        await (deps.assertFunding ?? assertMeterFunding)(id, engineOf(row));
        const name = `astra-blender-${randomUUID()}`;
        const claimed = await db().execute({ sql: "UPDATE astra_render_jobs SET status='starting',runtime_id=?,claimed_at=?,error=NULL,updated_at=? WHERE id=? AND status='queued' AND funded=1 AND cancel_requested=0", args: [name, Date.now(), Date.now(), id] });
        if (!claimed.rowsAffected)
            return undefined;
        begun = true;
        runtimeId = name;
        const callbacks: AstraSandboxDependencies = { ...deps.sandbox, backend, snapshotId: source.snapshotId, runtimeId: name,
            onArtifacts: async (artifacts) => {
                await db().execute({ sql: "UPDATE astra_render_jobs SET status='saving',updated_at=? WHERE id=?", args: [Date.now(), id] });
                await (deps.storeArtifacts ?? storeAstraArtifacts)(id, artifacts, async (artifact) => { await workbenchTransaction(async (tx) => { const current = (await tx.execute({ sql: 'SELECT artifacts_json FROM astra_render_jobs WHERE id=?', args: [id] })).rows[0]; const all = JSON.parse(String(current.artifacts_json)) as StoredAstraArtifact[]; const next = [...all.filter(value => value.kind !== artifact.kind), artifact]; await tx.execute({ sql: 'UPDATE astra_render_jobs SET artifacts_json=?,updated_at=? WHERE id=?', args: [JSON.stringify(next), Date.now(), id] }); }); });
                const saved = (await record(id))!;
                await (deps.registerArtifacts ?? registerAstraArtifacts)(id, row.owner, row.project_id, JSON.parse(saved.artifacts_json));
            },
            onStopped: async (value) => { usage = value; await db().execute({ sql: 'UPDATE astra_render_jobs SET usage_json=?,updated_at=? WHERE id=?', args: [JSON.stringify(value), Date.now(), id] }); },
        };
        const onCreated = async () => { created = true; const current = (await record(id))!; if (current.cancel_requested)
            throw new Error('Render cancelled before execution.'); await db().execute({ sql: "UPDATE astra_render_jobs SET status='running',updated_at=? WHERE id=?", args: [Date.now(), id] }); };
        if (source.native)
            await renderAstraNative(source.scene, source.native, inputs.bindings, inputs.inputs, onCreated, callbacks);
        else
            await renderAstraScene(source.scene, inputs.bindings as Parameters<typeof renderAstraScene>[1], inputs.inputs, onCreated, callbacks);
        await settle((await record(id))!, 'succeeded', usage, deps);
        return undefined;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Native render failed.';
        if (begun && !created && runtimeId && (error instanceof AstraWorkerBusyError || error instanceof AstraWorkerRefusedError))
            return releaseUnstartedClaim(row, runtimeId, error instanceof AstraWorkerBusyError, deps);
        if (!begun) {
            // Another host may have claimed this job since the checks above. Only a job that is
            // still unclaimed is ended here, in the same statement that ends it; a claimed one is left alone.
            const ended = await db().execute({ sql: "UPDATE astra_render_jobs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END,error=?,updated_at=? WHERE id=? AND status='queued' AND runtime_id IS NULL", args: [message.slice(0, 600), Date.now(), id] });
            if (ended.rowsAffected) {
                const current = (await record(id))!;
                await settle(current, current.status === 'cancelled' ? 'cancelled' : 'failed', null, deps);
            }
            return undefined;
        }
        const current = (await record(id))!;
        await db().execute({ sql: 'UPDATE astra_render_jobs SET error=?,updated_at=? WHERE id=?', args: [message.slice(0, 600), Date.now(), id] });
        if (usage) {
            const receipts=JSON.parse(current.artifacts_json) as StoredAstraArtifact[];
            if(!current.outputs_registered && receipts.some(a=>a.kind==='blend') && receipts.some(a=>a.kind==='preview'))
                await db().execute({sql: "UPDATE astra_render_jobs SET status='uncertain',error=?,updated_at=? WHERE id=?",args:['Native outputs are stored; project registration will resume without a new render.',Date.now(),id]});
            else await settle(current, current.outputs_registered ? 'succeeded' : current.cancel_requested ? 'cancelled' : 'failed', usage, deps);
        }
        else
            await db().execute({ sql: "UPDATE astra_render_jobs SET status='uncertain',updated_at=? WHERE id=?", args: [Date.now(), id] });
        return undefined;
    }
}
/** Recovery can look up and stop an existing identity. It never creates a VM. */
export async function reconcileAstraRender(id: string, deps: AstraRenderDependencies = {}) {
    let row = await record(id);
    if (!row || row.settled)
        return;
    if (!row.funded) {
        if (Date.now() - Number(row.created_at) < 600000 && row.status !== 'uncertain')
            return;
        const meterRow = (await platformDb().execute({ sql: 'SELECT status FROM meter_events WHERE id=? AND workspace_id=?', args: [id, requireTenant().id] })).rows[0];
        if (meterRow?.status === 'running') {
            await db().execute({ sql: 'UPDATE astra_render_jobs SET funded=1 WHERE id=?', args: [id] });
            row = (await record(id))!;
        }
        else {
            await db().execute({ sql: "UPDATE astra_render_jobs SET status='failed',settled=1,error='Compute admission did not complete. No runtime was started.',updated_at=? WHERE id=?", args: [Date.now(), id] });
            await releaseStorage(row);
            return;
        }
        // An interrupted admission has not crossed the paid-start boundary. Cancel and refund;
        // the user may then deliberately submit a newly reviewed request.
        await settle(row, 'cancelled', null, deps);
        return;
    }
    if (row.status === 'queued')
        return;
    if (!row.runtime_id) {
        await settle(row, 'cancelled', null, deps);
        return;
    }
    // Measured from the claim: a job can wait in the queue (busy workers, dispatch outage) long before it starts.
    const startedAt = Number(row.claimed_at ?? row.created_at);
    const cachedUsage = row.usage_json ? JSON.parse(row.usage_json) as AstraRuntimeUsage | null : null;
    let state: { status: string; usage: AstraRuntimeUsage | null };
    if (cachedUsage)
        state = { status: 'stopped', usage: cachedUsage };
    else {
        try {
            state = await getAstraRenderStatus(row.runtime_id, sandboxFor(row, deps));
        }
        catch (error) {
            // No self-hosted worker holds the name and every worker answered. Past the run ceiling it can only
            // have ended (or never begun): read as stopped with no usage, which holds the reservation as uncertain.
            if (!(error instanceof AstraWorkerSessionMissingError) || Date.now() - startedAt <= ASTRA_RUN_CEILING_MS)
                throw error;
            state = { status: 'stopped', usage: null };
        }
    }
    if (!['stopped', 'failed', 'aborted'].includes(state.status)) {
        if (row.cancel_requested || Date.now() - startedAt > ASTRA_RUN_CEILING_MS) {
            const stopped = await cancelAstraRender(row.runtime_id, sandboxFor(row, deps));
            // A self-hosted stop wipes the session: keep its final usage for the next pass to settle with.
            if (stopped.usage)
                await db().execute({ sql: 'UPDATE astra_render_jobs SET usage_json=?,updated_at=? WHERE id=? AND usage_json IS NULL', args: [JSON.stringify(stopped.usage), Date.now(), id] });
        }
        return;
    }
    const artifacts = JSON.parse(row.artifacts_json) as StoredAstraArtifact[];
    if (!row.outputs_registered && artifacts.some(a => a.kind === 'blend') && artifacts.some(a => a.kind === 'preview')) {
        await (deps.registerArtifacts ?? registerAstraArtifacts)(id, row.owner, row.project_id, artifacts);
        row = (await record(id))!;
    }
    await settle(row, row.outputs_registered ? 'succeeded' : row.cancel_requested ? 'cancelled' : 'failed', state.usage, deps);
}
export async function cancelAstraRenderJob(owner: string, projectId: string, id: string, deps: AstraRenderDependencies = {}) {
    await getAtomikProject(owner, projectId);
    const row = await record(id);
    if (!row || row.owner !== owner || row.project_id !== projectId)
        throw new AstraRenderError('Render not found.', 404);
    if (row.settled)
        return publicJob(row);
    await db().execute({ sql: 'UPDATE astra_render_jobs SET cancel_requested=1,updated_at=? WHERE id=?', args: [Date.now(), id] });
    // Saving runs already completed Blender. Let the bounded artifact write finish
    // before settlement or cleanup; a concurrent delete could race a late Blob PUT.
    if(row.status==='saving')return publicJob((await record(id))!);
    const cancelled = await db().execute({ sql: "UPDATE astra_render_jobs SET status='cancelled' WHERE id=? AND status='queued'", args: [id] });
    if (cancelled.rowsAffected && row.funded)
        await settle(row, 'cancelled', null, deps);
    else if (row.runtime_id) {
        try {
            const result = await cancelAstraRender(row.runtime_id, sandboxFor(row, deps));
            const current = (await record(id))!;
            await settle(current, current.outputs_registered ? 'succeeded' : 'cancelled', result.usage, deps);
        }
        catch {
            await db().execute({ sql: "UPDATE astra_render_jobs SET status='uncertain',error='Cancellation is pending runtime confirmation.',updated_at=? WHERE id=? AND settled=0", args: [Date.now(), id] });
        }
    }
    return publicJob((await record(id))!);
}
export async function pendingAstraRenders(limit = 4) { await astraRenderReady(); return (await db().execute({ sql: 'SELECT id,status,owner,funded,error,updated_at FROM astra_render_jobs WHERE settled=0 ORDER BY updated_at ASC LIMIT ?', args: [limit] })).rows as unknown as Pick<JobRecord, 'id' | 'status' | 'owner' | 'funded' | 'error' | 'updated_at'>[]; }

/** A permanently unavailable dispatcher must not hold an unstarted reservation
 * forever. Only the same queued/no-runtime claim can expire; a concurrent
 * worker that already claimed its VM is never cancelled by this path. */
export async function deferAstraRenderDispatch(id: string, deps: AstraRenderDependencies = {}): Promise<boolean> {
    const row = await record(id);
    if (!row || row.status !== 'queued' || !row.funded || row.runtime_id) return false;
    const expired = Date.now() - Number(row.created_at) >= ASTRA_START_EXPIRY_MS;
    const updated = await db().execute({
        sql: "UPDATE astra_render_jobs SET status=?,cancel_requested=?,error=?,updated_at=? WHERE id=? AND status='queued' AND runtime_id IS NULL AND funded=1 AND cancel_requested=0",
        args: [expired ? 'cancelled' : 'queued', expired ? 1 : 0,
            expired ? 'No runtime started because render dispatch remained unavailable for 30 minutes.' : 'Render dispatch is temporarily unavailable. Recovery will retry; no runtime has started.', Date.now(), id],
    });
    if (!updated.rowsAffected) return false;
    if (expired) await settle((await record(id))!, 'cancelled', null, deps);
    return expired;
}
