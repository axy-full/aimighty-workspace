import {withTenant,requireUser} from '@/lib/auth';
import {readUploadBytes} from '@/lib/storage';
import {servingFor} from '@/lib/serveType';
import {findWorkbenchMedia} from '@/lib/workbench/media-records';

export const GET=withTenant(async(req:Request,{params}:{params:Promise<{id:string}>})=>{
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;
 const row=await findWorkbenchMedia(id,auth.user.id);
 if(!row)return new Response('Not found',{status:404});
 const bytes=await readUploadBytes(id,String(row.ext),String(row.stored_url));
 const size=bytes.byteLength;
 const serving=servingFor(String(row.mime));
 const headers=new Headers({'Content-Type':serving.contentType,'Content-Length':String(size),'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'});
 if(!serving.inline)headers.set('Content-Disposition','attachment; filename="reference"');
 const range=req.headers.get('range');
 if(range){
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid=()=>new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
  if(!match||(!match[1]&&!match[2]))return invalid();
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size||start<0)return invalid();
  headers.set('Content-Range',`bytes ${start}-${end}/${size}`);headers.set('Content-Length',String(end-start+1));
  return new Response(new Uint8Array(bytes.subarray(start,end+1)),{status:206,headers});
 }
 return new Response(new Uint8Array(bytes),{headers});
});
