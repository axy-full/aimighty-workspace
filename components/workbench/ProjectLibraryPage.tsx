'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/lib/usePageTitle';
import type { Project, Asset } from '@/lib/workbench/studio';
import { draftRequest, writeDraft } from '@/lib/workbench/draft-request';
import { libraryId, libraryKind, libraryName, type LibraryAsset } from '@/lib/genLibrary';
import type { DraggedAsset } from '@/lib/dnd';
import ProjectAssetLibrary from './ProjectAssetLibrary';
import styles from './project-asset-library.module.css';
import genStyles from '@/components/make/gen.module.css';

type DraftResponse = {project:Project|null;revision:number;projects:{id:string;name:string}[]};
export function libraryToolHref(projectId:string, asset:LibraryAsset, task?:'edit'|'upscale') {
  const kind=libraryKind(asset),mode=kind==='video'?'video':kind==='audio'?'audio':'images';
  const params=new URLSearchParams({project:projectId,mode});
  if(task&&!(task==='edit'&&mode==='images')) {params.set('task',task);params.set('source',libraryId(asset));}
  else params.set('ref',libraryId(asset));
  return `/generate?${params}`;
}
export function projectAssetFromLibrary(asset:LibraryAsset):Asset {
  const kind=libraryKind(asset),gen=asset.origin==='generation'?asset.value:null;
  return {id:`library-${asset.origin}-${asset.value.id}`,name:libraryName(asset).slice(0,200),kind:kind==='file'?'document':kind,category:gen?'Shot':kind==='audio'?'Audio':'Reference',
    url:gen?`/api/media/${gen.id}`:`/api/uploads/${asset.value.id}`,description:gen?gen.model:'Uploaded original',prompt:gen?.prompt??'',status:'Draft',locked:false,version:gen?.version??1,refs:[],
    ...(gen?{generationId:gen.id,...(gen.shotId?{productionShotId:gen.shotId}:{})}:{uploadId:asset.value.id,mime:asset.origin==='upload'?asset.value.mime:undefined})};
}
/** Read the latest revision immediately before importing; the existing save
 * protocol rejects concurrent changes and reconciles a lost successful reply. */
export async function importLibraryAsset(projectId:string,scope:string,asset:LibraryAsset) {
  const latest=await draftRequest<DraftResponse>(`/api/workbench/projects?id=${encodeURIComponent(projectId)}`,scope);
  if(!latest.project)throw new Error('Open a saved project before adding assets.');
  const next=projectAssetFromLibrary(asset);
  if(latest.project.assets.some(item=>next.generationId?item.generationId===next.generationId:item.uploadId===next.uploadId))return;
  await writeDraft('/api/workbench',scope,{revision:latest.revision,project:{...latest.project,assets:[...latest.project.assets,next]}});
}
export default function ProjectLibraryPage() {
  const {requestScope,signedIn}=useSession();
  return <ProjectLibraryRoute key={requestScope??'visitor'} scope={requestScope??null} signedIn={signedIn}/>;
}
function ProjectLibraryRoute({scope,signedIn}:{scope:string|null;signedIn:boolean}) {
  const router=useRouter(),query=useSearchParams(),toast=useToast();
  const projectId=query.get('project');
  const [importing,setImporting]=useState(false),busy=useRef(false);
  const data=useApi<DraftResponse>(signedIn&&scope?`/api/workbench/projects${projectId?`?id=${encodeURIComponent(projectId)}`:''}`:null,0,scope);
  usePageTitle('Project library');
  useEffect(()=>{
    if(projectId||!scope||!data.data)return;
    let last:string|null=null;try{last=localStorage.getItem(scope);}catch{}
    if(last&&data.data.projects.some(project=>project.id===last))router.replace(`/library?project=${encodeURIComponent(last)}`);
  },[projectId,scope,data.data,router]);
  async function add(asset:LibraryAsset) {
    if(!projectId||!scope||busy.current)return;
    busy.current=true;setImporting(true);
    try {await importLibraryAsset(projectId,scope,asset);toast('Asset added to this project.');data.refresh();}
    catch(error){toast(error instanceof Error?error.message:'The asset could not be added.');}
    finally{busy.current=false;setImporting(false);}
  }
  function useAsset(asset:DraggedAsset) {
    if(!projectId)return;
    const kind=asset.kind==='gen'?asset.gen.kind:asset.kind==='upload'?asset.upload.kind:'image';
    const id=asset.kind==='gen'?`generation:${asset.gen.id}`:asset.kind==='upload'?`upload:${asset.upload.id}`:`upload:${asset.uploadId}`;
    router.push(`/generate?${new URLSearchParams({project:projectId,mode:kind==='video'?'video':kind==='audio'?'audio':'images',ref:id})}`);
  }
  if(!signedIn)return <div className={styles.choice}><h1>Project library</h1><p>Sign in to open a project’s files and takes.</p></div>;
  if(!data.data)return <div className={styles.choice} role={data.error?'alert':'status'}>{data.error||'Opening project library…'}{data.error&&<button onClick={()=>data.refresh()}>Try again</button>}</div>;
  if(!projectId||!data.data.project)return <div className={`${genStyles.workspace} ${styles.choice}`}>
    <h1>Choose a project</h1><p>Open a Studio project to see its uploads and generations.</p>
    {data.data.projects.map(project=><Link key={project.id} href={`/library?project=${encodeURIComponent(project.id)}`}>{project.name}</Link>)}
    <Link href="/workbench">Start or open a project in Studio</Link><Link href="/library?all=1">Browse All assets</Link>
  </div>;
  const project=data.data.project;
  return <div className={`${genStyles.workspace} ${styles.panel}`}>
    {importing&&<p className={styles.importing} role="status">Adding asset to project…</p>}
    <ProjectAssetLibrary projectId={project.id} projectName={project.name} fallbackAssets={project.assets}
      onUseAsset={useAsset} onEdit={asset=>router.push(libraryToolHref(project.id,asset,'edit'))} onUpscale={asset=>router.push(libraryToolHref(project.id,asset,'upscale'))}
      onAddToProject={asset=>void add(asset)} onUsePrompt={take=>router.push(`/generate?${new URLSearchParams({project:project.id,mode:take.kind==='image'?'images':take.kind,promptFrom:take.id})}`)}/>
  </div>;
}
