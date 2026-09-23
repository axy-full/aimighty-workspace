import { PROJECT_LIMITS } from '../../lib/workbench/project-limits';
import {test,expect} from '@playwright/test';
import {newProject,type Asset,type Project} from '../../lib/workbench/studio';
import {recoverMediaAssets,type MediaJob} from '../../lib/workbench/job-recovery';
const job=(id:string,version:number):MediaJob=>({id,version,kind:'image',status:'succeeded',shotId:'shot_one',model:'mock',prompt:'A test frame'});
function project(asset?:Asset):Project{return {...newProject('Recovery'),shotMappings:{node_one:'shot_one'},assets:asset?[asset]:[],nodes:[{id:'node_one',title:'The scene',type:'scene',x:0,y:0,width:200,linked:[],assetId:asset?.id}]};}
const asset=(id:string,version=1):Asset=>({id,generationId:id,nodeId:'node_one',version,name:id,kind:'image',category:'Shot',url:'/api/media/'+id,prompt:'',description:'',status:'Draft',locked:false,refs:[]});

test('a late older generation is recovered without replacing the newer node take',()=>{
 const result=recoverMediaAssets(project(asset('v2',2)),[job('v1',1)]);
 expect(result.assets.map(a=>a.id)).toEqual(['v2','v1']);expect(result.nodes[0].assetId).toBe('v2');
});
test('out-of-order recovered results select the highest version only on an eligible node',()=>{
 const result=recoverMediaAssets(project(),[job('v1',1),job('v3',3),job('v2',2)]);
 expect(result.nodes[0].assetId).toBe('v3');expect(result.assets).toHaveLength(3);
 expect(recoverMediaAssets(result,[job('v3',3)])).toBe(result);
});
test('manual selections, selected takes and locked nodes survive background recovery',()=>{
 const manual={...asset('uploaded'),generationId:undefined};
 for(const picked of [manual,{...asset('v1',1),status:'Selected' as const},{...asset('v1',1),locked:true}])expect(recoverMediaAssets(project(picked),[job('v2',2)]).nodes[0].assetId).toBe(picked.id);
 const locked=project();locked.nodes[0].locked=true;expect(recoverMediaAssets(locked,[job('v1',1)]).nodes[0].assetId).toBeUndefined();
});
test('recovery respects mappings and the persisted asset limit',()=>{
 const p=project();p.assets=Array.from({length:PROJECT_LIMITS.assets-1},(_,i)=>asset('asset-'+i));
 const result=recoverMediaAssets(p,[{...job('foreign',1),shotId:'other-shot'},job('newest',2),job('older',1)]);
 expect(result.assets).toHaveLength(PROJECT_LIMITS.assets);expect(result.assets.at(-1)?.id).toBe('newest');expect(result.assets.some(a=>a.id==='foreign')).toBe(false);
});


test('an explicit Audio output recovers a usable node binding and retains reference inputs',()=>{
 const p=project();p.nodes[0]={...p.nodes[0],type:'generate',mode:'Audio',linked:['reference']};
 const result=recoverMediaAssets(p,[{...job('sound',1),kind:'audio'}]);
 expect(result.nodes[0].assetId).toBe('sound');expect(result.nodes[0].linked).toEqual(['reference']);expect(result.assets[0].kind).toBe('audio');
});
test('an audio intent changed after the take arrived still adopts the recovered output',()=>{
 const p=project();const stored=recoverMediaAssets(p,[{...job('sound',1),kind:'audio'}]);
 expect(stored.nodes[0].assetId).toBeUndefined();
 const wanted={...stored,nodes:stored.nodes.map(node=>({...node,mode:'Audio'}))};
 const result=recoverMediaAssets(wanted,[{...job('sound',1),kind:'audio'}]);
 expect(result.nodes[0].assetId).toBe('sound');expect(result.assets).toHaveLength(1);
});
test('audio generation never replaces a manually attached or pinned asset',()=>{
 for(const original of [{...asset('upload'),generationId:undefined},{...asset('visual'),status:'Selected' as const},{...asset('visual'),locked:true}]){
  const p=project(original);p.nodes[0].mode='Audio';
  const result=recoverMediaAssets(p,[{...job('sound',2),kind:'audio'}]);expect(result.nodes[0].assetId).toBe(original.id);expect(result.assets.some(a=>a.id==='sound')).toBe(true);
 }
});

test('mixed image and video history never oscillates or replaces a newer visual take on repeated polls',()=>{
 for(const [olderKind,newerKind] of [['image','video'],['video','image']] as const){
  const older={...asset('older',1),kind:olderKind},newer={...asset('newer',2),kind:newerKind};
  const p={...project(newer),assets:[older,newer]};p.nodes[0].mode=newerKind==='video'?'Video':'Image';
  const history=[{...job('older',1),kind:olderKind},{...job('newer',2),kind:newerKind}];
  let current:Project=p;
  for(let poll=0;poll<4;poll++){const next=recoverMediaAssets(current,history);expect(next).toBe(current);expect(next.nodes[0].assetId).toBe('newer');current=next;}
  const latest={...job('latest',3),kind:olderKind};
  const updated=recoverMediaAssets(current,[...history,latest]);expect(updated.nodes[0].assetId).toBe('latest');
  expect(recoverMediaAssets(updated,[...history,latest])).toBe(updated);
 }
});

test('switching output family can adopt an older completed take without reverting on later polls',()=>{
 const image=asset('visual',4),audio={...asset('sound',1),kind:'audio' as const};
 const p={...project(image),assets:[image,audio]};p.nodes[0].mode='Audio';
 const history=[job('visual',4),{...job('sound',1),kind:'audio' as const}];
 const sound=recoverMediaAssets(p,history);expect(sound.nodes[0].assetId).toBe('sound');
 expect(recoverMediaAssets(sound,history)).toBe(sound);
 const visualIntent={...sound,nodes:sound.nodes.map(node=>({...node,mode:'Image'}))};
 const visual=recoverMediaAssets(visualIntent,history);expect(visual.nodes[0].assetId).toBe('visual');
 expect(recoverMediaAssets(visual,history)).toBe(visual);
});

test('a confirmed mapped take imported before recovery binds once without duplicating the asset',()=>{
 const imported={...asset('library-sound',1),generationId:'sound',nodeId:undefined,productionShotId:'stale-import-metadata',kind:'audio' as const};
 const p=project();p.nodes[0].mode='Audio';p.assets=[imported];
 const history=[{...job('sound',1),kind:'audio' as const}];
 const result=recoverMediaAssets(p,history);
 expect(result.assets).toHaveLength(1);expect(result.assets[0]).toMatchObject({id:'library-sound',nodeId:'node_one',productionShotId:'shot_one'});
 expect(result.nodes[0].assetId).toBe('library-sound');
 expect(recoverMediaAssets(result,history)).toBe(result);
});

test('imported metadata cannot establish lineage without a matching completed job in this draft',()=>{
 for(const foreign of [{...job('sound',1),kind:'audio' as const,shotId:'other-project-shot'},{...job('sound',1),kind:'audio' as const,status:'running'}]){
  const p=project();p.nodes[0].mode='Audio';p.assets=[{...asset('imported'),generationId:'sound',nodeId:undefined,productionShotId:'shot_one',kind:'audio'}];
  expect(recoverMediaAssets(p,[foreign])).toBe(p);
 }
 const stale=project();stale.nodes[0].mode='Audio';stale.shotMappings!.other_node='other_shot';
 stale.assets=[{...asset('imported'),generationId:'sound',nodeId:'node_one',kind:'audio'}];
 expect(recoverMediaAssets(stale,[{...job('sound',1),kind:'audio',shotId:'other_shot'}]).nodes[0].assetId).toBeUndefined();
});

test('import reconciliation preserves locks, selected assets and manual attachments',()=>{
 const history=[{...job('sound',1),kind:'audio' as const}];
 for(const protection of ['locked-asset','selected-asset','manual-attachment','locked-node']){
  const imported={...asset('imported'),generationId:'sound',nodeId:undefined,kind:'audio' as const,locked:protection==='locked-asset',status:protection==='selected-asset'?'Selected' as const:'Draft' as const};
  const p=project();p.nodes[0].mode='Audio';p.assets=[imported];
  if(protection==='manual-attachment')p.nodes[0].assetId='imported';
  if(protection==='locked-node')p.nodes[0].locked=true;
  const result=recoverMediaAssets(p,history);
  expect(result.nodes[0]).toBe(p.nodes[0]);
  if(protection!=='locked-node')expect(result.assets[0]).toBe(imported);
 }
});
