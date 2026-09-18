import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { TenantWorkspace } from '../../lib/tenant';
import type { AstraSandboxHandle, AstraSandboxSdk } from '../../lib/astra-blender/sandbox';
const directory = mkdtempSync(path.join(tmpdir(), 'astra-render-jobs-'));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, 'platform.db')}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, 'primary.db')}`;
process.env.KEYRING_SECRET ??= 'unit-test-keyring-secret-unit-test-keyring';
process.env.ENGINE_MOCK = '1';
process.env.ASTRA_BLENDER_SNAPSHOT_ID = 'snap_verified-test';
process.env.ASTRA_BLENDER_RATE_CARD = JSON.stringify({ cpuUsdPerHour: 0.128, memoryUsdPerGbHour: 0.0212, egressUsdPerGb: 0.15, createUsd: 0.0000006 });
const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: true, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: 'u_test', createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
async function context(name: string, run: (modules: Awaited<ReturnType<typeof setup>>) => Promise<void>) { const { runInTenant } = await import('../../lib/tenant'); await runInTenant(workspace(name), async () => run(await setup())); }
async function setup() { const jobs = await import('../../lib/astra-blender/render-jobs'); const { db } = await import('../../lib/db'); const { newProject } = await import('../../lib/workbench/studio'); const { createAstraScene } = await import('../../lib/astra-blender/scene'); const { astraSceneDigest } = await import('../../lib/astra-blender/proposal'); await jobs.astraRenderReady(); const project = { ...newProject('Native test'), id: 'project-test', assets: [], productionProjectId: 'production-test', astraBlender: createAstraScene('product') }; await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('production-test','Native test',?)", args: [Date.now()] }); await db().execute({ sql: 'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: ['draft-test', 'u_test', project.id, project.name, JSON.stringify(project), Date.now()] }); const input = { projectId: project.id, requestId: 'request-native-1', source: 'scene' as const, sourceDigest: await astraSceneDigest(project.astraBlender) }; const { quote } = await jobs.quoteAstraRender(input, 'u_test'); return { ...jobs, db, project, input: { ...input, quoteDigest: quote.quoteDigest, maxCredits: quote.estimateCredits }, quote }; }
function fake() {
    let creates = 0, runs = 0, reserves = 0;
    const order: string[] = [];
    const charges: number[] = [];
    const body=Buffer.from(JSON.stringify({asset:{version:'2.0'},buffers:[{byteLength:4}]}));
    const padding=Buffer.alloc(Math.ceil(body.length/4)*4,32);body.copy(padding);
    const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(32+padding.length,8);header.writeUInt32LE(padding.length,12);header.writeUInt32LE(0x4e4f534a,16);
    const binary=Buffer.alloc(12);binary.writeUInt32LE(4);binary.writeUInt32LE(0x004e4942,4);const glb=Buffer.concat([header,padding,binary]);
    const handle: AstraSandboxHandle = { name: '', status: 'running', totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 512,
        writeFiles: async () => { order.push('write'); }, runCommand: async () => { runs++; return { exitCode: 0 }; }, readFile: async ({ path }) => Readable.from([path.endsWith('.blend') ? Buffer.from('BLENDER-v502test') : path.endsWith('.png') ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDpkAAAAASUVORK5CYII=','base64') : glb]), stop: async () => { order.push('stop'); handle.status = 'stopped'; } };
    const sdk: AstraSandboxSdk = { create: async (options) => { creates++; order.push('create'); handle.name = options.name!; return handle; }, get: async () => handle };
    const deps: import('../../lib/astra-blender/render-jobs').AstraRenderDependencies = { sandbox: { sdk }, reserve: async () => { reserves++; }, assertFunding: async () => { }, meter: async (event) => { charges.push(event.engineCostUsd ?? 0); }, loadInputs: async () => ({ bindings: {}, inputs: [] }), storeArtifacts: async (jobId, data, onStored) => { order.push('store'); const { astraArtifactPlan } = await import('../../lib/astra-blender/render-storage'); for (const artifact of astraArtifactPlan(jobId)) {
            await onStored({ ...artifact, bytes: data[artifact.kind]!.length, sha256: 'a'.repeat(64), storedUrl: artifact.url });
        } } };
    return { handle, sdk, deps, order, charges, get creates() { return creates; }, get runs() { return runs; }, get reserves() { return reserves; } };
}
test('quotes bind saved source and duplicate requests purchase exactly one runtime', async () => context('idempotency', async (m) => { const f = fake(); const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps); const duplicate = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps); expect(duplicate.job.id).toBe(first.job.id); expect(f.reserves).toBe(1); await Promise.all([m.runAstraRender(first.job.id, f.deps), m.runAstraRender(first.job.id, f.deps)]); expect(f.creates).toBe(1); expect(f.runs).toBe(1); const job = (await m.listAstraRenderJobs('u_test', m.project.id))[0]; expect(job.status).toBe('succeeded'); expect(job.assetsRegistered).toBe(true); expect(job.artifacts).toHaveLength(3); expect(f.order.indexOf('store')).toBeLessThan(f.order.indexOf('stop')); expect(f.charges).toHaveLength(1); expect(f.charges[0]).toBeLessThan(m.quote.maxCostUsd); expect(Number((await m.db().execute('SELECT SUM(reserved_bytes) AS n FROM astra_render_storage')).rows[0].n)).toBe(0); const saved = JSON.parse(String((await m.db().execute('SELECT body FROM workbench_projects')).rows[0].body)); expect(saved.assets).toHaveLength(3); }));
test('stale quotes and cross-owner identities cannot start or cancel a render', async () => context('scope', async (m) => { const f = fake(); await expect(m.prepareAstraRender({ ...m.input, sourceDigest: '0'.repeat(64) }, 'u_test', undefined, f.deps)).rejects.toMatchObject({ status: 409 }); const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps); await expect(m.prepareAstraRender({ ...m.input, maxCredits: 99 }, 'u_test', undefined, f.deps)).rejects.toMatchObject({ status: 409 }); await expect(m.cancelAstraRenderJob('other-owner', m.project.id, first.job.id, f.deps)).rejects.toMatchObject({ status: 404 }); expect(f.creates).toBe(0); }));
test('cancelled queued jobs refund reservation and never purchase compute', async () => context('cancel', async (m) => { const f = fake(); const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps); expect((await m.cancelAstraRenderJob('u_test', m.project.id, first.job.id, f.deps)).status).toBe('cancelled'); await m.runAstraRender(first.job.id, f.deps); expect(f.creates).toBe(0); expect(f.charges).toEqual([0]); }));
test('an ambiguous create persists identity and recovery never replays purchase', async () => context('ambiguous', async (m) => { const f = fake(); f.sdk.create = async (options) => { f.handle.name = options.name!; throw new Error('reply lost after create'); }; const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps); await m.runAstraRender(first.job.id, f.deps); let job = (await m.listAstraRenderJobs('u_test', m.project.id))[0]; expect(job.status).toBe('uncertain'); const row = (await m.db().execute({ sql: 'SELECT runtime_id FROM astra_render_jobs WHERE id=?', args: [job.id] })).rows[0]; expect(row.runtime_id).toBe(f.handle.name); await m.runAstraRender(job.id, f.deps); expect(f.runs).toBe(0); f.handle.status = 'stopped'; await m.reconcileAstraRender(job.id, f.deps); job = (await m.listAstraRenderJobs('u_test', m.project.id))[0]; expect(job.status).toBe('failed'); expect(f.charges).toHaveLength(1); }));
test('missing telemetry holds the reviewed reservation without manufacturing a final charge', async () => context('usage', async (m) => { const f = fake(); f.handle.totalActiveCpuDurationMs = undefined; const first = await m.prepareAstraRender(m.input, 'u_test', undefined, f.deps); await m.runAstraRender(first.job.id, f.deps); const job = (await m.listAstraRenderJobs('u_test', m.project.id))[0]; expect(job.status).toBe('uncertain'); expect(job.assetsRegistered).toBe(true); expect(job.costUsd).toBeNull(); expect(f.charges).toEqual([]); await m.runAstraRender(job.id, f.deps); expect(f.creates).toBe(1); }));
test('native source revisions are part of the quote and executable source is never accepted in API input', async () => context('native-source', async (m) => { const { astraNativeDigest } = await import('../../lib/astra-blender/native'); const source = { schemaVersion: 1 as const, name: 'Native scene', program: 'bpy.context.scene.cycles.samples = 1', assetIds: [] }; const project = { ...m.project, astraNative: source }; await m.db().execute({ sql: 'UPDATE workbench_projects SET body=?', args: [JSON.stringify(project)] }); const input = { ...m.input, source: 'native' as const, sourceDigest: await astraNativeDigest(source) }; const { quote } = await m.quoteAstraRender(input, 'u_test'); expect(quote.quoteDigest).not.toBe(m.quote.quoteDigest); expect(m.astraRenderRequestSchema.safeParse({ ...input, program: 'print(1)' }).success).toBe(false); project.astraBlender.camera.position[0] += 1; await m.db().execute({ sql: 'UPDATE workbench_projects SET body=?', args: [JSON.stringify(project)] }); await expect(m.prepareAstraRender({ ...input, quoteDigest: quote.quoteDigest }, 'u_test', undefined, fake().deps)).rejects.toMatchObject({ status: 409 }); }));
test('storage quota reserves the maximum outputs before any compute admission', async () => context('quota', async (m) => { const { requireTenant } = await import('../../lib/tenant'); requireTenant().storageQuotaBytes = 1; const f = fake(); await expect(m.prepareAstraRender(m.input, 'u_test', undefined, f.deps)).rejects.toMatchObject({ status: 507 }); expect(f.reserves).toBe(0); expect(f.creates).toBe(0); }));


test('stored native outputs survive a failed project registration and recover without another VM',async()=>context('registration-recovery',async m=>{
 const f=fake();let registers=0;
 const {registerAstraArtifacts}=await import('../../lib/astra-blender/render-storage');
 f.deps.registerArtifacts=async(...args)=>{registers++;if(registers===1)throw new Error('temporary draft database outage');return registerAstraArtifacts(...args);};
 const first=await m.prepareAstraRender(m.input,'u_test',undefined,f.deps);
 await m.runAstraRender(first.job.id,f.deps);
 let job=(await m.listAstraRenderJobs('u_test',m.project.id))[0];expect(job.status).toBe('uncertain');expect(job.artifacts).toHaveLength(3);expect(f.charges).toEqual([]);
 await m.reconcileAstraRender(job.id,f.deps);job=(await m.listAstraRenderJobs('u_test',m.project.id))[0];expect(job.status).toBe('succeeded');expect(job.assetsRegistered).toBe(true);expect(f.creates).toBe(1);expect(f.charges).toHaveLength(1);
}));

test('funding changes and lost source files fail before runtime creation and release compute reservations',async()=>context('preflight-failure',async m=>{
 const f=fake();const first=await m.prepareAstraRender(m.input,'u_test',undefined,f.deps);
 f.deps.assertFunding=async()=>{throw new Error('Workspace suspended before execution');};
 await m.runAstraRender(first.job.id,f.deps);expect(f.creates).toBe(0);expect(f.charges).toEqual([0]);expect((await m.listAstraRenderJobs('u_test',m.project.id))[0].status).toBe('failed');
}));


test('render admission reserves three project slots and concurrent project growth preserves saved originals',async()=>context('asset-cap',async m=>{
 const f=fake();const asset=(n:number)=>({id:`asset-${n}`,name:`Asset ${n}`,kind:'document' as const,category:'test',url:`https://example.test/${n}`,description:'',prompt:'',status:'Draft' as const,locked:false,version:1,refs:[]});
 const crowded={...m.project,assets:Array.from({length:498},(_,i)=>asset(i))};
 await m.db().execute({sql:'UPDATE workbench_projects SET body=?',args:[JSON.stringify(crowded)]});
 await expect(m.quoteAstraRender(m.input,'u_test')).rejects.toMatchObject({status:422});
 await m.db().execute({sql:'UPDATE workbench_projects SET body=?',args:[JSON.stringify(m.project)]});
 const first=await m.prepareAstraRender(m.input,'u_test',undefined,f.deps);
 crowded.assets=Array.from({length:500},(_,i)=>asset(i));await m.db().execute({sql:'UPDATE workbench_projects SET body=?',args:[JSON.stringify(crowded)]});
 await m.runAstraRender(first.job.id,f.deps);
 const job=(await m.listAstraRenderJobs('u_test',m.project.id))[0];expect(job.status).toBe('succeeded');expect(job.assetsRegistered).toBe(false);expect(job.error).toContain('Library');expect(job.artifacts).toHaveLength(3);
 const project=JSON.parse(String((await m.db().execute('SELECT body FROM workbench_projects')).rows[0].body));expect(project.assets).toHaveLength(500);expect(Number((await m.db().execute('SELECT COUNT(*) AS n FROM uploads')).rows[0].n)).toBe(3);expect(Number((await m.db().execute('SELECT COUNT(*) AS n FROM astra_render_storage')).rows[0].n)).toBe(0);
}));

test('mock mode refuses real compute before the runtime claim and refunds a queued reservation',async()=>context('mock-real-refusal',async m=>{
 const f=fake();const first=await m.prepareAstraRender(m.input,'u_test',undefined,f.deps);
 await m.runAstraRender(first.job.id,{...f.deps,sandbox:undefined});
 const job=(await m.listAstraRenderJobs('u_test',m.project.id))[0];expect(job.status).toBe('failed');expect(job.error).toContain('ENGINE_MOCK');expect(job.costUsd).toBe(0);expect(f.charges).toEqual([0]);expect(f.creates).toBe(0);
 expect((await m.db().execute('SELECT runtime_id FROM astra_render_jobs')).rows[0].runtime_id).toBeNull();
}));

test('poll recovery runs an unclaimed job once without Inngest when a full native time budget fits',async()=>context('dispatch-inline',async m=>{
 const {recoverAstraRenders}=await import('../../lib/astra-blender/render-dispatch');
 const f=fake();await m.prepareAstraRender(m.input,'u_test',undefined,f.deps);
 const report=await recoverAstraRenders({limit:1,deadlineAt:Date.now()+250000},{enqueue:async()=>false,run:id=>m.runAstraRender(id,f.deps)});
 expect(report).toEqual({attempted:1,failed:0,deferred:0});expect(f.creates).toBe(1);expect((await m.listAstraRenderJobs('u_test',m.project.id))[0].status).toBe('succeeded');
 await recoverAstraRenders({limit:1,deadlineAt:Date.now()+250000},{enqueue:async()=>false,run:id=>m.runAstraRender(id,f.deps)});expect(f.creates).toBe(1);
}));

test('short recovery windows defer visibly then refund only stale jobs that have never claimed a VM',async()=>context('dispatch-deferred',async m=>{
 const {recoverAstraRenders}=await import('../../lib/astra-blender/render-dispatch');
 const f=fake();const first=await m.prepareAstraRender(m.input,'u_test',undefined,f.deps);
 const dependencies={enqueue:async()=>false,run:async()=>{throw new Error('Insufficient time for a native VM');},defer:(id:string)=>m.deferAstraRenderDispatch(id,f.deps)};
 expect(await recoverAstraRenders({limit:1,deadlineAt:Date.now()+25000},dependencies)).toEqual({attempted:1,failed:0,deferred:1});
 let job=(await m.listAstraRenderJobs('u_test',m.project.id))[0];expect(job.status).toBe('queued');expect(job.error).toContain('temporarily unavailable');expect(f.charges).toEqual([]);
 await m.db().execute({sql:'UPDATE astra_render_jobs SET created_at=? WHERE id=?',args:[Date.now()-31*60000,first.job.id]});
 expect(await recoverAstraRenders({limit:1,deadlineAt:Date.now()+25000},dependencies)).toEqual({attempted:1,failed:0,deferred:0});
 job=(await m.listAstraRenderJobs('u_test',m.project.id))[0];expect(job.status).toBe('cancelled');expect(job.error).toContain('30 minutes');expect(f.charges).toEqual([0]);expect(f.creates).toBe(0);
}));
