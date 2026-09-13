import Studio from '@/components/workbench/Studio';
import {currentContext} from '@/lib/auth';
import {creditStateFor} from '@/lib/credits';
import './workbench.css';
import './desk.css';
import './mobile.css';
export const dynamic='force-dynamic';
export const viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#0B0D11'};
export const metadata={title:'Particl — Production Studio'};
export default async function Workbench(){
 const ctx=await currentContext();
 const initialAccount=ctx?{name:ctx.user.name,workspace:ctx.workspace?{id:ctx.workspace.id,name:ctx.workspace.name}:null,workspaces:ctx.workspaces,credits:ctx.workspace?await creditStateFor(ctx.workspace).catch(()=>null):null}:null;
 return <Studio initialAccount={initialAccount} apiBase="/api/workbench" sourceMode signedIn={!!ctx?.workspace} storageKey={'particl-active-'+(ctx?.workspace?.id||'visitor')+'-'+(ctx?.user.id||'visitor')}/>;
}
