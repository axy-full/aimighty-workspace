'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {studioRequest} from './GenerationDialog';
import type {ThinkingModel} from '@/components/atomik/ModelPicker';
import type {Project,Plan} from '@/lib/workbench/studio';
import {activeMediaJob,recoverMediaAssets,type MediaJob} from '@/lib/workbench/job-recovery';

export type AtomikJob={id:string;status:string;model:string;effort?:string;request:string;role?:string;plan?:Plan|null;error?:string|null;credits?:number|null;estimateUsd?:number};
type MediaPage={generations:MediaJob[];nextCursor:number|null};
type Recovery={jobs:Map<string,MediaJob>;cursor:number|null;started:boolean};
const scopeOf=(p:Project)=>p.id+':'+(p.productionProjectId??'');
export function useProductionJobs(project:Project,enabled:boolean,change:(fn:(p:Project)=>Project,remember?:boolean)=>void){
 const [media,setMedia]=useState<{scope:string;jobs:MediaJob[]}>({scope:'',jobs:[]});
 const [atomik,setAtomik]=useState<{scope:string;jobs:AtomikJob[]}>({scope:'',jobs:[]});
 const [models,setModels]=useState<ThinkingModel[]>([]);
 const [errors,setErrors]=useState<{scope:string;atomik?:string;media?:string}>({scope:''});
 const ref=useRef(project);useLayoutEffect(()=>{ref.current=project},[project]);
 const epoch=useRef(0),inFlight=useRef<{scope:string;abort:AbortController;promise:Promise<void>}|null>(null);
 const recovery=useRef(new Map<string,Recovery>());
 const refresh=useCallback(()=>{
  if(!enabled)return Promise.resolve();
  const p=ref.current,scope=scopeOf(p);
  if(inFlight.current?.scope===scope)return inFlight.current.promise;
  inFlight.current?.abort.abort();
  const abort=new AbortController(),ticket=++epoch.current;
  const current=()=>ticket===epoch.current&&!abort.signal.aborted&&scopeOf(ref.current)===scope;
  const report=(channel:'media'|'atomik',error?:unknown)=>{if(current())setErrors(old=>({...((old.scope===scope)?old:{scope}),[channel]:error?(error instanceof Error?error.message:'Could not refresh '+channel+' activity.'):undefined}));};
  const atomTask=async()=>{
   try{
    const result=await studioRequest<{models:ThinkingModel[];jobs:AtomikJob[]}>('/api/workbench/atomik?projectId='+encodeURIComponent(p.id),{signal:abort.signal});
    if(!current())return;
    setModels(result.models??[]);setAtomik({scope,jobs:result.jobs??[]});
    const plans=(result.jobs??[]).filter(j=>j.status==='succeeded'&&j.plan).map(j=>j.plan!);
    if(plans.some(plan=>!ref.current.plans.some(a=>a.id===plan.id)))change(old=>scopeOf(old)===scope?{...old,plans:[...old.plans,...plans.filter(plan=>!old.plans.some(a=>a.id===plan.id))].slice(-100)}:old,false);
    report('atomik');
   }catch(error){report('atomik',error);}
  };
  const mediaTask=async()=>{
   if(!p.productionProjectId){if(current())setMedia({scope,jobs:[]});return;}
   const prior=recovery.current.get(scope)??{jobs:new Map<string,MediaJob>(),cursor:null,started:false};
   const state:Recovery={jobs:new Map(prior.jobs),cursor:prior.cursor,started:prior.started};
   const page=async(before?:number)=>studioRequest<MediaPage>('/api/jobs?'+new URLSearchParams({projectId:p.productionProjectId!,mine:'1',sync:before==null?'1':'0',limit:'250',...(before==null?{}:{before:String(before)})}),{signal:abort.signal});
   try{
    const latest=await page();if(!current())return;
    const seen=new Set(latest.generations.map(j=>j.id));
    for(const job of latest.generations)state.jobs.set(job.id,job);
    if(!state.started){state.cursor=latest.nextCursor;state.started=true;}
    // At most one older page per refresh; completed history is never reloaded in full.
    if(state.cursor!=null){const older=await page(state.cursor);if(!current())return;for(const job of older.generations){state.jobs.set(job.id,job);seen.add(job.id);}state.cursor=older.nextCursor===state.cursor?null:older.nextCursor;}
    // Older known live jobs may finish outside the newest page. Poll only those,
    // bounded in batches, while the ordinary list reconciles providers once.
    const active=[...state.jobs.values()].filter(j=>activeMediaJob(j)&&!seen.has(j.id));
    for(let i=0;i<active.length;i+=4){
     const results=await Promise.allSettled(active.slice(i,i+4).map(job=>studioRequest<{generation:MediaJob}>('/api/jobs/'+encodeURIComponent(job.id),{signal:abort.signal})));
     if(!current())return;
     for(const result of results)if(result.status==='fulfilled')state.jobs.set(result.value.generation.id,result.value.generation);
    }
    if(!current())return;
    recovery.current.set(scope,state);
    const mapping=new Set(Object.values(ref.current.shotMappings??{}));
    const jobs=[...state.jobs.values()].filter(j=>mapping.has(j.shotId??'')).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
    setMedia({scope,jobs});
    change(old=>scopeOf(old)===scope?recoverMediaAssets(old,jobs):old,false);
    const missing=jobs.filter(j=>j.status==='succeeded'&&!ref.current.assets.some(a=>a.generationId===j.id)).length;
    report('media',ref.current.assets.length+missing>500?new Error('This working space has reached 500 assets. Additional completed takes remain in Activity and the project library.'):undefined);
   }catch(error){report('media',error);}
  };
  const promise=Promise.allSettled([atomTask(),mediaTask()]).then(()=>{}).finally(()=>{if(inFlight.current?.abort===abort)inFlight.current=null;});
  inFlight.current={scope,abort,promise};return promise;
 },[enabled,change]);
 const mappingKey=JSON.stringify(project.shotMappings??{});
 useEffect(()=>{
  if(!enabled)return;
  void refresh();const timer=setInterval(()=>void refresh(),6000);
  return()=>{clearInterval(timer);inFlight.current?.abort.abort();inFlight.current=null;};
 },[project.id,project.productionProjectId,mappingKey,enabled,refresh]);
 const scope=scopeOf(project);
 return {mediaJobs:media.scope===scope?media.jobs:[],atomikJobs:atomik.scope===scope?atomik.jobs:[],models,error:errors.scope===scope?[errors.atomik,errors.media].filter(Boolean).join(' '):'',refresh};
}
