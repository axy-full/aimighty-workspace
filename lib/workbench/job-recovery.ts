import type { Asset, Project } from './studio';

export type MediaJob = {
  id:string; status:string; kind:'image'|'video'|'audio'; shotId?:string; prompt:string;
  version?:number; model:string; error?:string; creditsBilled?:number; createdAt?:number;
  params?:{ratio?:string; references?:Array<{uploadId?:string;genId?:string}>};
};
export const activeMediaJob=(job:MediaJob)=>!['succeeded','failed','cancelled'].includes(job.status);

/** Recover every missing asset that fits the persisted draft. A late take cannot
 * replace a newer take or a person's manual/selected asset on the canvas. */
export function recoverMediaAssets(project:Project,jobs:MediaJob[]):Project {
  const mapping=project.shotMappings??{};
  const byShot=new Map(Object.entries(mapping).map(([node,shot])=>[shot,node]));
  const have=new Set(project.assets.map(a=>a.generationId).filter(Boolean));
  const incoming=jobs.filter(j=>j.status==='succeeded'&&byShot.has(j.shotId??'')&&!have.has(j.id));
  const assets:Asset[]=[];
  for(const job of incoming){
    if(have.has(job.id)||project.assets.length+assets.length>=500)continue;
    have.add(job.id);
    const nodeId=byShot.get(job.shotId!);const node=project.nodes.find(n=>n.id===nodeId);
    const refs=(job.params?.references??[]).flatMap(ref=>project.assets.filter(a=>ref.genId?a.generationId===ref.genId:!!ref.uploadId&&a.uploadId===ref.uploadId).map(a=>a.id));
    assets.push({id:job.id,generationId:job.id,productionShotId:job.shotId,nodeId,name:(node?.title??'Generated take')+' · v'+(job.version??1),kind:job.kind,category:'Shot',url:'/api/media/'+job.id,description:job.model,prompt:job.prompt,status:'Draft',locked:false,version:job.version??1,refs});
  }
  if(!assets.length)return project;
  const all=[...project.assets,...assets];
  return {...project,assets:all,nodes:project.nodes.map(node=>{
    if(node.locked)return node;
    const current=all.find(a=>a.id===node.assetId);
    if(current&&(current.locked||current.status==='Selected'||!current.generationId||current.nodeId!==node.id))return node;
    const newer=assets.filter(a=>a.nodeId===node.id&&a.kind!=='audio'&&a.version>(current?.version??0)).sort((a,b)=>b.version-a.version)[0];
    return newer?{...node,assetId:newer.id}:node;
  })};
}
