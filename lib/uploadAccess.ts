import type { InStatement, ResultSet } from "@libsql/client";
import { db, ready } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { MediaSourceError, referencedMedia } from "./mediaBindings";
import { isAgentId } from "./security/people-only";

/**
 * Who may open an upload (its bytes, a thumbnail, its metadata, its place in a list). The tenant database already keeps every workspace to itself; inside
 * one, a member opens an upload only if:
 *
 *  (a) they uploaded it (`uploads.uploader_id`); or
 *  (b) it is on work shared with the team: the production's shared Rig canvas (`workbench_team_canvas`), a project's boards, a project's library filing; or
 *  (c) shared production work already shows it: a shot's setup, a take's references (`generations.params`, not deleted), a shared bible version
 *      (`workbench_bibles`), a cast member, an identity (cover and photos), a Soul identity's references, a shot preset, a catalog version of an
 *      attribute, or a team-chat message.
 *
 * Not shared work, so no grant: a private draft (`workbench_projects`, one person's) and everything filed or made inside one (a draft's own production
 * project, `prj_wb_…`: its library filings, takes, boards, shots, cast), edit versions, Atomik's own messages and steps. An upload only those use stays its
 * uploader's. Rows from before `uploader_id` that no record could name are unowned and stay open to the workspace's members, as they are today (an owner
 * decision to tighten later). Anything else is a 404 from the caller, never a 403, so nothing says the upload exists.
 *
 * Two halves, so that sharing cannot be forged: reads (this file) grant by what shared work holds; every writer that files or attaches an upload calls
 * `assertUploadsOpenable` first, so a member cannot attach someone else's private upload to shared work and then open it. A reference counts only where
 * the app itself writes one (`uploadId`, `sourceUploadId`, `coverUploadId`, or an `/api/uploads/<id>` value, as `referencedMedia` reads them), never a
 * stray mention of an id in a note.
 *
 * Narrow by design, no scan of boards in JS: relational links are indexed or small direct-column reads; JSON bodies are pre-filtered in SQL by a plain
 * substring test and the few rows that pass are parsed and checked exactly, smallest table first, the takes last. A yes is remembered for 30 s per
 * workspace and upload; a no is never remembered, so attaching an upload opens it at once. Lists use one set-based pass per request, not a check per row.
 */
const YES_MS = 30_000;
const yes = new Map<string, number>();
const MAX_YES = 5000;

type Exec = { execute(statement: InStatement): Promise<ResultSet> };
export type Viewer = { id: string; role?: string };

/** A draft's own production project (lib/workbench/records.ts › linkProduction): one person's, so nothing in it is shared. */
const SHARED_PROJECT = `(project_id IS NULL OR project_id NOT LIKE 'prj\\_wb\\_%' ESCAPE '\\')`;

type Source =
  | { table: string; direct: string; where?: string }
  | { table: string; json: string; where?: string; photos?: true };
/** In the order they are asked: the cheapest and smallest first. */
const SOURCES: readonly Source[] = [
  { table: "project_library_uploads", direct: "upload_id", where: SHARED_PROJECT },
  { table: "cast_members", direct: "upload_id", where: SHARED_PROJECT },
  { table: "attribute_versions", direct: "upload_id" },
  { table: "messages", direct: "upload_id" },
  { table: "identities", direct: "cover_upload_id", where: SHARED_PROJECT },
  { table: "shot_presets", direct: "cover_upload_id" },
  { table: "identities", json: "photos", photos: true, where: SHARED_PROJECT },
  { table: "shot_presets", json: "refs" },
  { table: "soul_identities", json: "references_json" },
  { table: "workbench_team_canvas", json: "body" },
  { table: "boards", json: "nodes", where: SHARED_PROJECT },
  { table: "workbench_bibles", json: "body" },
  { table: "shots", json: "setup", where: SHARED_PROJECT },
  { table: "generations", json: "params", where: `deleted=0 AND ${SHARED_PROJECT}` },
];

const missingTable = (error: unknown) => /no such table|no such column/i.test(String((error as Error)?.message));
const uploadsIn = (text: unknown, photos?: boolean): Set<string> => {
  try {
    const value = JSON.parse(String(text ?? "null"));
    return referencedMedia(photos && Array.isArray(value) ? value.map((uploadId) => ({ uploadId })) : value).uploads;
  } catch { return new Set(); }
};

/** Whether shared work uses upload `id` (one id: used by a single open). */
async function usedBySharedWork(ex: Exec, id: string): Promise<boolean> {
  for (const source of SOURCES) {
    try {
      if ("direct" in source) {
        if ((await ex.execute({ sql: `SELECT 1 FROM ${source.table} WHERE ${source.direct}=?${source.where ? ` AND ${source.where}` : ""} LIMIT 1`, args: [id] })).rows.length) return true;
      } else {
        const rows = (await ex.execute({ sql: `SELECT ${source.json} AS v FROM ${source.table} WHERE instr(${source.json},?)>0${source.where ? ` AND ${source.where}` : ""} LIMIT 25`, args: [id] })).rows;
        if (rows.some((row) => uploadsIn(row.v, source.photos).has(id))) return true;
      }
    } catch (error) {
      if (!missingTable(error)) throw error;
    }
  }
  return false;
}

/** The ids among `ids` that shared work uses: one pass per source for the whole set (a list, or a save that attaches several). */
async function sharedAmong(ex: Exec, ids: readonly string[]): Promise<Set<string>> {
  const used = new Set<string>();
  for (let start = 0; start < ids.length; start += 200) {
    const batch = ids.slice(start, start + 200);
    const marks = batch.map(() => "?").join(",");
    for (const source of SOURCES) {
      const open = batch.filter((id) => !used.has(id));
      if (!open.length) break;
      try {
        if ("direct" in source) {
          const rows = (await ex.execute({ sql: `SELECT DISTINCT ${source.direct} AS a FROM ${source.table} WHERE ${source.direct} IN (${marks})${source.where ? ` AND ${source.where}` : ""}`, args: batch })).rows;
          for (const row of rows) used.add(String(row.a));
        } else {
          /* The ids a body names under the keys the app writes, and every /api/uploads/ value (read exactly below). */
          const rows = (await ex.execute({
            sql: `SELECT DISTINCT j.atom AS a FROM ${source.table} t, json_tree(t.${source.json}) j
                  WHERE json_valid(t.${source.json})${source.where ? ` AND ${source.where.replace(/\bproject_id\b/g, "t.project_id").replace(/\bdeleted\b/g, "t.deleted")}` : ""}
                    AND j.type='text' AND ((j.atom IN (${marks}) AND ${"photos" in source ? "1" : "j.key IN ('uploadId','sourceUploadId','coverUploadId')"}) OR j.atom LIKE '/api/uploads/%')`,
            args: batch,
          })).rows;
          for (const row of rows) {
            const atom = String(row.a);
            if (atom.startsWith("/")) for (const found of uploadsIn(JSON.stringify(atom)).values()) used.add(found);
            else used.add(atom);
          }
        }
      } catch (error) {
        if (!missingTable(error)) throw error;
      }
    }
  }
  return used;
}

/** The person making this request: the workspace's signed-in user (a token or an agent identity too), or nobody (background work). */
export function currentViewer(): Viewer | null {
  const user = currentTenant()?.user;
  /* An Atomik run (`agent:…`) acts for a person who chose what it attaches; it is not asked here, and the person's own choice is checked where Atomik reads it. */
  return user && !isAgentId(user.id) ? { id: user.id, role: user.role } : null;
}

/** Which of `ids` the viewer may open, among those that exist in this workspace: one query for the uploaders, one pass per source for the rest. */
export async function openableAmong(ids: readonly string[], viewer: Viewer, ex: Exec = db()): Promise<Set<string>> {
  await ready();
  const wanted = [...new Set(ids)].filter((id) => id && id.length <= 200);
  const ok = new Set<string>();
  const rest: string[] = [];
  const workspace = requireTenant().id;
  for (let start = 0; start < wanted.length; start += 200) {
    const batch = wanted.slice(start, start + 200);
    const rows = (await ex.execute({ sql: `SELECT id,uploader_id FROM uploads WHERE id IN (${batch.map(() => "?").join(",")})`, args: batch })).rows;
    for (const row of rows) {
      const id = String(row.id);
      if (row.uploader_id == null || String(row.uploader_id) === viewer.id) ok.add(id);
      else if ((yes.get(`${workspace}:${id}`) ?? 0) > Date.now()) ok.add(id);
      else rest.push(id);
    }
  }
  if (rest.length) for (const id of await sharedAmong(ex, rest)) ok.add(id);
  return ok;
}

/** Whether `viewer` may open the upload `id` in the current workspace. Unknown ids and other people's private uploads answer false alike. */
export async function uploadOpenableBy(id: string, viewer: Viewer, ex: Exec = db()): Promise<boolean> {
  if (!id || id.length > 200) return false;
  await ready();
  const workspace = requireTenant().id;
  const row = (await ex.execute({ sql: "SELECT uploader_id FROM uploads WHERE id=? LIMIT 1", args: [id] })).rows[0];
  if (!row) return false;
  if (row.uploader_id == null || String(row.uploader_id) === viewer.id) return true;
  const key = `${workspace}:${id}`;
  if ((yes.get(key) ?? 0) > Date.now()) return true;
  if (await usedBySharedWork(ex, id)) {
    if (yes.size >= MAX_YES) yes.clear();
    yes.set(key, Date.now() + YES_MS);
    return true;
  }
  return false;
}

/**
 * Called by every writer that files or attaches an upload (a board, a shot's setup, the team canvas, a library filing, a chat message, a take's
 * references, a cast member, an identity), inside its own write: the writer must be able to open each upload it names. Refuses with the words a missing
 * upload gets, so a refusal says nothing about whether the upload exists. Background work with no signed-in person is not asked.
 */
export async function assertUploadsOpenable(ex: Exec, ids: Iterable<string>, viewer: Viewer | null = currentViewer()): Promise<void> {
  if (!viewer) return;
  const wanted = [...new Set(ids)];
  if (!wanted.length) return;
  const exists = new Set<string>();
  for (let start = 0; start < wanted.length; start += 200) {
    const batch = wanted.slice(start, start + 200);
    for (const row of (await ex.execute({ sql: `SELECT id FROM uploads WHERE id IN (${batch.map(() => "?").join(",")})`, args: batch })).rows) exists.add(String(row.id));
  }
  /* An id that does not exist is the caller's own "no longer available"; this only judges the ones that do. */
  const mine = await openableAmong([...exists], viewer, ex);
  if ([...exists].some((id) => !mine.has(id)))
    throw new MediaSourceError("A referenced upload is no longer available. Remove or replace it before saving.");
}
