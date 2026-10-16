import {db} from '@/lib/db';
import {workbenchReady} from './records';
import {sharedBoards} from '@/lib/draftProject';

/** A private upload becomes readable by this tenant only when its own uploader
 * published it. Another collaborator cannot grant access by guessing its URL. */
export async function findWorkbenchMedia(id:string,viewer:string){
 await workbenchReady();
 /* A bible version published for a private board's own production project is read only by people who can read that board: its author, or anyone once the board is shared (lib/draftProject.ts). */
 const shared=(await sharedBoards()).projects;
 const rows=await db().execute({sql:`SELECT m.* FROM workbench_media m WHERE m.id=? AND (
   m.owner=? OR EXISTS (
     SELECT 1 FROM workbench_bibles b, json_each(b.body,'$.assets') a
     WHERE b.owner=m.owner AND json_extract(a.value,'$.url')=?
       AND (b.project_id NOT GLOB 'prj_wb_*' OR b.project_id IN (SELECT value FROM json_each(?)))
   )
 )`,args:[id,viewer,'/api/workbench/media/'+id,JSON.stringify(shared)]});
 return rows.rows[0]??null;
}
