import { db, ready } from "./db";
import { requireTenant } from "./tenant";

/**
 * Who may open an upload (its bytes, a thumbnail, its metadata). The tenant database already keeps every workspace to itself; inside one, a member opens
 * an upload only if:
 *
 *  (a) they uploaded it (`uploads.uploader_id`); or
 *  (b) it is on work shared with the team: the production's shared Rig canvas (`workbench_team_canvas`), a project's boards, a project's library filing; or
 *  (c) shared production work already shows it: a shot's setup, a take's references (`generations.params`, not deleted), a shared bible version
 *      (`workbench_bibles`), a cast member, an identity (cover and photos), a shot preset or a catalog version of an attribute, or a team-chat message.
 *
 * Not shared work, so no grant: a private draft (`workbench_projects`, one person's), an edit version, Atomik's own messages and steps. An upload only
 * those use stays its uploader's. Rows from before `uploader_id` that no record could name are unowned: an admin's alone, unless shared work uses them.
 * Anything else is a 404 from the caller, never a 403, so nothing says the upload exists.
 *
 * Narrow by design, no scan of boards in JS: the relational links are indexed or small direct-column lookups; the JSON bodies are tested in SQL with a plain
 * substring match on the id (ids are long and random, so a match is a reference) and only after the cheaper checks have said no, smallest table first,
 * the takes last. A yes is remembered for 30 s per workspace and upload; a no is never remembered, so attaching an upload opens it at once.
 */
const YES_MS = 30_000;
const yes = new Map<string, number>();
const MAX_YES = 5000;

/** Each check answers 1 when shared work uses the id (`?`). A table this database does not have yet (they are made on first use) says no. */
const SHARED_WORK: readonly string[] = [
  "SELECT 1 FROM project_library_uploads WHERE upload_id=? LIMIT 1",
  "SELECT 1 FROM cast_members WHERE upload_id=? LIMIT 1",
  "SELECT 1 FROM identities WHERE cover_upload_id=? OR instr(photos,?)>0 LIMIT 1",
  "SELECT 1 FROM shot_presets WHERE cover_upload_id=? OR instr(refs,?)>0 LIMIT 1",
  "SELECT 1 FROM attribute_versions WHERE upload_id=? LIMIT 1",
  "SELECT 1 FROM messages WHERE upload_id=? LIMIT 1",
  "SELECT 1 FROM workbench_team_canvas WHERE instr(body,?)>0 LIMIT 1",
  "SELECT 1 FROM boards WHERE instr(nodes,?)>0 LIMIT 1",
  "SELECT 1 FROM workbench_bibles WHERE instr(body,?)>0 LIMIT 1",
  "SELECT 1 FROM shots WHERE instr(setup,?)>0 LIMIT 1",
  "SELECT 1 FROM generations WHERE deleted=0 AND instr(params,?)>0 LIMIT 1",
];

async function usedBySharedWork(id: string): Promise<boolean> {
  for (const sql of SHARED_WORK) {
    try {
      const marks = sql.split("?").length - 1;
      if ((await db().execute({ sql, args: Array(marks).fill(id) })).rows.length) return true;
    } catch (error) {
      if (!/no such table|no such column/i.test(String((error as Error)?.message))) throw error;
    }
  }
  return false;
}

/** Whether `viewer` may open the upload `id` in the current workspace. Unknown ids and other people's private uploads answer false alike. */
export async function uploadOpenableBy(id: string, viewer: { id: string; role: string }): Promise<boolean> {
  if (!id || id.length > 200) return false;
  await ready();
  const workspace = requireTenant().id;
  const row = (await db().execute({ sql: "SELECT uploader_id FROM uploads WHERE id=? LIMIT 1", args: [id] })).rows[0];
  if (!row) return false;
  if (row.uploader_id != null && String(row.uploader_id) === viewer.id) return true;
  const key = `${workspace}:${id}`;
  const until = yes.get(key);
  if (until && until > Date.now()) return true;
  if (await usedBySharedWork(id)) {
    if (yes.size >= MAX_YES) yes.clear();
    yes.set(key, Date.now() + YES_MS);
    return true;
  }
  /* Unowned (from before uploaders were recorded) and on no shared work: an admin's. */
  return row.uploader_id == null && viewer.role === "admin";
}
