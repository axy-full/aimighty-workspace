import Studio from '@/components/workbench/Studio';
import {currentContext} from '@/lib/auth';
import './workbench.css';
import './desk.css';
import './mobile.css';
export const dynamic='force-dynamic';
export const viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#0B0D11'};
export const metadata={title:'Particl — Production Studio'};
export default async function Workbench(){
 const ctx=await currentContext();
 return <Studio apiBase="/api/workbench" sourceMode signedIn={!!ctx?.workspace} storageKey={'particl-active-'+(ctx?.workspace?.id||'visitor')+'-'+(ctx?.user.id||'visitor')}/>;
}
