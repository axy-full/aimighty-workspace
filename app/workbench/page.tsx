import Studio from '@/components/workbench/Studio';
import SwitchoverGate from '@/components/switchover/SwitchoverGate';
import {switchoverTargetFor,type RawSearch} from '@/lib/workspace/switchover.server';
import {redirect} from 'next/navigation';
import {currentContext} from '@/lib/auth';
import {creditStateFor} from '@/lib/credits';
import {accountScopeFor,workbenchScopeFor} from '@/lib/workbench/request-scope';
import './workbench.css';
import './desk.css';
import './mobile.css';
import './graphite.css';
import './editorial-graphite.css';
import './mobile-handoff.css';
import './mobile-handoff-stages.css';
import './project-first.css';
import '@/components/studio/project-navigation.css';
import '../four-suites.css';
export const dynamic='force-dynamic';
export const viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#000000'};
export const metadata={title:'Particl — Production Studio'};
export default async function Workbench({searchParams}:{searchParams:Promise<RawSearch>}){
 const ctx=await currentContext();
 if(ctx?.mfaRequired)redirect('/account/security');
 const initialAccount=ctx?{name:ctx.user.name,workspace:ctx.workspace?{id:ctx.workspace.id,name:ctx.workspace.name}:null,workspaces:ctx.workspaces,credits:ctx.workspace?await creditStateFor(ctx.workspace).catch(()=>null):null}:null;
 const scope=ctx?ctx.workspace?workbenchScopeFor(ctx.workspace.id,ctx.user.id):accountScopeFor(ctx.user.id):'particl-visitor';
 /* The switch-over. Signed-out visitors are never switched: /workspace sends
    anyone without a workspace back here, so the two would bounce forever. */
 const {target,search}=await switchoverTargetFor('/workbench',await searchParams);
 return <SwitchoverGate target={target} search={search} hasWorkspace={Boolean(ctx?.workspace)}>
  <Studio key={scope} initialAccount={initialAccount} apiBase="/api/workbench" sourceMode signedIn={!!ctx?.workspace} storageKey={scope}/>
 </SwitchoverGate>;
}
