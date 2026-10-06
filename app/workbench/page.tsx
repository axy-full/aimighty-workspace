import Studio from '@/components/workbench/Studio';
import {enterSuites,type RawSearch} from '@/lib/workspace/switchover.server';
import {redirect} from 'next/navigation';
import {currentContext} from '@/lib/auth';
import {creditStateFor} from '@/lib/credits';
import {accountScopeFor,workbenchScopeFor} from '@/lib/workbench/request-scope';
import './workbench.css';
import './desk.css';
import './mobile.css';
import './graphite.css';
import './editorial-graphite.css';
import './phone-layout.css';
import './phone-stages.css';
import './project-first.css';
import '@/components/studio/project-navigation.css';
import '@/components/suites/four-suites.css';
export const dynamic='force-dynamic';
export const viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#000000'};
export const metadata={title:'Particl — Studio'};
export default async function Workbench({searchParams}:{searchParams:Promise<RawSearch>}){
 const ctx=await currentContext();
 if(ctx?.mfaRequired)redirect('/account/security');
 /* Everyone goes to the Suites shell. Only a signed-in account with no workspace stays: /suites sends exactly that
    account here, so redirecting it back would loop. */
 await enterSuites('/workbench',await searchParams,ctx);
 const initialAccount=ctx?{name:ctx.user.name,workspace:ctx.workspace?{id:ctx.workspace.id,name:ctx.workspace.name}:null,workspaces:ctx.workspaces,credits:ctx.workspace?await creditStateFor(ctx.workspace).catch(()=>null):null}:null;
 const scope=ctx?ctx.workspace?workbenchScopeFor(ctx.workspace.id,ctx.user.id):accountScopeFor(ctx.user.id):'particl-visitor';
 return <Studio key={scope} initialAccount={initialAccount} apiBase="/api/workbench" sourceMode signedIn={!!ctx?.workspace} storageKey={scope}/>;
}
