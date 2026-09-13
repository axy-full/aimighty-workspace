import {test,expect} from '@playwright/test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {TenantWorkspace} from '../../lib/tenant';
import type {VideoJob} from '../../lib/submitVideo';

const dir=mkdtempSync(path.join(tmpdir(),'particl-video-submit-'));
process.env.PLATFORM_DATABASE_URL=`file:${path.join(dir,'platform.db')}`;
process.env.TURSO_DATABASE_URL=`file:${path.join(dir,'primary.db')}`;
process.env.KEYRING_SECRET??='unit-test-keyring-secret-unit-test-keyring';
process.env.ENGINE_MOCK='1';
function workspace(name:string):TenantWorkspace{return {id:'ws_'+name,slug:name,name,legacy:true,dbUrl:`file:${path.join(dir,name+'.db')}`,dbToken:null,keys:{},usesPlatformKeys:false,allowanceUsd:null,gatewayKeyId:null,ownerId:'owner',createdAt:0,suspendedAt:null,suspendedReason:null,flaggedAt:null,flagNote:null,concurrency:null,rendersPerHour:null,storageQuotaBytes:null,deletedAt:null};}
async function makeJob(genId:string,provider:'byteplus'|'fal'='byteplus'):Promise<VideoJob>{
 const {db,ready,now}=await import('../../lib/db');const {getModel}=await import('../../lib/models');const {getTask}=await import('../../lib/tasks');const {meter}=await import('../../lib/meter');
 await ready();const model=getModel(provider==='fal'?'fal-ai/kling-video/v3/standard':'dreamina-seedance-2-0-260128');
 const params={ratio:'16:9',resolution:'720p',duration:5,watermark:false};
 await db().execute({sql:`INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_at,updated_at) VALUES(?,'video',?,'Test',?,'queued',?,'generate',?,?)`,args:[genId,model.id,JSON.stringify(params),provider,now(),now()]});
 await meter({id:genId,kind:'video',engine:provider,model:model.id,status:'running',engineCostUsd:.7});
 return {genId,model,task:getTask('generate'),prompt:'Test',params,references:[],source:null,ts:now()};
}

test('concurrent submission and late held-row delivery have one durable paid owner',async()=>{
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoJob,submitVideoRow}=await import('../../lib/submitVideo');
 const engine=engineFor('byteplus'),original=engine.render;let calls=0;let enter!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{enter=r}),wait=new Promise<void>(r=>{release=r});
 engine.render=async()=>{calls++;enter();await wait;return {handle:{provider:'byteplus',ref:'accepted-once',model:'mock'}};};
 try{await runInTenant(workspace('duplicate'),async()=>{
  const job=await makeJob('gen_duplicate');const first=submitVideoJob(job);await started;
  expect((await submitVideoRow(job.genId)).ok).toBe(false);expect(calls).toBe(1);
  release();expect(await first).toEqual({ok:true,taskId:'accepted-once',attempts:1});
  expect(await submitVideoRow(job.genId)).toEqual({ok:true,taskId:'accepted-once',attempts:1});expect(calls).toBe(1);
 });}finally{release?.();engine.render=original;}
});

test('transport failures, 5xx and malformed acceptance never retry or refund uncertain spend',async()=>{
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoJob}=await import('../../lib/submitVideo');const {db}=await import('../../lib/db');const {platformDb}=await import('../../lib/platform');
 const failures:[('byteplus'|'fal'),string][]=[['byteplus','Could not reach ModelArk: fetch failed'],['byteplus','Ark submit failed (500): upstream failure'],['fal','Could not reach fal.ai: socket hang up'],['fal','fal.ai did not answer within 60s. The job may still be on their queue.'],['fal','fal.ai returned 503: upstream failure.'],['byteplus','ModelArk sent an unreadable submit response']];
 for(const [index,[provider,message]] of failures.entries()){
  const engine=engineFor(provider),original=engine.render;let calls=0;
  engine.render=async()=>{calls++;throw new Error(message);};
  try{await runInTenant(workspace('uncertain_'+index),async()=>{
   const job=await makeJob('gen_uncertain_'+index,provider);const result=await submitVideoJob(job);
   expect(result.ok).toBe(false);if(!result.ok){expect(result.cls).toBe('uncertain');expect(result.error).toContain('estimated cost remains reserved');}
   expect((await submitVideoJob(job)).ok).toBe(false);expect(calls).toBe(1);
   const row=(await db().execute({sql:'SELECT status,cost_usd,attempts FROM generations WHERE id=?',args:[job.genId]})).rows[0];expect(row.status).toBe('failed');expect(row.cost_usd).toBe(.7);expect(row.attempts).toBe(1);
   const event=(await platformDb().execute({sql:'SELECT engine_cost_usd,status FROM meter_events WHERE id=?',args:[job.genId]})).rows[0];expect(event.engine_cost_usd).toBe(.7);expect(event.status).toBe('failed');
  });}finally{engine.render=original;}
 }
});

test('explicit provider rejection releases only the rejected reservation without automatic retries',async()=>{
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoJob}=await import('../../lib/submitVideo');const {platformDb}=await import('../../lib/platform');
 for(const provider of ['byteplus','fal'] as const){
  const engine=engineFor(provider),original=engine.render;let calls=0;
  engine.render=async()=>{calls++;throw new Error(provider==='fal'?'fal.ai refused the request: invalid input.':'Ark submit failed (422): invalid input');};
  try{await runInTenant(workspace('rejected_'+provider),async()=>{
   const job=await makeJob('gen_rejected_'+provider,provider);const result=await submitVideoJob(job);
   expect(result.ok).toBe(false);if(!result.ok)expect(result.cls).toBe('fatal');
   await submitVideoJob(job);expect(calls).toBe(1);
   expect((await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[job.genId]})).rows[0].engine_cost_usd).toBe(0);
  });}finally{engine.render=original;}
 }
});

test('handle writes retry safely, and committed writes with lost acknowledgments recover without resubmitting',async()=>{
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoJob,submitVideoRow}=await import('../../lib/submitVideo');const {db}=await import('../../lib/db');
 for(const provider of ['byteplus','fal'] as const){
  const engine=engineFor(provider),original=engine.render;let calls=0;
  engine.render=async()=>{calls++;return {handle:{provider,ref:'saved-'+provider,model:'mock',endpoint:'fal-endpoint'}};};
  try{await runInTenant(workspace('persist_'+provider),async()=>{
   const job=await makeJob('gen_persist_'+provider,provider);const client=db(),execute=client.execute.bind(client);let attempts=0;
   client.execute=async(...args:Parameters<typeof client.execute>)=>{
    const statement=args[0] as unknown as string|{sql:string};
    const sql=typeof statement==='string'?statement:statement.sql;
    if(sql.includes("'$.producedOutcome'")){
     attempts++;
     if(provider==='fal')await execute(...args); // The write commits but its acknowledgment is lost.
     if(provider==='fal'||attempts<3)throw new Error('Database response lost');
    }
    return execute(...args);
   };
   try{expect(await submitVideoJob(job)).toEqual({ok:true,taskId:'saved-'+provider,attempts:1});}finally{client.execute=execute;}
   expect(attempts).toBe(3);expect(calls).toBe(1);
   expect(await submitVideoRow(job.genId)).toEqual({ok:true,taskId:'saved-'+provider,attempts:1});expect(calls).toBe(1);
   // Recovery of an internal persisted outcome never calls the paid adapter.
   await db().execute({sql:`UPDATE generations SET ark_task_id=NULL,params=json_remove(params,'$.falRequestId','$.falModel'),status='queued' WHERE id=?`,args:[job.genId]});
   expect(await submitVideoRow(job.genId)).toEqual({ok:true,taskId:'saved-'+provider,attempts:1});expect(calls).toBe(1);
  });}finally{engine.render=original;}
 }
});
