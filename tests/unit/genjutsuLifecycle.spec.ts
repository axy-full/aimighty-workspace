import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { VideoJob } from "../../lib/submitVideo";
import type { VideoRenderRequest, RenderHandle } from "../../lib/engines/types";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";

const dir = mkdtempSync(path.join(tmpdir(), "particl-genjutsu-lifecycle-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir,"platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir,"primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
const originalFetch = globalThis.fetch;
const requestId = "137e9e94-0bea-4acd-b82a-071a264d8e26";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const cancelUrl = `https://api.higgsfield.ai/requests/${requestId}/cancel`;
const input = { prompt: "", video_url: "https://original.example/video.mp4", image_urls: ["https://original.example/a.png"], resolution: "720p" as const };
const actor = {user:{id:"owner",email:"owner@example.invalid",name:"Owner",role:"admin" as const,owner:true,disabled:false,createdAt:0,lastSeen:null}};
const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string,unknown>): T {
  const source=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const target={exports:{}};
  new Function("require","module","exports",source)((name:string)=> name in overrides ? overrides[name] : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file),name+".ts")) : nodeRequire(name),target,target.exports);
  return target.exports as T;
}
test.beforeEach(()=>{process.env.ENGINE_MOCK="1";process.env.HF_CREDENTIALS="fixture:key";globalThis.fetch=async()=>{throw new Error("External network forbidden");};});
test.afterEach(()=>{globalThis.fetch=originalFetch;});
function workspace(name:string):TenantWorkspace { return {id:name,slug:name,name,legacy:true,dbUrl:`file:${path.join(dir,name+".db")}`,dbToken:null,keys:{},usesPlatformKeys:false,allowanceUsd:null,gatewayKeyId:null,ownerId:"owner",createdAt:0,suspendedAt:null,suspendedReason:null,flaggedAt:null,flagNote:null,concurrency:20,rendersPerHour:200,storageQuotaBytes:null,deletedAt:null}; }
async function job(id:string):Promise<VideoJob> {
  const {db,ready,now}=await import("../../lib/db"),{getModel}=await import("../../lib/models"),{getTask}=await import("../../lib/tasks"),{meter}=await import("../../lib/meter"),{higgsfieldCredentialFingerprint}=await import("../../lib/higgsfield");
  await ready(); const model=getModel(GENJUTSU_MODELS["motion-transfer"]);
  const params={ratio:"adaptive",resolution:"720p",duration:5,watermark:false,higgsfieldCredentialFingerprint:higgsfieldCredentialFingerprint(),higgsfieldVendorCostUsd:0.75,genjutsuSource:{width:1280,height:720,seconds:5,firstTimestamp:0}};
  await db().execute({sql:"INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_by,created_at,updated_at) VALUES(?,'video',?,'',?,'queued','higgsfield','genjutsu','owner',?,?)",args:[id,model.id,JSON.stringify(params),now(),now()]});
  await meter({id,kind:"video",engine:"higgsfield",model:model.id,status:"running",engineCostUsd:.75});
  const source={id:"source",kind:"video" as const,mime:"video/mp4",ext:"mp4",storedUrl:"/api/uploads/source",role:"reference_video" as const};
  return {genId:id,model,task:getTask("genjutsu"),prompt:"",params,source,references:[source],ts:now()};
}
function handle(value:VideoJob):RenderHandle {return {provider:"higgsfield",model:value.model.id,ref:requestId,endpoint:statusUrl,cancelUrl,credentialFingerprint:value.params.higgsfieldCredentialFingerprint};}

test("Genjutsu quote uses only documented estimate POST and rejects unusable prices without fallback",async()=>{
  process.env.ENGINE_MOCK="0";
  const {estimateGenjutsuInput}=await import("../../lib/genjutsu");
  const requests:string[]=[];
  globalThis.fetch=async(url,init)=>{requests.push(String(url));expect(init).toMatchObject({method:"POST",redirect:"error",headers:{Authorization:"Key fixture:key"}});expect(JSON.parse(String(init?.body))).toEqual(input);return Response.json({usd:"2.043",credits:"32.68"});};
  expect(await estimateGenjutsuInput(GENJUTSU_MODELS["object-swap"],input)).toBe(2.043);
  expect(requests).toEqual(["https://api.higgsfield.ai/estimate/higgsfiled/genjutsu/object-swap/v1.0"]);
  for(const usd of [0,"0","NaN","-2",null,"1e5",2]) {globalThis.fetch=async()=>Response.json({usd});await expect(estimateGenjutsuInput(GENJUTSU_MODELS["motion-transfer"],input)).rejects.toThrow(/live transform price/);}
  globalThis.fetch=async()=>new Response("provider secret must never escape",{status:503});
  await expect(estimateGenjutsuInput(GENJUTSU_MODELS["motion-transfer"],input)).rejects.toThrow(/Nothing was submitted/);
});

test("Genjutsu sends exact original paths, preserves image order and never uses delivery derivatives",async()=>{
  const {genjutsuInput}=await import("../../lib/genjutsu");
  const source={id:"video",kind:"video" as const,mime:"video/mp4",ext:"mp4",storedUrl:"/api/media/video",role:"reference_video" as const,fromGeneration:true};
  const refs=[{id:"still",kind:"image" as const,mime:"image/png",ext:"png",storedUrl:"/api/uploads/still",deliveryUrl:"https://wrong.example/derivative",role:"reference_image" as const},{id:"generated",kind:"image" as const,mime:"image/png",ext:"png",storedUrl:"/api/media/generated",role:"reference_image" as const,fromGeneration:true}];
  const body=await genjutsuInput(GENJUTSU_MODELS["motion-transfer"],"", "480p",source,refs);
  expect(body.video_url).toMatch(/generations\/video\.mp4$/);expect(body.image_urls[0]).toMatch(/uploads\/still\.png$/);expect(body.image_urls[1]).toMatch(/generations\/generated\.png$/);
  await expect(genjutsuInput(GENJUTSU_MODELS["motion-transfer"],"", "1080p",source,refs)).rejects.toThrow();
});

test("failed non-generating estimates never create uncertain external mutations",async()=>{
  process.env.ENGINE_MOCK="0";
  const recovery=await import("../../lib/recovery");
  const fence=recovery.recoveryFence();
  const before=await fence.status();
  globalThis.fetch=async()=>{throw new Error("Read timeout");};
  const {estimateGenjutsuInput}=await import("../../lib/genjutsu");
  await expect(estimateGenjutsuInput(GENJUTSU_MODELS["motion-transfer"],input)).rejects.toThrow(/Nothing was submitted/);
  const after=await fence.status();
  expect(after.activities).toEqual(before.activities);
});

test("fresh estimate and credential checks precede the sole paid POST; status and cancel URLs are exact",async()=>{
  const {runInTenant}=await import("../../lib/tenant");
  await runInTenant({...workspace("genjutsu_transport"),usesPlatformKeys:true},async()=>{
    const value=await job("gen_transport"); process.env.ENGINE_MOCK="0";
    const contract=await import("../../lib/genjutsu"),{higgsfieldCredentialFingerprint}=await import("../../lib/higgsfield");
    const {higgsfield}=load<typeof import("../../lib/engines/higgsfield")>("lib/engines/higgsfield.ts",{"../genjutsu":{...contract,genjutsuInput:async()=>input}});
    const req:VideoRenderRequest={kind:"video",...value,params:{...value.params,higgsfieldCredentialFingerprint:higgsfieldCredentialFingerprint()}};
    const calls:string[]=[];let price="0.75";
    globalThis.fetch=async(url)=>{calls.push(String(url));return String(url).includes("/estimate/")?Response.json({usd:price}):Response.json({request_id:requestId,status_url:statusUrl,cancel_url:cancelUrl});};
    const out=await higgsfield.render(req);expect(calls).toHaveLength(2);expect(calls[1]).toBe("https://api.higgsfield.ai/higgsfiled/genjutsu/motion-transfer/v1.0");
    expect(out).toEqual({handle:{...handle(value),credentialFingerprint:req.params.higgsfieldCredentialFingerprint}});
    price="0.76";calls.length=0;await expect(higgsfield.render(req)).rejects.toThrow(/Nothing was submitted/);expect(calls).toHaveLength(1);
    process.env.HF_CREDENTIALS="rotated:secret";calls.length=0;await expect(higgsfield.render(req)).rejects.toThrow(/Nothing was submitted/);expect(calls).toHaveLength(0);process.env.HF_CREDENTIALS="fixture:key";
    const accepted="handle" in out?out.handle:handle(value);
    for(const status of ["failed","nsfw","canceled","in_progress","queued"]){globalThis.fetch=async()=>Response.json({request_id:requestId,status});expect((await higgsfield.poll!(accepted)).status).toBe(({failed:"failed",nsfw:"failed",canceled:"cancelled",in_progress:"running",queued:"queued"} as Record<string,string>)[status]);}
    globalThis.fetch=async()=>Response.json({request_id:requestId,status:"completed",video:{url:"https://cdn.example/original.mp4"}});expect((await higgsfield.poll!(accepted)).videoUrl).toBe("https://cdn.example/original.mp4");
    globalThis.fetch=async()=>Response.json({request_id:requestId,status:"completed",thumbnail:{url:"https://cdn.example/preview.mp4"}});await expect(higgsfield.poll!(accepted)).rejects.toThrow(/recognized original/);
    globalThis.fetch=async()=>{throw new Error("must not receive credentials");};await expect(higgsfield.poll!({...accepted,endpoint:"https://evil.example/status"})).rejects.toThrow(/unexpected status/);
    await expect(higgsfield.cancel!({...accepted,cancelUrl:"https://evil.example/cancel"})).rejects.toThrow(/verified cancellation URL/);
    globalThis.fetch=async(url,init)=>{expect(String(url)).toBe(cancelUrl);expect(init?.method).toBe("POST");expect(new Headers(init?.headers).get("authorization")).toBe("Key fixture:key");return new Response(null,{status:202});};
    await higgsfield.cancel!(accepted);
  },actor);
});

test("accepted receipt recovers tenant handle outage, collects original bytes once and never resubmits",async()=>{
  const {runInTenant}=await import("../../lib/tenant"),{engineFor}=await import("../../lib/engines"),{submitVideoJob,submitVideoRow}=await import("../../lib/submitVideo"),{db}=await import("../../lib/db"),{platformDb}=await import("../../lib/platform"),{reconcileGenjutsuVideo}=await import("../../lib/genjutsuVideo"),{getGeneration}=await import("../../lib/jobs"),{readVideoBytes}=await import("../../lib/storage");
  const engine=engineFor("higgsfield"),render=engine.render,poll=engine.poll;let submissions=0,polls=0;
  engine.render=async req=>{submissions++;return {handle:{provider:"higgsfield",model:req.kind==="video"?req.model.id:"",ref:requestId,endpoint:statusUrl,credentialFingerprint:req.kind==="video"?req.params.higgsfieldCredentialFingerprint:undefined}};};
  engine.poll=async()=>{polls++;return {status:"succeeded",videoUrl:"fixture:clip.mp4",totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}};};
  const id="gen_genjutsu_recovered";
  try{await runInTenant(workspace("genjutsu_recovery"),async()=>{
    const value=await job(id),client=db(),execute=client.execute.bind(client);
    client.execute=async(...args:Parameters<typeof client.execute>)=>{const statement=args[0] as unknown as string|{sql:string};const sql=typeof statement==="string"?statement:statement.sql;if(sql.includes("'$.producedOutcome'"))throw new Error("Tenant write unavailable");return execute(...args);};
    try{expect((await submitVideoJob(value)).ok).toBe(false);}finally{client.execute=execute;}
    expect((await platformDb().execute({sql:"SELECT id FROM higgsfield_generation_receipts WHERE id=?",args:[id]})).rows).toHaveLength(1);
    expect((await submitVideoRow(id)).ok).toBe(true);expect(submissions).toBe(1);
    await reconcileGenjutsuVideo(id);await reconcileGenjutsuVideo(id);
    expect(polls).toBe(1);expect(submissions).toBe(1);
    const gen=(await getGeneration(id))!;expect(gen.status).toBe("succeeded");expect(gen.storedUrl).toBe(`/api/media/${id}`);expect(gen.costUsd).toBe(.75);
    expect(gen.params).not.toHaveProperty("higgsfieldVideoHandle");expect(JSON.stringify(gen)).not.toContain("credentialFingerprint");
    expect(await readVideoBytes(id)).toEqual(readFileSync("public/fixtures/clip.mp4"));
    const receipt=(await platformDb().execute({sql:"SELECT settled_at FROM higgsfield_generation_receipts WHERE id=?",args:[id]})).rows[0];expect(Number(receipt.settled_at)).toBeGreaterThan(0);
  },actor);}finally{engine.render=render;engine.poll=poll;await unlink(path.resolve(".data/generations",id+".mp4")).catch(()=>{});}
});

test("ambiguous paid transport never resubmits or refunds while definitive rejection releases its reservation",async()=>{
  const {runInTenant}=await import("../../lib/tenant"),{engineFor}=await import("../../lib/engines"),{submitVideoJob}=await import("../../lib/submitVideo"),{HiggsfieldHttpError}=await import("../../lib/higgsfield"),{platformDb}=await import("../../lib/platform");
  const engine=engineFor("higgsfield"),render=engine.render;
  try {for(const uncertain of [true,false]){let calls=0;engine.render=async()=>{calls++;throw uncertain?new Error("lost acknowledgement"):new HiggsfieldHttpError(422,"Nothing submitted");};await runInTenant(workspace(`genjutsu_reject_${uncertain}`),async()=>{const value=await job(`gen_reject_${uncertain}`);expect((await submitVideoJob(value)).ok).toBe(false);expect((await submitVideoJob(value)).ok).toBe(false);expect(calls).toBe(1);expect((await platformDb().execute({sql:"SELECT engine_cost_usd FROM meter_events WHERE id=?",args:[value.genId]})).rows[0].engine_cost_usd).toBe(uncertain?.75:0);},actor);}}
  finally{engine.render=render;}
});

test("collection crash after storage recovers from immutable receipt without another poll or original overwrite",async()=>{
  const {runInTenant}=await import("../../lib/tenant"),{db}=await import("../../lib/db"),{engineFor}=await import("../../lib/engines"),{submitVideoJob}=await import("../../lib/submitVideo"),{reconcileGenjutsuVideo}=await import("../../lib/genjutsuVideo"),{getGeneration}=await import("../../lib/jobs");
  const engine=engineFor("higgsfield"),render=engine.render,poll=engine.poll;const id="gen_genjutsu_lost_final_ack";let polls=0;
  engine.render=async req=>({handle:{provider:"higgsfield",model:req.kind==="video"?req.model.id:"",ref:requestId,endpoint:statusUrl,credentialFingerprint:req.kind==="video"?req.params.higgsfieldCredentialFingerprint:undefined}});
  engine.poll=async()=>{polls++;return {status:"succeeded",videoUrl:"fixture:clip.mp4",totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}};};
  try{await runInTenant(workspace("genjutsu_storage_recovery"),async()=>{const value=await job(id);await submitVideoJob(value);const client=db(),batch=client.batch.bind(client);client.batch=async(...args:Parameters<typeof client.batch>)=>{if(JSON.stringify(args).includes("status='succeeded',stored_url"))throw new Error("DB unavailable after private store");return batch(...args);};try{await expect(reconcileGenjutsuVideo(id)).rejects.toThrow(/retained/);}finally{client.batch=batch;}const reserved=(await db().execute({sql:"SELECT bytes,params FROM generations WHERE id=?",args:[id]})).rows[0];expect(Number(reserved.bytes)).toBeGreaterThan(0);expect(JSON.parse(String(reserved.params)).genjutsuOriginal.sha256).toMatch(/^[a-f0-9]{64}$/);await reconcileGenjutsuVideo(id);expect(polls).toBe(1);expect((await getGeneration(id))?.status).toBe("succeeded");await db().execute({sql:"UPDATE generations SET deleted=1,stored_url=NULL WHERE id=?",args:[id]});await reconcileGenjutsuVideo(id);expect((await db().execute({sql:"SELECT deleted,stored_url FROM generations WHERE id=?",args:[id]})).rows[0]).toMatchObject({deleted:1,stored_url:null});},actor);}finally{engine.render=render;engine.poll=poll;await unlink(path.resolve(".data/generations",id+".mp4")).catch(()=>{});}
});

test("queued cancellation requests do not prematurely refund; running and other-creator requests cannot cancel",async()=>{
  const {runInTenant}=await import("../../lib/tenant"),{engineFor}=await import("../../lib/engines"),{submitVideoJob}=await import("../../lib/submitVideo"),{cancelGenjutsuVideo}=await import("../../lib/genjutsuVideo"),{getGeneration}=await import("../../lib/jobs"),{platformDb}=await import("../../lib/platform");
  const engine=engineFor("higgsfield"),render=engine.render,poll=engine.poll,cancel=engine.cancel;let canceled=0,status:"queued"|"running"="queued";
  engine.render=async req=>({handle:{provider:"higgsfield",model:req.kind==="video"?req.model.id:"",ref:requestId,endpoint:statusUrl,cancelUrl,credentialFingerprint:req.kind==="video"?req.params.higgsfieldCredentialFingerprint:undefined}});
  engine.poll=async()=>({status,videoUrl:null,totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}});engine.cancel=async()=>{canceled++;};
  const ws=workspace("genjutsu_cancel");try{await runInTenant(ws,async()=>{const value=await job("gen_cancel");await submitVideoJob(value);expect(await cancelGenjutsuVideo(value.genId)).toEqual({status:"requested"});expect((await getGeneration(value.genId))?.status).toBe("running");expect((await platformDb().execute({sql:"SELECT engine_cost_usd FROM meter_events WHERE id=?",args:[value.genId]})).rows[0].engine_cost_usd).toBe(.75);status="running";expect(await cancelGenjutsuVideo(value.genId)).toEqual({status:"running"});expect(canceled).toBe(1);},actor);await runInTenant(ws,async()=>{await expect(cancelGenjutsuVideo("gen_cancel")).rejects.toThrow(/creator or a workspace administrator/);},{user:{...actor.user,id:"other",role:"member",owner:false}});}finally{engine.render=render;engine.poll=poll;engine.cancel=cancel;}
});

test("collection respects atomic storage quota and an active collector lease, then recovers without another submission",async()=>{
  const {runInTenant}=await import("../../lib/tenant"),{engineFor}=await import("../../lib/engines"),{submitVideoJob}=await import("../../lib/submitVideo"),{reconcileGenjutsuVideo}=await import("../../lib/genjutsuVideo"),{getGeneration}=await import("../../lib/jobs"),{db}=await import("../../lib/db");
  const engine=engineFor("higgsfield"),render=engine.render,poll=engine.poll;let submissions=0,polls=0;
  engine.render=async req=>{submissions++;return {handle:{provider:"higgsfield",model:req.kind==="video"?req.model.id:"",ref:requestId,endpoint:statusUrl,credentialFingerprint:req.kind==="video"?req.params.higgsfieldCredentialFingerprint:undefined}};};
  engine.poll=async()=>{polls++;return {status:"succeeded",videoUrl:"fixture:clip.mp4",totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}};};
  const ws={...workspace("genjutsu_quota"),storageQuotaBytes:1},id="gen_genjutsu_quota";
  try{await runInTenant(ws,async()=>{
    const value=await job(id);await submitVideoJob(value);
    await expect(reconcileGenjutsuVideo(id)).rejects.toThrow(/storage is full/);
    expect((await getGeneration(id))?.status).toBe("running");
    expect(Number((await db().execute({sql:"SELECT bytes FROM generations WHERE id=?",args:[id]})).rows[0].bytes||0)).toBe(0);
    const before=polls;await db().execute({sql:"UPDATE generations SET params=json_set(params,'$.higgsfieldVideoPollUntil',?) WHERE id=?",args:[Date.now()+180_000,id]});
    await reconcileGenjutsuVideo(id);expect(polls).toBe(before);
    ws.storageQuotaBytes=100_000_000;
    await db().execute({sql:"UPDATE generations SET params=json_remove(params,'$.higgsfieldVideoPollUntil') WHERE id=?",args:[id]});
    await reconcileGenjutsuVideo(id);expect((await getGeneration(id))?.status).toBe("succeeded");expect(submissions).toBe(1);
  },actor);}finally{engine.render=render;engine.poll=poll;await unlink(path.resolve(".data/generations",id+".mp4")).catch(()=>{});}
});

test("only a confirmed terminal provider cancellation releases the accepted Genjutsu reservation",async()=>{
  const {runInTenant}=await import("../../lib/tenant"),{engineFor}=await import("../../lib/engines"),{submitVideoJob}=await import("../../lib/submitVideo"),{reconcileGenjutsuVideo}=await import("../../lib/genjutsuVideo"),{getGeneration}=await import("../../lib/jobs"),{platformDb}=await import("../../lib/platform");
  const engine=engineFor("higgsfield"),render=engine.render,poll=engine.poll;let submits=0;
  engine.render=async req=>{submits++;return {handle:{provider:"higgsfield",model:req.kind==="video"?req.model.id:"",ref:requestId,endpoint:statusUrl,credentialFingerprint:req.kind==="video"?req.params.higgsfieldCredentialFingerprint:undefined}};};
  engine.poll=async()=>({status:"cancelled",videoUrl:null,totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}});
  try{await runInTenant(workspace("genjutsu_terminal_cancel"),async()=>{
    const value=await job("gen_terminal_cancel");await submitVideoJob(value);
    await reconcileGenjutsuVideo(value.genId);await reconcileGenjutsuVideo(value.genId);
    expect((await getGeneration(value.genId))?.status).toBe("cancelled");
    expect((await platformDb().execute({sql:"SELECT engine_cost_usd FROM meter_events WHERE id=?",args:[value.genId]})).rows[0].engine_cost_usd).toBe(0);
    expect(submits).toBe(1);
  },actor);}finally{engine.render=render;engine.poll=poll;}
});
