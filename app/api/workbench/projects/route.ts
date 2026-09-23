import { gzipSync } from 'node:zlib';
import {readProjectBody} from '@/lib/workbench/request-body';
import { withTenant, requireSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { saveSchema } from '@/lib/workbench/studio-schema';
import { newProject, type Project } from '@/lib/workbench/studio';
import { workbenchReady, readDraft, mapNodeShot, saveDraft, publishBible } from '@/lib/workbench/records';
import {requireTenant} from '@/lib/tenant';
import {workbenchScopeProblem} from '@/lib/workbench/request-scope';

export const dynamic='force-dynamic';
const noStore={'Cache-Control':'no-store'};
function originProblem(req:Request) {
  const origin=req.headers.get('origin');
  return origin && origin!==new URL(req.url).origin;
}

export const GET=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  const scopeError=workbenchScopeProblem(req,requireTenant().id,auth.user.id);
  if(scopeError)return Response.json({error:scopeError},{status:409,headers:noStore});
  await workbenchReady();
  const id=new URL(req.url).searchParams.get('id');
  const [list,productions,draft]=await Promise.all([
    db().execute({sql:'SELECT project_id AS id,name,revision,updated_at AS updatedAt FROM workbench_projects WHERE owner=? ORDER BY updated_at DESC LIMIT 100',args:[auth.user.id]}),
    db().execute('SELECT id,name FROM projects ORDER BY created_at DESC LIMIT 100'),
    id?readDraft(auth.user.id,id):null,
  ]);
  let shared=null;
  if(draft?.project.productionProjectId){
    const row=(await db().execute({sql:'SELECT body,version,owner FROM workbench_bibles WHERE project_id=? ORDER BY version DESC LIMIT 1',args:[draft.project.productionProjectId]})).rows[0];
    if(row)shared={...JSON.parse(String(row.body)),version:Number(row.version)};
  }
  return projectResponse(req,{projects:list.rows,productions:productions.rows,project:draft?.project||null,revision:draft?.revision||0,shared});
});

/** A feature film's project (and its shared copy) can pass Vercel's 4.5 MB response limit, so a large answer leaves gzipped; browsers unpack it. */
function projectResponse(req:Request,value:unknown){
  const json=JSON.stringify(value);
  if(json.length<1_000_000||!/\bgzip\b/.test(req.headers.get('accept-encoding')||''))return new Response(json,{headers:{...noStore,'Content-Type':'application/json'}});
  return new Response(new Uint8Array(gzipSync(json)),{headers:{...noStore,'Content-Type':'application/json','Content-Encoding':'gzip',Vary:'Accept-Encoding'}});
}

export const PUT=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  const scopeError=workbenchScopeProblem(req,requireTenant().id,auth.user.id,true);
  if(scopeError)return Response.json({error:scopeError},{status:409,headers:noStore});
  if(originProblem(req))return Response.json({error:'Invalid request origin'},{status:403});
  const body=await readProjectBody(req);if(!body.ok)return Response.json({error:body.error},{status:body.status});
  const value=body.value;
  const parsed=saveSchema.safeParse(value);
  if(!parsed.success)return Response.json({error:'Check the project fields before saving.'},{status:400});
  await workbenchReady();
  const {project:p,revision}=parsed.data;
  try{return Response.json(await saveDraft(auth.user.id,p,revision));}
  catch(error){return Response.json({error:error instanceof Error?error.message:'Cannot save project.'},{status:409});}
});

export const POST=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  const scopeError=workbenchScopeProblem(req,requireTenant().id,auth.user.id,true);
  if(scopeError)return Response.json({error:scopeError},{status:409,headers:noStore});
  if(originProblem(req))return Response.json({error:'Invalid request origin'},{status:403});
  const body=await req.json().catch(()=>null);
  if(!body || typeof body.projectId!=='string')return Response.json({error:'Choose a project.'},{status:400});
  await workbenchReady();
  if(body.action==='open'){
    const row=(await db().execute({sql:'SELECT id,name,description FROM projects WHERE id=?',args:[body.projectId]})).rows[0];
    if(!row)return Response.json({error:'Project not found'},{status:404});
    const latest=(await db().execute({sql:'SELECT body,version FROM workbench_bibles WHERE project_id=? ORDER BY version DESC LIMIT 1',args:[body.projectId]})).rows[0];
    const shared=latest?JSON.parse(String(latest.body)):null;
    const p:Project={...newProject(String(row.name)),description:String(row.description||''),productionProjectId:String(row.id),...(shared?{brief:shared.brief,script:shared.script,scriptFormat:shared.scriptFormat==='adfilm'?'adfilm':'screenplay',scriptSource:shared.scriptSource,scriptReviews:shared.scriptReviews,direction:shared.direction,assets:shared.assets,nodes:shared.nodes,sharedAssets:shared.assets,sharedNodes:shared.nodes,sharedAssetIds:shared.assets.map((a:{id:string})=>a.id),sharedNodeIds:shared.nodes.map((n:{id:string})=>n.id),bibleVersion:Number(latest!.version)}:{})};
    return projectResponse(req,{project:p,revision:0});
  }
  const draft=await readDraft(auth.user.id,body.projectId);
  if(!draft)return Response.json({error:'Save your project first.'},{status:404});
  if(body.action==='map-shot'){
    try{return Response.json({productionProjectId:draft.project.productionProjectId,shotId:await mapNodeShot(auth.user.id,draft.project,String(body.nodeId||''))})}
    catch(e){return Response.json({error:e instanceof Error?e.message:'Cannot map this node'},{status:400})}
  }
  if(body.action==='publish'){
    if(!Number.isInteger(body.expectedBibleVersion)||body.expectedBibleVersion<0)return Response.json({error:'Load the current shared context before publishing.'},{status:400});
    try{return projectResponse(req,await publishBible(auth.user.id,auth.user.name,body.projectId,body.expectedBibleVersion));}
    catch(error){
      const problem=error as Error&{code?:string;currentVersion?:number};
      return Response.json({error:problem.message||'Unable to publish shared context.',...(problem.code==='bible_conflict'?{code:problem.code,currentVersion:problem.currentVersion}:{})},{status:problem.code==='bible_conflict'?409:400});
    }
  }
  return Response.json({error:'Unknown project action'},{status:400});
});
