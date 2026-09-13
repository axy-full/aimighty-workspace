import {db} from '@/lib/db';
import {workbenchReady} from './records';

/** A private upload becomes readable by this tenant only when its own uploader
 * published it. Another collaborator cannot grant access by guessing its URL. */
export async function findWorkbenchMedia(id:string,viewer:string){
 await workbenchReady();
 const rows=await db().execute({sql:`SELECT m.* FROM workbench_media m WHERE m.id=? AND (
   m.owner=? OR EXISTS (
     SELECT 1 FROM workbench_bibles b, json_each(b.body,'$.assets') a
     WHERE b.owner=m.owner AND json_extract(a.value,'$.url')=?
   )
 )`,args:[id,viewer,'/api/workbench/media/'+id]});
 return rows.rows[0]??null;
}
