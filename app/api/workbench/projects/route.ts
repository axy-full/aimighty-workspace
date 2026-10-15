import { isDraftProject, isMarkedSample, isSampleDraft, isSampleProject, mayReachProject, ownsDraftProject, projectLister } from '@/lib/draftProject';
import { crossOriginProblem } from '@/lib/requestOrigin';
import { gzipSync } from 'node:zlib';
import {readProjectBody} from '@/lib/workbench/request-body';
import { withTenant, requireSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { draftWriteTagSchema, saveSchema } from '@/lib/workbench/studio-schema';
import { saveProblem } from '@/lib/workbench/save-problem';
import { newProject, type Project } from '@/lib/workbench/studio';
import { workbenchReady, readDraft, mapNodeShot, saveDraft, publishBible, checkDraftWrite, DraftConflictError } from '@/lib/workbench/records';
import {requireTenant} from '@/lib/tenant';
import {workbenchScopeProblem} from '@/lib/workbench/request-scope';
import {openStarterDraft, StarterUnavailableError} from '@/lib/workbench/starter-draft';
import { storedActorMaskHere } from '@/lib/platformOwnerPrivacy';
import { sampleViewOnly, sharedBoardOfProduction, sharedBoardOwnerOf, findTeamBoard, listTeamBoards, otherOwnersBoard, readTeamBoard, viewOnlyRefusal } from '@/lib/workbench/team-boards';

export const dynamic='force-dynamic';
const noStore={'Cache-Control':'no-store'};
function originProblem(req:Request) {
  return crossOriginProblem(req);
}

export const GET=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  const scopeError=workbenchScopeProblem(req,requireTenant().id,auth.user.id);
  if(scopeError)return Response.json({error:scopeError},{status:409,headers:noStore});
  await workbenchReady();
  const id=new URL(req.url).searchParams.get('id');
  /* ?production=<id>: this person's newest Studio project for that production,
     so a screen scoped to a production (the shot builder) opens Generate on the
     project that files and bills there, not on whichever one Generate last had. */
  const production=new URL(req.url).searchParams.get('production');
  if(production){
    const row=(await db().execute({sql:"SELECT project_id AS id FROM workbench_projects WHERE owner=? AND (CASE WHEN json_valid(body) THEN json_extract(body,'$.productionProjectId') END)=? ORDER BY updated_at DESC LIMIT 1",args:[auth.user.id,production]})).rows[0];
    return Response.json({id:row?String(row.id):null},{headers:noStore});
  }
  /* `?kinds=1` (the new Home's boards): each board's kind, read the way lib/board/kind.ts boardKindOf reads it (an older
     Ads draft carries a marketing brief; an empty one is not one). Only when asked: it parses each listed draft. */
  const kinds=new URL(req.url).searchParams.get('kinds')==='1';
  const KIND="CASE WHEN json_valid(body) THEN COALESCE(NULLIF(json_extract(body,'$.boardKind'),''),CASE WHEN NULLIF(json_extract(body,'$.marketingBrief'),'') IS NOT NULL OR NULLIF(json_extract(body,'$.moleculr'),'') IS NOT NULL THEN 'ads' END) END AS kind";
  /* ?id=&owner=: a teammate's board, to look at (view-only: nothing here writes to it). ?team=1: every member's boards, the caller's marked. */
  const ownerParam=new URL(req.url).searchParams.get('owner');
  if(id&&ownerParam&&ownerParam!==auth.user.id){
    const seen=await readTeamBoard(requireTenant(),auth.user.id,ownerParam,id);
    if(!seen)return Response.json({error:'Not found'},{status:404,headers:noStore});
    return projectResponse(req,{projects:[],productions:[],project:seen.project,revision:seen.revision,shared:null,viewOnly:{owner:seen.owner}});
  }
  const team=new URL(req.url).searchParams.get('team')==='1'?await listTeamBoards(requireTenant(),auth.user.id,{kinds}):null;
  const [list,productions,draft]=await Promise.all([
    db().execute({sql:`SELECT project_id AS id,name,revision,updated_at AS updatedAt${kinds?`,${KIND}`:''} FROM workbench_projects WHERE owner=? ORDER BY updated_at DESC LIMIT 100`,args:[auth.user.id]}),
    db().execute('SELECT id,name FROM projects ORDER BY created_at DESC LIMIT 100'),
    id?readDraft(auth.user.id,id):null,
  ]);
  /* Asked for by id alone and not this person's own: a teammate's board (a board link), to look at. */
  const listed=await projectLister(auth.user);
  if(id&&!draft){
    const seen=await findTeamBoard(requireTenant(),auth.user.id,id);
    if(seen)return projectResponse(req,{projects:list.rows,productions:productions.rows.filter(r=>listed(String(r.id))),project:seen.project,revision:seen.revision,shared:null,viewOnly:{owner:seen.owner},...(team?{team}:{})});
  }
  let shared=null;
  if(draft?.project.productionProjectId){
    const row=(await db().execute({sql:'SELECT body,version,owner FROM workbench_bibles WHERE project_id=? ORDER BY version DESC LIMIT 1',args:[draft.project.productionProjectId]})).rows[0];
    if(row){
      const body=JSON.parse(String(row.body));
      /* Who published, as this workspace may read it (lib/platformOwnerPrivacy.ts). */
      if(typeof body.publishedBy==='string')body.publishedBy=(await storedActorMaskHere())(body.publishedBy);
      shared={...body,version:Number(row.version)};
    }
  }
  /* ?reach=<production>: may this person open it, and if it is a teammate's shared board, which draft opens it view-only (a link to a take asks, lib/shell/use-asset-link.ts). A private board answers as an unknown production does. */
  const reachParam=new URL(req.url).searchParams.get('reach');
  const reach=reachParam?await reachOf(auth.user,reachParam):null;
  /* A board that is the sample, a copy of it or the one it was marked from is read-only: it opens with the same view-only treatment a shared board gets. */
  const sampleView=draft&&await isSampleDraft(auth.user.id,draft.project.id,draft.project.productionProjectId)?await sampleViewOnly(requireTenant()):null;
  return projectResponse(req,{projects:list.rows,productions:productions.rows.filter(r=>listed(String(r.id))),project:draft?.project||null,revision:draft?.revision||0,shared,...(team?{team}:{}),...(reach?{reach}:{}),...(sampleView?{viewOnly:sampleView}:{})});
});

/** Whether `user` may open the production `id`, and the shared draft that opens it: an ordinary production, their own board, the marked sample or a shared board are reachable; any other private board is not. */
async function reachOf(user:{id:string;role?:string},id:string):Promise<{reachable:boolean;shared:{id:string;owner:{id:string;name:string;support?:true}}|null}>{
  if(!isDraftProject(id)||await ownsDraftProject(user.id,id)||await isMarkedSample(id))return{reachable:true,shared:null};
  const shared=await sharedBoardOfProduction(requireTenant(),id);
  return shared?{reachable:true,shared:{id:shared.draftId,owner:shared.owner}}:{reachable:false,shared:null};
}

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
  if(!parsed.success)return Response.json({error:saveProblem(parsed.error)},{status:400});
  await workbenchReady();
  const {project:p,revision,write}=parsed.data;
  /* A teammate's board opens view-only: a save of it is refused here, never kept as a second copy under this person's name. */
  const theirs=await otherOwnersBoard(requireTenant(),auth.user.id,p.id);
  if(theirs)return Response.json({error:viewOnlyRefusal(theirs.name),code:'view_only'},{status:403,headers:noStore});
  /* The marked sample production is read-only for everyone, its marker and the workspace's owner included: a save of it, of a copy opened of it or of the board it was marked from is refused in the same words. */
  const stored=(await readDraft(auth.user.id,p.id))?.project.productionProjectId;
  if(await isSampleDraft(auth.user.id,p.id,p.productionProjectId||stored)){const{owner}=await sampleViewOnly(requireTenant());return Response.json({error:viewOnlyRefusal(owner.name),code:'view_only'},{status:403,headers:noStore});}
  try{return Response.json(await saveDraft(auth.user.id,p,revision,write));}
  catch(error){return Response.json({error:error instanceof Error?error.message:'Cannot save project.',...(error instanceof DraftConflictError?{code:error.code}:{})},{status:409});}
});

export const POST=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  const scopeError=workbenchScopeProblem(req,requireTenant().id,auth.user.id,true);
  if(scopeError)return Response.json({error:scopeError},{status:409,headers:noStore});
  if(originProblem(req))return Response.json({error:'Invalid request origin'},{status:403});
  const body=await req.json().catch(()=>null);
  /* Studio's first run: the workspace's starter production, seeded once and opened as this person's draft.
     Sample takes on the platform's own previews: no engine is called and nothing is charged (lib/starter.ts). */
  if(body?.action==='starter'){
    try{return projectResponse(req,await openStarterDraft({id:auth.user.id,name:auth.user.name}));}
    catch(error){
      if(error instanceof StarterUnavailableError)return Response.json({error:error.message},{status:409,headers:noStore});
      console.error('The starter production could not be opened:',error);
      return Response.json({error:'The starter production could not be opened. Try again.'},{status:500,headers:noStore});
    }
  }
  if(!body || typeof body.projectId!=='string')return Response.json({error:'Choose a project.'},{status:400});
  await workbenchReady();
  if(body.action==='open'){
    const row=(await db().execute({sql:'SELECT id,name,description FROM projects WHERE id=?',args:[body.projectId]})).rows[0];
    /* A private board is its owner's alone: to anyone else it is as absent as an unknown id (lib/draftProject.ts). */
    if(!row||!(await mayReachProject(auth.user,body.projectId,'read')))return Response.json({error:'Project not found'},{status:404});
    /* A teammate's SHARED board is theirs to look at, not to save: it opens view-only (no draft of their own is made or saved against it), as a board link does. */
    const viewOnly=(await mayReachProject(auth.user,body.projectId,'write'))?null:(await sharedBoardOwnerOf(requireTenant(),body.projectId))??((await isSampleProject(body.projectId))?(await sampleViewOnly(requireTenant())).owner:{id:'',name:'A teammate'});
    const latest=(await db().execute({sql:'SELECT body,version FROM workbench_bibles WHERE project_id=? ORDER BY version DESC LIMIT 1',args:[body.projectId]})).rows[0];
    const shared=latest?JSON.parse(String(latest.body)):null;
    const p:Project={...newProject(String(row.name)),description:String(row.description||''),productionProjectId:String(row.id),...(shared?{brief:shared.brief,script:shared.script,scriptFormat:shared.scriptFormat==='adfilm'?'adfilm':'screenplay',scriptSource:shared.scriptSource,scriptReviews:shared.scriptReviews,direction:shared.direction,assets:shared.assets,nodes:shared.nodes,sharedAssets:shared.assets,sharedNodes:shared.nodes,sharedAssetIds:shared.assets.map((a:{id:string})=>a.id),sharedNodeIds:shared.nodes.map((n:{id:string})=>n.id),bibleVersion:Number(latest!.version)}:{})};
    return projectResponse(req,{project:p,revision:0,...(viewOnly?{viewOnly:{owner:viewOnly}}:{})});
  }
  if(body.action==='check-write'){
    /* A save whose reply was lost: did it land (and at which revision)? Checking fences it off, so the answer is final; the draft comes back as it is now. */
    const write=draftWriteTagSchema.safeParse(body.write);
    if(!write.success)return Response.json({error:'Name the save to check.'},{status:400});
    const landed=await checkDraftWrite(auth.user.id,body.projectId,write.data);
    const now=await readDraft(auth.user.id,body.projectId);
    return projectResponse(req,{landed,project:now?.project??null,revision:now?.revision??0});
  }
  const draft=await readDraft(auth.user.id,body.projectId);
  if(!draft){
    const theirs=await otherOwnersBoard(requireTenant(),auth.user.id,body.projectId);
    if(theirs)return Response.json({error:viewOnlyRefusal(theirs.name),code:'view_only'},{status:403,headers:noStore});
    return Response.json({error:'Save your project first.'},{status:404});
  }
  /* The sample's copies and the board it was marked from are nobody's to share, publish or map into the sample: view-only for everyone (lib/demo/readonly.server.ts). */
  if(body.action==='team-share'||body.action==='map-shot'||body.action==='publish'){const{sampleDraftRefusal}=await import('@/lib/demo/readonly.server');const refused=await sampleDraftRefusal(auth.user.id,draft.project);if(refused)return refused;}
  if(body.action==='team-share'){
    /* The author shares a board with the workspace's team, or stops (lib/workbench/team-boards.ts): one flag in the draft's own JSON, so nothing
       else about it changes. Only the author's own draft is found here; a teammate's gets the same "not saved" answer as every other write. */
    if(typeof body.shared!=='boolean')return Response.json({error:'Say whether to share this board.'},{status:400});
    if(body.shared===(draft.project.teamShared===true))return Response.json({ok:true,shared:body.shared,revision:draft.revision});
    try{
      const saved=await saveDraft(auth.user.id,{...draft.project,teamShared:body.shared},draft.revision);
      return Response.json({ok:true,shared:body.shared,revision:saved.revision});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'Cannot save project.',...(error instanceof DraftConflictError?{code:error.code}:{})},{status:409});}
  }
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
