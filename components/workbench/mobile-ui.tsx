'use client';

import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {ChevronRight,Clapperboard,Download,FileText,GitBranch,Home,Layers,NotebookPen,Palette,Scissors,UserRound,Workflow,Box,X} from 'lucide-react';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription,SheetClose} from '@/components/workbench/ui/sheet';
import {AtomikMark} from '@/components/AtomikMark';
import {Stage,STAGES} from '@/lib/workbench/studio';

const mobileQuery='(max-width: 759px)';
const subscribeMobile=(update:()=>void)=>{const query=window.matchMedia(mobileQuery);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)};
const mobileSnapshot=()=>window.matchMedia(mobileQuery).matches;
const desktopSnapshot=()=>false;
export function useMobileLayout(){return useSyncExternalStore(subscribeMobile,mobileSnapshot,desktopSnapshot);}

export function useMobileViewport(){useEffect(()=>{const viewport=window.visualViewport;const update=()=>{if(window.innerWidth>759||viewport&&viewport.scale!==1){document.documentElement.style.removeProperty('--app-visible-height');document.documentElement.style.removeProperty('--app-keyboard-inset');delete document.documentElement.dataset.mobileKeyboard;return;}const visible=viewport?.height||window.innerHeight;const inset=Math.max(0,window.innerHeight-visible-(viewport?.offsetTop||0));document.documentElement.style.setProperty('--app-visible-height',visible+'px');document.documentElement.style.setProperty('--app-keyboard-inset',inset+'px');document.documentElement.dataset.mobileKeyboard=inset>140?'true':'false';};update();viewport?.addEventListener('resize',update);viewport?.addEventListener('scroll',update);window.addEventListener('resize',update);return()=>{viewport?.removeEventListener('resize',update);viewport?.removeEventListener('scroll',update);window.removeEventListener('resize',update);document.documentElement.style.removeProperty('--app-visible-height');document.documentElement.style.removeProperty('--app-keyboard-inset');delete document.documentElement.dataset.mobileKeyboard;};},[]);}

export function MobilePanel({mobile,open,onOpenChange,title,description,kind='',children,style}:{mobile:boolean;open:boolean;onOpenChange:(v:boolean)=>void;title:string;description:string;kind?:string;children:React.ReactNode;style?:React.CSSProperties}){
 const [offset,setOffset]=useState(0);const start=useRef<number|null>(null);const moved=useRef(false);
 const [previousOpen,setPreviousOpen]=useState(open);
 if(previousOpen!==open){setPreviousOpen(open);setOffset(0);}
 if(!mobile)return open?<>{children}</>:null;
 return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="bottom" showCloseButton={false} className={'ps mobile-sheet mobile-sheet-'+kind} style={{...style,...(offset?{transform:`translateY(${offset}px)`,transition:'none'}:{})}}>
  <button className="mobile-sheet-grip" aria-label={'Close '+title} onPointerDown={e=>{start.current=e.clientY;moved.current=false;e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(start.current!==null){const distance=Math.max(0,e.clientY-start.current);if(distance>5)moved.current=true;setOffset(distance)}}} onPointerUp={()=>{start.current=null;if(offset>70)onOpenChange(false);setOffset(0)}} onPointerCancel={()=>{start.current=null;setOffset(0)}} onClick={()=>{if(!moved.current)onOpenChange(false)}}><span/></button>
  <SheetHeader className="mobile-sheet-heading">{kind==='atomik'&&<span className="phone-atomik-badge"><AtomikMark size={18}/></span>}<div><SheetTitle>{title}</SheetTitle><SheetDescription>{description}</SheetDescription></div><SheetClose asChild><button className="mobile-sheet-done" aria-label={'Close '+title}><X size={20}/></button></SheetClose></SheetHeader>
  <div className="mobile-sheet-body">{children}</div>
 </SheetContent></Sheet>;
}

const stageIcons:Record<Stage,typeof Box>={brief:NotebookPen,script:FileText,moodboard:Palette,characters:UserRound,elements:Box,'astra-blender':Box,canvas:GitBranch,storyboard:Clapperboard,assets:Layers,edit:Scissors,export:Download};
export function MobileNavigation({home,stage,onHome,onStage,projectName,projectDescription,actions,workflowOpen,onWorkflowOpen:setWorkflowOpen,disabled=false}:{home:boolean;stage:Stage;onHome:()=>void;onStage:(s:Stage)=>void;projectName:string;projectDescription?:string;actions?:React.ReactNode;workflowOpen:boolean;onWorkflowOpen:(open:boolean)=>void;disabled?:boolean}){
 const mobile=useMobileLayout();
 const workflowActive=!home&&!['canvas','assets','edit'].includes(stage);
 const waiting=!mobile||disabled;
 return <><nav className="mobile-app-nav" aria-label="Mobile studio navigation" aria-busy={waiting}>
  <button disabled={waiting} className={home?'active':''} aria-current={home?'page':undefined} onClick={onHome}><Home size={21}/><span>Home</span></button>
  <button disabled={waiting} className={workflowActive?'active':''} aria-expanded={workflowOpen} onClick={()=>setWorkflowOpen(true)}><Workflow size={21}/><span>Workflow</span></button>
  <button disabled={waiting} className={'mobile-canvas-tab '+(!home&&stage==='canvas'?'active':'')} aria-current={!home&&stage==='canvas'?'page':undefined} onClick={()=>onStage('canvas')}><span className="mobile-canvas-tab-icon"><GitBranch size={22}/></span><span>Canvas</span></button>
  <button disabled={waiting} className={!home&&stage==='assets'?'active':''} aria-current={!home&&stage==='assets'?'page':undefined} onClick={()=>onStage('assets')}><Layers size={21}/><span>Takes</span></button>
  <button disabled={waiting} className={!home&&stage==='edit'?'active':''} aria-current={!home&&stage==='edit'?'page':undefined} onClick={()=>onStage('edit')}><Scissors size={21}/><span>Edit</span></button>
 </nav><MobilePanel mobile={mobile} open={mobile&&workflowOpen} onOpenChange={setWorkflowOpen} title="Project workflow" description={projectName} kind="workflow"><div className="phone-workflow-intro"><span>WORKFLOW · {STAGES.length} STAGES</span><h1>{projectName}</h1><p>{projectDescription}</p></div><div className="phone-workflow-actions">{actions}</div><div className="mobile-workflow-list">{STAGES.map((s,i)=>{const Icon=stageIcons[s.id];return <React.Fragment key={s.id}>{[0,5,9].includes(i)&&<div className="mobile-workflow-section">{i===0?'Develop':i===5?'Create':'Finish'}<span>{i===0?'01 – 05':i===5?'06 – 09':'10 – 11'}</span></div>}<button className={!home&&stage===s.id?'current':''} onClick={()=>{onStage(s.id);setWorkflowOpen(false)}}><span className="mobile-workflow-number">{String(i+1).padStart(2,'0')}</span><span className="mobile-workflow-icon"><Icon size={20}/></span><span><strong>{s.label}</strong><small>{s.hint}</small></span>{!home&&stage===s.id&&<em>Current</em>}<ChevronRight size={17}/></button></React.Fragment>})}</div></MobilePanel></>;
}
