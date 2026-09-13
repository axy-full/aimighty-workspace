import { withTenant, requireSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { saveSchema } from '@/lib/workbench/studio-schema';
import { newProject, type Project } from '@/lib/workbench/studio';
import { workbenchReady, readDraft, mapNodeShot, saveDraft, publishBible } from '@/lib/workbench/records';

export const dynamic='force-dynamic';
const noStore={'Cache-Control':'no-store'};
function originProblem(req:Request) {
  const origin=req.headers.get('origin');
  return origin && origin!==new URL(req.url).origin;
}

export const GET=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
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
  return Response.json({projects:list.rows,productions:productions.rows,project:draft?.project||null,revision:draft?.revision||0,shared}, {headers:noStore});
});

export const PUT=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  if(originProblem(req))return Response.json({error:'Invalid request origin'},{status:403});
  if(Number(req.headers.get('content-length')||0)>2_000_000)return Response.json({error:'Production exceeds the 2 MB limit.'},{status:413});
  const raw=await req.text();if(raw.length>2_000_000)return Response.json({error:'Production exceeds the 2 MB limit.'},{status:413});
  let value:unknown;try{value=JSON.parse(raw)}catch{return Response.json({error:'Invalid project JSON'},{status:400})}
  const parsed=saveSchema.safeParse(value);
  if(!parsed.success)return Response.json({error:'Check the production fields before saving.'},{status:400});
  await workbenchReady();
  const {project:p,revision}=parsed.data;
  try{return Response.json(await saveDraft(auth.user.id,p,revision));}
  catch(error){return Response.json({error:error instanceof Error?error.message:'Cannot save production.'},{status:409});}
});

export const POST=withTenant(async(req:Request)=>{
  const auth=await requireSession();if(auth.response)return auth.response;
  if(originProblem(req))return Response.json({error:'Invalid request origin'},{status:403});
  const body=await req.json().catch(()=>null);
  if(!body || typeof body.projectId!=='string')return Response.json({error:'Choose a production.'},{status:400});
  await workbenchReady();
  if(body.action==='open'){
    const row=(await db().execute({sql:'SELECT id,name,description FROM projects WHERE id=?',args:[body.projectId]})).rows[0];
    if(!row)return Response.json({error:'Production not found'},{status:404});
    const latest=(await db().execute({sql:'SELECT body,version FROM workbench_bibles WHERE project_id=? ORDER BY version DESC LIMIT 1',args:[body.projectId]})).rows[0];
    const shared=latest?JSON.parse(String(latest.body)):null;
    const p:Project={...newProject(String(row.name)),description:String(row.description||''),productionProjectId:String(row.id),...(shared?{brief:shared.brief,script:shared.script,direction:shared.direction,assets:shared.assets,nodes:shared.nodes,sharedAssets:shared.assets,sharedNodes:shared.nodes,sharedAssetIds:shared.assets.map((a:{id:string})=>a.id),sharedNodeIds:shared.nodes.map((n:{id:string})=>n.id),bibleVersion:Number(latest!.version)}:{})};
    return Response.json({project:p,revision:0});
  }
  const draft=await readDraft(auth.user.id,body.projectId);
  if(!draft)return Response.json({error:'Save your production first.'},{status:404});
  if(body.action==='map-shot'){
    try{return Response.json({productionProjectId:draft.project.productionProjectId,shotId:await mapNodeShot(auth.user.id,draft.project,String(body.nodeId||''))})}
    catch(e){return Response.json({error:e instanceof Error?e.message:'Cannot map this node'},{status:400})}
  }
  if(body.action==='publish'){
    return Response.json(await publishBible(auth.user.id,auth.user.name,body.projectId));
  }
  return Response.json({error:'Unknown production action'},{status:400});
});
