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
 const p=project();p.assets=Array.from({length:499},(_,i)=>asset('asset-'+i));
 const result=recoverMediaAssets(p,[{...job('foreign',1),shotId:'other-shot'},job('newest',2),job('older',1)]);
 expect(result.assets).toHaveLength(500);expect(result.assets.at(-1)?.id).toBe('newest');expect(result.assets.some(a=>a.id==='foreign')).toBe(false);
});
