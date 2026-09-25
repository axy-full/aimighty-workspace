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
function workspace(name:string,keys:Record<string,string>={}):TenantWorkspace{return {id:'ws_'+name,slug:name,name,legacy:true,dbUrl:`file:${path.join(dir,name+'.db')}`,dbToken:null,keys,usesPlatformKeys:false,allowanceUsd:null,gatewayKeyId:null,ownerId:'owner',createdAt:0,suspendedAt:null,suspendedReason:null,flaggedAt:null,flagNote:null,concurrency:null,rendersPerHour:null,storageQuotaBytes:null,deletedAt:null};}
async function makeJob(genId:string,provider:'byteplus'|'fal'|'xai'='byteplus'):Promise<VideoJob>{
 const {db,ready,now}=await import('../../lib/db');const {getModel}=await import('../../lib/models');const {getTask}=await import('../../lib/tasks');const {meter}=await import('../../lib/meter');
 await ready();const model=getModel(provider==='fal'?'fal-ai/kling-video/v3/standard':provider==='xai'?'grok-imagine-video-1.5':'dreamina-seedance-2-0-260128');
 const params={ratio:'16:9',resolution:'720p',duration:5,watermark:false};
 await db().execute({sql:`INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_at,updated_at) VALUES(?,'video',?,'Test',?,'queued',?,'generate',?,?)`,args:[genId,model.id,JSON.stringify(params),provider,now(),now()]});
 const {billedTo}=await import('../../lib/providers');
 await meter({id:genId,kind:'video',engine:billedTo(provider),model:model.id,status:'running',engineCostUsd:.7});
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
 const {FalHttpError}=await import('../../lib/fal');const {XaiHttpError}=await import('../../lib/xaiVideo');
 // The shapes the adapters really throw (lib/fal.ts call(), lib/xaiVideo.ts, lib/ark.ts).
 const failures:[('byteplus'|'fal'|'xai'),()=>Error][]=[['byteplus',()=>new Error('Could not reach the video engine: fetch failed')],['byteplus',()=>new Error('Ark submit failed (500): upstream failure')],['fal',()=>new Error('Could not reach the render service: socket hang up')],['fal',()=>new Error('The render service did not answer within 60s. The job may still be on their queue.')],['fal',()=>new FalHttpError(503,'The render service returned 503: upstream failure.')],['byteplus',()=>new Error('The video engine sent an unreadable submit response')],['xai',()=>new XaiHttpError(500,'Grok Imagine Video refused the request (500): upstream failure')],['xai',()=>new XaiHttpError(408,'Grok Imagine Video refused the request (408): timeout')],['xai',()=>new Error('Grok Imagine Video returned no request id.')]];
 for(const [index,[provider,failure]] of failures.entries()){
  const engine=engineFor(provider),original=engine.render;let calls=0;
  engine.render=async()=>{calls++;throw failure();};
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
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoJob}=await import('../../lib/submitVideo');const {platformDb}=await import('../../lib/platform');const {db}=await import('../../lib/db');
 const {FalHttpError}=await import('../../lib/fal');const {XaiHttpError}=await import('../../lib/xaiVideo');const {preflight}=await import('../../lib/preflight');
 const refusals:[('byteplus'|'fal'|'xai'),()=>Promise<never>][]=[
  ['byteplus',async()=>{throw new Error('Ark submit failed (422): invalid input');}],
  ['fal',async()=>{throw new FalHttpError(422,'The render service refused the request: invalid input.');}],
  ['fal',async()=>{throw new FalHttpError(402,'The render service account is out of credit — top it up in the render account billing settings.');}],
  ['fal',async()=>{throw new FalHttpError(401,'The render service rejected the key (401).');}],
  ['fal',async()=>{throw new FalHttpError(429,'The render service rate limit — too many requests at once. Try a new request later.');}],
  ['xai',async()=>{throw new XaiHttpError(422,'Grok Imagine Video refused the request (422): moderated');}],
  ['xai',async()=>{throw new XaiHttpError(403,'Grok Imagine Video refused the request (403): forbidden');}],
  // Anything raised while the request is still being built was never sent.
  ['xai',()=>preflight(()=>{throw new Error('Grok Imagine Video 1.5 renders from reference images at up to 720p. Choose 720p or 480p.');})],
  ['fal',()=>preflight(async()=>{throw new Error('Motion control needs a still of the character — attach one.');})],
  ['byteplus',()=>preflight(async()=>{throw new Error('Request body is 70.0 MB, over the video engine\'s 64 MB limit.');})],
 ];
 for(const [index,[provider,refuse]] of refusals.entries()){
  const engine=engineFor(provider),original=engine.render;let calls=0;
  engine.render=async()=>{calls++;return refuse();};
  try{await runInTenant(workspace('rejected_'+index),async()=>{
   const job=await makeJob('gen_rejected_'+index,provider);const result=await submitVideoJob(job);
   expect(result.ok).toBe(false);if(!result.ok){expect(result.cls).not.toBe('uncertain');expect(result.error).not.toContain('estimated cost remains reserved');}
   await submitVideoJob(job);expect(calls).toBe(1);
   expect((await db().execute({sql:'SELECT status,cost_usd FROM generations WHERE id=?',args:[job.genId]})).rows[0]).toMatchObject({status:'failed',cost_usd:0});
   expect((await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[job.genId]})).rows[0].engine_cost_usd).toBe(0);
  });}finally{engine.render=original;}
 }
});

test('the real xAI and fal adapters report refusals and unsent requests as rejected, never as uncertain',async()=>{
 const {runInTenant}=await import('../../lib/tenant');const {submitVideoJob}=await import('../../lib/submitVideo');const {platformDb}=await import('../../lib/platform');
 const originalFetch=globalThis.fetch;const posts:string[]=[];
 let reply:()=>Response=()=>Response.json({error:{message:'unused'}},{status:500});
 globalThis.fetch=async(input:RequestInfo|URL)=>{posts.push(String(input));return reply();};
 process.env.ENGINE_MOCK='0';
 const reserved=async(id:string)=>(await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[id]})).rows[0].engine_cost_usd;
 try{
  await runInTenant(workspace('real_xai',{xai:'unit-test-key'}),async()=>{
   reply=()=>Response.json({error:{message:'Content moderated'}},{status:422});
   const refused=await makeJob('gen_real_xai_422','xai');
   expect(await submitVideoJob(refused)).toMatchObject({ok:false,cls:'fatal'});expect(posts).toHaveLength(1);expect(await reserved(refused.genId)).toBe(0);
   reply=()=>new Response('upstream',{status:502});
   const unknown=await makeJob('gen_real_xai_502','xai');
   expect(await submitVideoJob(unknown)).toMatchObject({ok:false,cls:'uncertain'});expect(posts).toHaveLength(2);expect(await reserved(unknown.genId)).toBe(.7);
   const guided=await makeJob('gen_real_xai_1080','xai');guided.params={...guided.params,resolution:'1080p'};
   guided.references=[{id:'guide',kind:'image',mime:'image/png',ext:'png',storedUrl:'/guide.png',role:'reference_image'}];
   const result=await submitVideoJob(guided);
   expect(result).toMatchObject({ok:false});if(!result.ok){expect(result.cls).not.toBe('uncertain');expect(result.error).toContain('up to 720p');}
   expect(posts).toHaveLength(2);expect(await reserved(guided.genId)).toBe(0);
  });
  await runInTenant(workspace('real_xai_unkeyed'),async()=>{
   const unkeyed=await makeJob('gen_real_xai_unkeyed','xai');
   expect(await submitVideoJob(unkeyed)).toMatchObject({ok:false});expect(posts).toHaveLength(2);expect(await reserved(unkeyed.genId)).toBe(0);
  });
  await runInTenant(workspace('real_fal',{fal:'unit-test-key'}),async()=>{
   reply=()=>Response.json({detail:'Exhausted balance'},{status:402});
   const broke=await makeJob('gen_real_fal_402','fal');
   expect(await submitVideoJob(broke)).toMatchObject({ok:false,cls:'fatal'});expect(posts).toHaveLength(3);expect(await reserved(broke.genId)).toBe(0);
  });
 }finally{globalThis.fetch=originalFetch;process.env.ENGINE_MOCK='1';}
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

test('durable video dispatch restores an uploaded locked source and every reference in order', async () => {
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoRow}=await import('../../lib/submitVideo');const {db}=await import('../../lib/db');
 const engine=engineFor('byteplus'),original=engine.render;let calls=0;
 engine.render=async input=>{
  calls++;expect(input.kind).toBe('video');if(input.kind!=='video')throw new Error('Wrong kind');
  expect(input.source).toMatchObject({id:'uploaded-source',kind:'video'});
  expect(input.source?.fromGeneration).not.toBe(true);
  expect(input.references.map(r=>[r.id,r.role])).toEqual([['uploaded-source','reference_video'],['uploaded-image','reference_image']]);
  expect(input.task.id).toBe('edit');expect(input.prompt).toBe('Edit the source');
  return {handle:{provider:'byteplus',ref:'edited-source',model:'mock'}};
 };
 try{await runInTenant(workspace('uploaded_source'),async()=>{
  const job=await makeJob('gen_uploaded_source');
  await db().batch([
   "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('uploaded-source','source','video/mp4','mp4',1,'hash','source-bytes','video',0)",
   "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('uploaded-image','image','image/png','png',1,'hash','image-bytes','image',0)",
   {sql:"UPDATE generations SET model='dreamina-seedance-2-5-260628',task='edit',prompt='Edit the source',params=? WHERE id=?",args:[JSON.stringify({...job.params,sourceUploadId:'uploaded-source',references:[{uploadId:'uploaded-source',role:'reference_video',kind:'video'},{uploadId:'uploaded-image',role:'reference_image',kind:'image'}]}),job.genId]},
  ],'write');
  expect(await submitVideoRow(job.genId)).toMatchObject({ok:true,taskId:'edited-source'});
  expect(await submitVideoRow(job.genId)).toMatchObject({ok:true,taskId:'edited-source'});expect(calls).toBe(1);
 });}finally{engine.render=original;}
});

test('missing queued references release only unsent reservations; stale worker failure cannot refund a paid claim', async () => {
 const {runInTenant}=await import('../../lib/tenant');const {engineFor}=await import('../../lib/engines');const {submitVideoRow,failVideoDispatch}=await import('../../lib/submitVideo');const {db}=await import('../../lib/db');const {platformDb}=await import('../../lib/platform');
 const engine=engineFor('byteplus'),original=engine.render;let calls=0;
 engine.render=async()=>{calls++;throw new Error('Missing reference must never reach provider');};
 try{await runInTenant(workspace('missing_source'),async()=>{
  const missing=await makeJob('gen_missing_source');
  await db().execute({sql:'UPDATE generations SET params=? WHERE id=?',args:[JSON.stringify({...missing.params,references:[{uploadId:'missing',role:'reference_image',kind:'image'}]}),missing.genId]});
  expect(await submitVideoRow(missing.genId)).toMatchObject({ok:false,cls:'fatal'});
  expect((await db().execute({sql:'SELECT status,cost_usd FROM generations WHERE id=?',args:[missing.genId]})).rows[0]).toMatchObject({status:'failed',cost_usd:0});
  expect((await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[missing.genId]})).rows[0].engine_cost_usd).toBe(0);
  const claimed=await makeJob('gen_claimed_source');
  await db().execute({sql:"UPDATE generations SET params=json_set(params,'$.paidClaim',1) WHERE id=?",args:[claimed.genId]});
  await failVideoDispatch(claimed.genId,'Stale queue failure');
  expect((await db().execute({sql:'SELECT status FROM generations WHERE id=?',args:[claimed.genId]})).rows[0].status).toBe('queued');
  expect((await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[claimed.genId]})).rows[0].engine_cost_usd).toBe(.7);
  expect(calls).toBe(0);
 });}finally{engine.render=original;}
});

test('Astra releases unsent legacy quotes, retains prior claims and restores accepted requests without another purchase',async()=>{
 const {runInTenant}=await import('../../lib/tenant'),{engineFor}=await import('../../lib/engines');
 const {submitVideoJob}=await import('../../lib/submitVideo'),{db}=await import('../../lib/db'),{platformDb}=await import('../../lib/platform');
 const {ASTRA_MODEL,DEFAULT_ASTRA}=await import('../../lib/astra'),{getModel}=await import('../../lib/models'),{getTask}=await import('../../lib/tasks');
 const engine=engineFor('fal'),original=engine.render;let calls=0;
 engine.render=async input=>{calls++;expect(input.kind).toBe('video');if(input.kind==='video')expect(input.params).toMatchObject({astra:{...DEFAULT_ASTRA,fps:60},astraSource:{seconds:1.5},fps60:true,resolution:'4k'});return {handle:{provider:'fal',ref:'astra-accepted',model:ASTRA_MODEL,endpoint:ASTRA_MODEL}};};
 try {for(const kind of ['unsent','claimed','accepted','reviewed'])await runInTenant(workspace('astra-'+kind),async()=>{
  const job=await makeJob('astra-'+kind,'fal');job.model=getModel(ASTRA_MODEL);job.task=getTask('upscale');
  if(kind==='reviewed')job.params={...job.params,resolution:'4k',fps60:true,astra:{...DEFAULT_ASTRA,fps:60},astraSource:{seconds:1.5,width:720,height:1280,firstTimestamp:0}};
  await db().execute({sql:"UPDATE generations SET model=?,task='upscale',params=? WHERE id=?",args:[ASTRA_MODEL,JSON.stringify({...job.params,...(kind==='claimed'?{paidClaim:1}:{}),...(kind==='accepted'?{falRequestId:'already-paid',falModel:ASTRA_MODEL}:{})}),job.genId]});
  const result=await submitVideoJob(job);
  if(kind==='unsent'){expect(result).toMatchObject({ok:false,cls:'fatal'});expect((await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[job.genId]})).rows[0].engine_cost_usd).toBe(0);}
  if(kind==='claimed'){expect(result).toMatchObject({ok:false,cls:'uncertain'});expect((await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=?',args:[job.genId]})).rows[0].engine_cost_usd).toBe(.7);}
  if(kind==='accepted')expect(result).toMatchObject({ok:true,taskId:'already-paid'});
  if(kind==='reviewed'){expect(result).toMatchObject({ok:true,taskId:'astra-accepted'});expect(await submitVideoJob(job)).toMatchObject({ok:true,taskId:'astra-accepted'});}
 });expect(calls).toBe(1);}finally{engine.render=original;}
});
