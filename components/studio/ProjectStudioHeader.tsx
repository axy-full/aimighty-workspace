'use client';
import {useEffect,useState,type MouseEvent} from 'react';
import Link from 'next/link';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {ChevronDown,FolderOpen,Plus,ScanLine,LayoutGrid} from 'lucide-react';
import {useSession} from '@/lib/session';
import {useApi} from '@/lib/useApi';
import {useProject} from '@/lib/projectContext';
import {withPageLeaveGuard} from '@/lib/usePageLeaveGuard';
import {toggleAtomikRail,useAtomikRail} from '@/lib/atomikRail';
import {AtomikMark} from '@/components/AtomikMark';
import {STAGES,type Project} from '@/lib/workbench/studio';
import StudioNavigation from './StudioNavigation';
import {DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger} from '@/components/workbench/ui/dropdown-menu';
import './project-navigation.css';

export default function ProjectStudioHeader(){
 const session=useSession(),router=useRouter(),params=useSearchParams(),path=usePathname();
 const [remembered,setRemembered]=useState<{scope:string;id:string}>({scope:'',id:''});
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate a browser-only preference after the server render.
 useEffect(()=>{if(session.requestScope){let id='';try{id=localStorage.getItem(session.requestScope)??'';}catch{}setRemembered({scope:session.requestScope,id});}},[session.requestScope]);
 const id=params.get('project')||(remembered.scope===session.requestScope?remembered.id:'');
 const {data,error}=useApi<{project?:Project;projects:{id:string;name:string}[]}> (session.requestScope?'/api/workbench/projects'+(id?'?id='+encodeURIComponent(id):''):null,0,session.requestScope);
 const current=data?.project,{setSelection}=useProject();
 useEffect(()=>{if(current?.productionProjectId)setSelection(current.productionProjectId);},[current?.productionProjectId,setSelection]);
 const rail=useAtomikRail();
 const go=async(href:string)=>withPageLeaveGuard(()=>router.push(href));
 function follow(event:MouseEvent<HTMLAnchorElement>,href:string){if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();void go(href);}
 const href=(route:string,extra='')=>route+'?'+new URLSearchParams({...(id?{project:id}:{}),...Object.fromEntries(new URLSearchParams(extra))});
 const all=params.get('all')==='1';
 return <div className="project-studio-header">
  <StudioNavigation compact hideSections initialAccount={session.signedIn?{name:session.name??'Your account',workspace:session.workspace,workspaces:session.workspaces,credits:session.credits}:null}>
   <Link className="project-studio-home" href="/workbench" onClick={e=>follow(e,'/workbench')}>Projects</Link>
   <DropdownMenu><DropdownMenuTrigger asChild><button className="project-studio-selector" aria-label="Select project"><span>{current?.name??(!data&&id?'Loading project…':'Choose a project')}</span><ChevronDown size={14}/></button></DropdownMenuTrigger><DropdownMenuContent className="studio-account-menu" align="start">
    {(data?.projects??[]).map(project=><DropdownMenuItem key={project.id} onSelect={()=>{const next=new URLSearchParams(params);next.set('project',project.id);next.delete('all');void go(path+'?'+next);}}>{project.name}</DropdownMenuItem>)}
    <DropdownMenuItem onSelect={()=>void go('/workbench?new=1')}><Plus size={14}/>New project</DropdownMenuItem>
   </DropdownMenuContent></DropdownMenu>
   <div className="project-studio-actions"><Link className="all-assets-button" href={href('/library','all=1')} aria-current={all?'page':undefined} aria-label="All assets" onClick={e=>follow(e,href('/library','all=1'))}><FolderOpen size={16}/><span>All assets</span></Link><button className="project-atomik-toggle" aria-label="Toggle Atomik creative engine" aria-expanded={rail.open} onClick={toggleAtomikRail}><AtomikMark size={17}/><span>Atomik</span></button></div>
  </StudioNavigation>
  {id&&<nav className="project-workflow-controls" aria-label="Project workflow">
    {STAGES.map((stage,index)=><Link key={stage.id} href={href('/workbench','stage='+stage.id)} onClick={e=>follow(e,href('/workbench','stage='+stage.id))}><small>{String(index+1).padStart(2,'0')}</small>{['Brief','Script','Look','Cast','Elements','Astra blender','Nodes','Boards','Takes','Edit','Deliver'][index]}</Link>)}
    <span className="project-control-divider"/>
    <Link href={href('/generate')} aria-current={path==='/generate'?'page':undefined} onClick={e=>follow(e,href('/generate'))}><ScanLine size={14}/>Gen</Link>
    <Link href={href('/library')} aria-current={path==='/library'&&!all?'page':undefined} onClick={e=>follow(e,href('/library'))}><FolderOpen size={14}/>Library</Link>
    <Link href={href('/workbench','view=workspace')} onClick={e=>follow(e,href('/workbench','view=workspace'))}><LayoutGrid size={14}/>Workspace</Link>
  </nav>}
  {error&&<p className="project-header-error" role="alert">Could not load the project selector. Refresh when your connection returns.</p>}
 </div>;
}
