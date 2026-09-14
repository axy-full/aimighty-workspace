import { withRecoveryJob } from './recovery';
import { db, ready, now } from "./db";
import { type VideoParams, type Reference, type ImageRole } from "./ark";
import { falEndpointFor } from "./falVideo";
import { classifyFailure, billedTo } from "./providers";
import { getModel, type ModelDef } from "./models";
import { getTask, type TaskDef } from "./tasks";
import { meter, assertMeterFunding, FundingSourceChangedError } from "./meter";
import { engineFor } from "./engines";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";

/**
 * The one call that can fail for reasons that aren't ours, in one place:
 * the Generate route sends a fresh take through it, and a held take is
 * released through it later from nothing but its own row.
 */
export type SubmitOutcome =
  | { ok: true; taskId: string; attempts: number }
  | { ok: false; error: string; cls: string };

export type VideoJob = {
  genId: string;
  model: ModelDef;
  task: TaskDef;
  prompt: string;
  params: VideoParams;
  references: Reference[];
  source: Reference | null;
  /** When the row was made; the queue time is measured from it. */
  ts: number;
};

type SubmittedVideo = { kind: "video"; taskId: string; endpoint?: string; queueMs: number; submitMs: number };
type SubmissionRow = { status: string; error: string | null; ark_task_id: string | null; attempts: number; params: string };

async function submissionRow(genId: string): Promise<SubmissionRow | undefined> {
  return (await db().execute({sql:`SELECT status,error,ark_task_id,attempts,params FROM generations WHERE id=? AND kind='video' AND deleted=0`,args:[genId]})).rows[0] as unknown as SubmissionRow | undefined;
}
function knownTask(row: SubmissionRow): string | null {
  const p=JSON.parse(row.params||"{}");
  const id=row.ark_task_id||p.falRequestId;
  return typeof id==='string'&&id.length>0?id:null;
}

/** Only database writes may retry. A transport failure cannot prove that a
 * paid POST did not arrive, even when the client calls it "could not reach". */
async function writeSubmission(fn:()=>Promise<unknown>):Promise<void> {
  for(let attempt=0;;attempt++){
    try{await fn();return;}catch(error){if(attempt>=2)throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
  }
}
async function rememberSubmission(job:VideoJob,out:SubmittedVideo):Promise<void> {
  await writeSubmission(async()=>{
    const result=await db().execute({
      sql: job.model.provider==='fal'
        ? `UPDATE generations SET status=CASE WHEN status IN ('succeeded','cancelled') THEN status ELSE 'running' END,
          attempts=1,queue_ms=?,submit_ms=?,error=NULL,
          params=json_set(params,'$.falRequestId',?,'$.falModel',?,'$.producedOutcome',json(?)),updated_at=? WHERE id=? AND deleted=0`
        : `UPDATE generations SET ark_task_id=?,status=CASE WHEN status IN ('succeeded','cancelled') THEN status ELSE 'running' END,
          attempts=1,queue_ms=?,submit_ms=?,error=NULL,
          params=json_set(params,'$.producedOutcome',json(?)),updated_at=? WHERE id=? AND deleted=0`,
      args:job.model.provider==='fal'
        ? [out.queueMs,out.submitMs,out.taskId,out.endpoint!,JSON.stringify(out),now(),job.genId]
        : [out.taskId,out.queueMs,out.submitMs,JSON.stringify(out),now(),job.genId],
    });
    if(!result.rowsAffected)throw new Error('The submitted take is no longer available.');
  });
}

/** These exact adapter errors represent a received rejection, not transport
 * ambiguity. Unrecognized errors retain the estimate conservatively. */
function definitelyRejected(message:string):boolean {
  const status=message.match(/^Ark submit failed \((\d+)\)/)?.[1]??message.match(/^fal\.ai returned (\d+)\b/)?.[1];
  return Boolean(status&&[400,401,402,403,404,405,413,415,422,429].includes(Number(status)))
    || /^fal\.ai (rejected the key|account is out of credit|refused the request|rate limit —)/.test(message)
    || /^That engine isn't connected for this workspace\./.test(message)
    || /^Request body is [\d.]+ MB, over ModelArk's 64 MB limit\./.test(message);
}
async function submissionFailed(job:VideoJob,error:string,uncertain:boolean):Promise<SubmitOutcome> {
  let retainedCost:number|null=uncertain?null:0;
  if(uncertain){
    try{
      await platformReady();
      const reserved=(await platformDb().execute({sql:'SELECT engine_cost_usd FROM meter_events WHERE id=? AND workspace_id=?',args:[job.genId,requireTenant().id]})).rows[0]?.engine_cost_usd;
      if(reserved!=null)retainedCost=Number(reserved);
    }catch{/* The existing meter reservation remains authoritative. */}
  }
  await writeSubmission(()=>db().execute({sql:`UPDATE generations SET status='failed',error=?,attempts=1,cost_usd=COALESCE(cost_usd,?),updated_at=? WHERE id=? AND deleted=0 AND ark_task_id IS NULL AND json_extract(params,'$.falRequestId') IS NULL`,args:[error,retainedCost,now(),job.genId]})).catch(()=>{});
  await meter({id:job.genId,kind:'video',engine:billedTo(job.model.provider??'byteplus'),model:job.model.id,status:'failed',engineCostUsd:uncertain?null:0},{critical:false}).catch(()=>{});
  return {ok:false,error,cls:uncertain?'uncertain':classifyFailure(new Error(error))};
}

/** One durable owner per generation, including delayed held-job releases.
 * Claims never expire: uncertainty must not purchase another provider task. */
export async function submitVideoJob(job: VideoJob): Promise<SubmitOutcome> {
return await withRecoveryJob(requireTenant().id, job.genId, async () => {

  await ready();
  let row=await submissionRow(job.genId);
  if(!row)return {ok:false,error:'No such take.',cls:'fatal'};
  const existing=knownTask(row);
  if(existing)return {ok:true,taskId:existing,attempts:Number(row.attempts)||1};
  const prior=JSON.parse(row.params||'{}').producedOutcome as SubmittedVideo|undefined;
  if(prior?.kind==='video'&&typeof prior.taskId==='string'&&prior.taskId){
    try{await rememberSubmission(job,prior);return {ok:true,taskId:prior.taskId,attempts:1};}
    catch{return {ok:false,cls:'uncertain',error:`The provider accepted task ${prior.taskId}, but tracking could not be restored. No additional request was sent; its estimated cost remains reserved.`};}
  }
  if(!['queued','running'].includes(row.status))return {ok:false,error:row.error||'This take is no longer awaiting submission.',cls:'fatal'};
  const claimed=await db().execute({sql:`UPDATE generations SET params=json_set(params,'$.paidClaim',?),attempts=1,updated_at=?
    WHERE id=? AND kind='video' AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.paidClaim') IS NULL
      AND ark_task_id IS NULL AND json_extract(params,'$.falRequestId') IS NULL`,args:[now(),now(),job.genId]});
  if(!claimed.rowsAffected){
    row=await submissionRow(job.genId);
    const taskId=row&&knownTask(row);
    return taskId?{ok:true,taskId,attempts:Number(row!.attempts)||1}:{ok:false,cls:'uncertain',error:row?.error||'Submission already started. No additional request was sent. Wait for confirmation; the estimated cost remains reserved.'};
  }

  const started=now();
  let submitted:SubmittedVideo;
  try{
    await assertMeterFunding(job.genId,billedTo(job.model.provider??'byteplus'));
    // Never wrap this paid call in withRetry, including transport and 5xx failures.
    const out=await engineFor(job.model.provider).render({kind:'video',genId:job.genId,model:job.model,task:job.task,prompt:job.prompt,params:job.params,references:job.references,source:job.source});
    if(!('handle' in out)||typeof out.handle.ref!=='string'||!out.handle.ref)throw new Error('The engine returned no usable task handle.');
    submitted={kind:'video',taskId:out.handle.ref,queueMs:started-job.ts,submitMs:now()-started,
      ...(job.model.provider==='fal'?{endpoint:out.handle.endpoint||falEndpointFor(job.model,job.task.id,job.references.some(r=>r.kind==='image'))}:{})};
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).replace(/; it will be retried\./,'; no additional request was sent.');
    const uncertain=!(error instanceof FundingSourceChangedError)&&!definitelyRejected(message);
    return submissionFailed(job,uncertain?`${message} The provider may already have accepted this task. It was not sent again; its estimated cost remains reserved until the provider outcome is reconciled.`:message,uncertain);
  }
  try{
    await rememberSubmission(job,submitted);
    return {ok:true,taskId:submitted.taskId,attempts:1};
  }catch{
    // A database timeout may be a lost acknowledgment of a committed write.
    // Recover the known handle; never go through engine.render a second time.
    const recovered=await submissionRow(job.genId).catch(()=>undefined);
    if(recovered&&knownTask(recovered)===submitted.taskId)return {ok:true,taskId:submitted.taskId,attempts:1};
    return submissionFailed(job,`The provider accepted task ${submitted.taskId}, but its tracking could not be saved. No additional request was sent; its estimated cost remains reserved. Keep this task ID for support to recover the result.`,true);
  }

});
}

type StoredRef = { uploadId?: string; genId?: string; role: string; kind: string };

/**
 * Reference ids on the row become the objects the vendor adapter wants —
 * uploads and our own renders, either kind, in the order the person set.
 */
async function hydrateRefs(refs: StoredRef[]): Promise<Reference[]> {
  const uploadIds = refs.map((r) => r.uploadId).filter(Boolean) as string[];
  const genIds = refs.map((r) => r.genId).filter(Boolean) as string[];
  type Up = { id: string; mime: string; ext: string; stored_url: string; kind: string; derivative_url: string | null };
  type Own = { id: string; kind: string; stored_url: string };
  const byUpload = new Map<string, Up>();
  if (uploadIds.length) {
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url, kind, derivative_url FROM uploads WHERE id IN (${uploadIds.map(() => "?").join(",")})`,
      args: uploadIds,
    });
    for (const r of rs.rows as unknown as Up[]) byUpload.set(r.id, r);
  }
  const own = new Map<string, Own>();
  if (genIds.length) {
    const rs = await db().execute({
      sql: `SELECT id, kind, stored_url FROM generations
            WHERE id IN (${genIds.map(() => "?").join(",")}) AND deleted = 0 AND status = 'succeeded' AND stored_url IS NOT NULL`,
      args: genIds,
    });
    for (const r of rs.rows as unknown as Own[]) own.set(r.id, r);
  }
  const out: Reference[] = [];
  for (const r of refs) {
    if (r.genId) {
      const g = own.get(r.genId);
      if (!g) continue; // deleted since: dropped rather than fatal, the prompt still describes the shot
      const video = g.kind === "video";
      out.push({
        id: g.id, mime: video ? "video/mp4" : "image/png", ext: video ? "mp4" : "png", storedUrl: g.stored_url,
        role: (r.role as ImageRole) ?? (video ? "reference_video" : "reference_image"), kind: video ? "video" : "image",
        fromGeneration: true,
      });
      continue;
    }
    const u = r.uploadId ? byUpload.get(r.uploadId) : undefined;
    if (!u) continue;
    const video = u.kind === "video";
    out.push({
      id: u.id, mime: u.mime, ext: u.ext, storedUrl: u.stored_url,
      role: (r.role as ImageRole) ?? (video ? "reference_video" : "reference_image"), kind: video ? "video" : "image",
      deliveryUrl: u.derivative_url ?? null,
    });
  }
  return out;
}

/** Send a take that already exists as a row — a held one, released. */
export async function submitVideoRow(genId: string): Promise<SubmitOutcome> {
return await withRecoveryJob(requireTenant().id, genId, async () => {

  const rs = await db().execute({
    sql: `SELECT id, model, prompt, params, task, source_gen_id, created_at FROM generations WHERE id = ? AND deleted = 0`,
    args: [genId],
  });
  const row = rs.rows[0] as unknown as
    { id: string; model: string; prompt: string; params: string; task: string | null; source_gen_id: string | null; created_at: number } | undefined;
  if (!row) return { ok: false, error: "No such take.", cls: "fatal" };
  const model = getModel(String(row.model));
  const task = getTask(String(row.task ?? "generate"));
  const params = JSON.parse(String(row.params ?? "{}")) as VideoParams & { references?: StoredRef[] };
  const references = await hydrateRefs(params.references ?? []);
  const source = row.source_gen_id
    ? references.find((r) => r.fromGeneration && r.id === row.source_gen_id) ?? null
    : null;
  return submitVideoJob({ genId, model, task, prompt: String(row.prompt), params, references, source, ts: Number(row.created_at) });

});
}
