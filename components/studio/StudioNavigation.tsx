"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {Suspense} from "react";
import { Clapperboard, ScanLine, Building2, FolderOpen, Menu, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from "@/components/workbench/ui/sheet";
import { useMobileLayout } from "@/components/workbench/mobile-ui";
import { Mark } from "@/components/ui/Mark";
import WorkspaceMenu, { type WorkbenchAccount } from "@/components/workbench/WorkspaceMenu";
import { clearPrivateLocal } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import "./studio-navigation.css";

type Section = "studio" | "gen" | "assets" | "workspace";
const SECTIONS = [
  { id: "studio", label: "Studio", href: "/workbench", icon: Clapperboard },
  { id: "gen", label: "Gen", href: "/generate", icon: ScanLine },
  { id: "assets", label: "Library", href: "/library", icon: FolderOpen },
  { id: "workspace", label: "Workspace", href: "/settings", icon: Building2 },
] as const;

function sectionFor(path: string): Section {
  if (path === "/library" || path.startsWith("/library/")) return "assets";
  if (path === "/generate" || path.startsWith("/make/")) return "gen";
  return /^\/(settings|team|billing|usage|statements)(\/|$)/.test(path) ? "workspace" : "studio";
}

async function changeAccount(scopedFetch: ReturnType<typeof useScopedFetch>, action: "switch" | "logout", id?: string) {
  await withPageLeaveGuard(async () => {
  const response = await scopedFetch(action === "switch" ? "/api/workspaces/switch" : "/api/auth/logout", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action === "switch" ? { id } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Your account could not be changed. Please try again.");
  }
  clearPrivateLocal();
  window.location.assign(action === "switch" ? "/workbench" : "/login");
  });
}

function useSectionFollow(onNavigate?: (path: string) => Promise<void>) {
  const [error, setError] = useState("");
  function follow(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setError("");
    void onNavigate(href).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not open this section."));
  }
  return { error, follow };
}

export function StudioSections({ active, onNavigate, className = "" }: {
  active?: Section;
  onNavigate?: (path: string) => Promise<void>;
  className?: string;
}) {
  const path = usePathname();
  const current = active ?? sectionFor(path);
  const { error, follow } = useSectionFollow(onNavigate);
  return <nav className={`studio-sections${className ? ` ${className}` : ""}`} aria-label="Studio sections">
    {SECTIONS.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={current === id ? "page" : undefined} onClick={e => follow(e, href)}>
      <Icon size={15} strokeWidth={1.6} /><span>{label}</span>
    </Link>)}
    {error && <p className="studio-navigation-error studio-sections-error" role="alert">{error}</p>}
  </nav>;
}

export default function StudioNavigation({ initialAccount, active, compact = false, hideSections = false, onNavigate, onSwitch, onSignOut, requestScope, children }: {
  initialAccount: WorkbenchAccount | null;
  children?: ReactNode;
  active?: Section;
  compact?: boolean;
  hideSections?: boolean;
  onNavigate?: (path: string) => Promise<void>;
  onSwitch?: (id: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
  requestScope?: string | null;
}) {
  const scopedFetch = useScopedFetch(requestScope);
  const router = useRouter();
  const { error, follow } = useSectionFollow(onNavigate);
  const navigate = onNavigate ?? (async (href: string) => { await withPageLeaveGuard(() => { router.push(href); }); });
  const mobile = useMobileLayout();
  return (
    <div className={`studio-navigation${compact ? " studio-navigation-compact" : ""}`}>
      {mobile && !compact && <MobileStudioMenu initialAccount={initialAccount} active={active} onNavigate={navigate} onSwitch={onSwitch ?? (id => changeAccount(scopedFetch, "switch", id))} onSignOut={onSignOut ?? (() => changeAccount(scopedFetch, "logout"))} />}
      {!compact && <Link className="studio-navigation-brand" href="/workbench" aria-label="Particl home" onClick={e => follow(e, "/workbench")}>
        <Mark width={30} height={22} />
        <Image src="/brand/particl-wordmark-on-dark@4x.png" alt="particl" width={103} height={31} priority />
      </Link>}
      {!hideSections && <StudioSections active={active} onNavigate={onNavigate} />}
      {children}
      <WorkspaceMenu initial={initialAccount} onNavigate={navigate} onSwitch={onSwitch ?? (id => changeAccount(scopedFetch, "switch", id))} onSignOut={onSignOut ?? (() => changeAccount(scopedFetch, "logout"))} />
      {error && <p className="studio-navigation-error" role="alert">{error}</p>}
    </div>
  );
}

export function MobileStudioMenu({ initialAccount, active, onNavigate, onSwitch, onSignOut, projectId }: {
  initialAccount: WorkbenchAccount | null;
  projectId?: string;
  active?: Section;
  onNavigate: (path: string) => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const menuSections=projectId?[{id:"studio",label:"Workflow",href:`/workbench?project=${encodeURIComponent(projectId)}`,icon:Clapperboard},{id:"gen",label:"Gen",href:`/generate?project=${encodeURIComponent(projectId)}`,icon:ScanLine},{id:"assets",label:"Library",href:`/library?project=${encodeURIComponent(projectId)}`,icon:FolderOpen},{id:"workspace",label:"Project workspace",href:`/workbench?project=${encodeURIComponent(projectId)}&view=workspace`,icon:Building2}]:[{id:"studio",label:"Projects",href:"/workbench",icon:Clapperboard},{id:"assets",label:"All assets",href:"/library?all=1",icon:FolderOpen},{id:"workspace",label:"Account & workspace",href:"/settings",icon:Building2}];
  const path = usePathname();
  const current = active ?? sectionFor(path);
  const [error, setError] = useState("");
  async function leave(action: () => Promise<void>) {
    setOpen(false);
    setError("");
    // Release the drawer's modal layer before any unsaved-work confirmation.
    try { await action(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change workspace.");
      setOpen(true);
    }
  }
  const follow = (href: string) => leave(() => onNavigate(href));
  return <><button className="phone-menu-trigger" aria-label="Open workspace navigation" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={20}/></button>
    <Sheet open={open} onOpenChange={setOpen}><SheetContent side="left" showCloseButton={false} className="phone-workspace-drawer">
      <SheetHeader><SheetTitle><Mark width={25} height={22}/><span>Particl</span></SheetTitle><SheetDescription>Your production workspace</SheetDescription><SheetClose className="phone-drawer-close" aria-label="Close workspace navigation"><X size={20}/></SheetClose></SheetHeader>
      <nav className="studio-sections phone-drawer-sections" aria-label="Studio sections">{menuSections.map(({id,label,href,icon:Icon})=><button key={id} type="button" aria-current={current===id?'page':undefined} onClick={()=>void follow(href)}><Icon size={19} strokeWidth={1.6}/><span>{label}</span></button>)}</nav>{error&&<p className="studio-menu-error" role="alert">{error}</p>}
      <div className="phone-drawer-account"><p>{initialAccount?.workspace?.name || "Your workspace"}</p><small>{initialAccount?.workspaces.find(w => w.id === initialAccount.workspace?.id)?.role || "Account"} · Workspace</small><WorkspaceMenu initial={initialAccount} onNavigate={follow} onSwitch={id=>leave(()=>onSwitch(id))} onSignOut={()=>leave(onSignOut)}/></div>
    </SheetContent></Sheet>
  </>;
}

export function StudioDock() {return <Suspense><ProjectDock/></Suspense>;}
function ProjectDock() {
 const path=usePathname(),params=useSearchParams();
 const project=params.get('project');
 const projectRoute=(url:string,view?:string)=>url+'?'+new URLSearchParams({...project?{project}:{},...view?{view}:{}});
 const entries=[
  {label:'Workflow',href:projectRoute('/workbench'),icon:Clapperboard,active:false},
  {label:'Gen',href:projectRoute('/generate'),icon:ScanLine,active:path.startsWith('/generate')||path.startsWith('/make')},
  {label:'Library',href:projectRoute('/library'),icon:FolderOpen,active:path==='/library'&&params.get('all')!=='1'},
  {label:'Workspace',href:projectRoute('/workbench','workspace'),icon:Building2,active:false},
 ];
 return <nav className="studio-section-dock" aria-label="Project tools">{entries.map(({label,href,icon:Icon,active})=><Link key={label} href={href} onClick={e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();void withPageLeaveGuard(()=>window.location.assign(href));}} aria-current={active?'page':undefined}><Icon size={21}/><span>{label}</span></Link>)}</nav>;
}
