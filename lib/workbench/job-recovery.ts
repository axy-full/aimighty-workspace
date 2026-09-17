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
  const completed=new Map(jobs.filter(job=>job.status==='succeeded'&&byShot.has(job.shotId??'')).map(job=>[job.id,{nodeId:byShot.get(job.shotId!)!,shotId:job.shotId!,kind:job.kind}]));
  const attached=new Set(project.nodes.map(node=>node.assetId).filter(Boolean));
  let changed=false;
  // A library import may precede recovery. Reuse that asset, proving lineage
  // from the completed job and this draft's mapping, not imported metadata.
  // Existing manual attachments and protected selections remain untouched.
  const reconciled=project.assets.map(asset=>{
    if(!asset.generationId||asset.nodeId||asset.locked||asset.status==='Selected'||attached.has(asset.id))return asset;
    const proof=completed.get(asset.generationId);
    if(!proof||proof.kind!==asset.kind)return asset;
    changed=true;return {...asset,nodeId:proof.nodeId,productionShotId:proof.shotId};
  });
  const all=assets.length?[...reconciled,...assets]:changed?reconciled:project.assets;
  const nodes=project.nodes.map(node=>{
    if(node.locked)return node;
    const current=all.find(a=>a.id===node.assetId);
    if(current&&(current.locked||current.status==='Selected'||!current.generationId||current.nodeId!==node.id))return node;
    const audioOutput=node.mode==='Audio'||node.type==='audio';
    // Image and video takes share one visual version sequence. Switching
    // between them must not make an older take look new on every poll.
    const currentVersion=current&&(current.kind==='audio')===audioOutput?current.version:0;
    const newer=all.filter(a=>a.nodeId===node.id&&!!a.generationId&&completed.get(a.generationId)?.nodeId===node.id&&(audioOutput?a.kind==='audio':a.kind!=='audio')&&a.version>currentVersion).sort((a,b)=>b.version-a.version)[0];
    if(!newer||newer.id===node.assetId)return node;
    changed=true;return {...node,assetId:newer.id};
  });
  return assets.length||changed?{...project,assets:all,nodes}:project;
}
