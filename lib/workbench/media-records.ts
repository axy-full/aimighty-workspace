import {db} from '@/lib/db';
import {workbenchReady} from './records';
import {sharedBoards} from '@/lib/draftProject';

/** A private upload becomes readable by this tenant only when its own uploader
 * published it. Another collaborator cannot grant access by guessing its URL. */
/** What a person is told when a file comes from a private board they cannot read (no board name, id or owner: they may not read it). */
export const PRIVATE_MEDIA = "This uses media from a private board. Ask its owner to share it.";

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

/**
 * The reason `findWorkbenchMedia` answered nothing, when it is that: the file is published in a bible, and every bible that publishes it belongs to a private board `viewer` cannot read.
 * Null for any other reason (no such file, never published): those stay "not found", as they were.
 */
export async function privateMediaMessage(id:string,viewer:string):Promise<string|null>{
 await workbenchReady();
 if(await findWorkbenchMedia(id,viewer))return null;
 const published=await db().execute({sql:`SELECT 1 FROM workbench_media m WHERE m.id=? AND m.owner<>? AND EXISTS (
   SELECT 1 FROM workbench_bibles b, json_each(b.body,'$.assets') a WHERE b.owner=m.owner AND json_extract(a.value,'$.url')=?
 ) LIMIT 1`,args:[id,viewer,'/api/workbench/media/'+id]});
 return published.rows.length?PRIVATE_MEDIA:null;
}
