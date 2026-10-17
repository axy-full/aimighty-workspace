import { db, ready } from "./db";
import { currentTenant } from "./tenant";
import { newInterfaceFor } from "./newInterface.server";
import {
  assignHandles, isLibraryKind, libraryKindOf, originOf,
  type FirstVersion, type HandleCandidate, type LibraryKind, type LibraryOrigin, type LibraryStatus,
} from "./elementLibrary";

/**
 * The v30 Library's rows (docs/plans/v30-data-model.md § 6, PR A5), behind the switch `V30_LIBRARY`.
 *
 * Every query goes through db(), the database of the workspace in scope, which throws when there is none. Handles are
 * unique per workspace because the database is the workspace's: the same handle in another workspace is another
 * database's row, and nothing here can reach it.
 *
 * Nothing here changes how `@Name` resolves: lib/cast.ts › expandCast reads `cast_members`, and this file writes only the
 * four new `elements` columns. `elements.kind` is never written, so Rig reads every element exactly as before.
 */

/** The switch: `V30_LIBRARY=1` in server config, and then only for the house workspace (or one the platform owner
 *  lists for the new interface), the lib/newInterface.ts rule. Off means no row is written and nothing is read. */
export async function v30LibraryOn(workspace = currentTenant()?.workspace): Promise<boolean> {
  if (process.env.V30_LIBRARY !== "1") return false;
  return newInterfaceFor(workspace);
}

/* Created after the rows are filled, in the same write: an incomplete fill can never leave two rows one handle and
   then fail the index on every later boot. Partial, because an element made since the last fill has no handle yet. */
const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_elements_handle ON elements(LOWER(handle)) WHERE handle IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_elements_library_kind ON elements(library_kind)`,
];
const indexed = new WeakSet<object>();

export type LibraryFill = { handles: number; kinds: number; origins: number; statuses: number };

type Row = {
  id: string; project_id: string | null; kind: string | null; name: string | null; from_gen_id: string | null;
  handle: string | null; library_kind: string | null; origin: string | null; library_status: string | null;
};

async function fillOnce(): Promise<LibraryFill> {
  const c = db();
  /* Workspace-wide elements first, then the oldest: the order the first holder of a handle is decided in. */
  const rows = (await c.execute(
    `SELECT id, project_id, kind, name, from_gen_id, handle, library_kind, origin, library_status
       FROM elements ORDER BY (project_id IS NOT NULL), created_at, id`,
  )).rows as unknown as Row[];
  const pending = rows.filter((r) => r.handle == null || r.library_kind == null || r.origin == null || r.library_status == null);
  const done: LibraryFill = { handles: 0, kinds: 0, origins: 0, statuses: 0 };
  if (!pending.length) {
    if (!indexed.has(c)) { await c.batch(INDEXES, "write"); indexed.add(c); }
    return done;
  }

  const kindOf = (r: Row): LibraryKind =>
    r.library_kind != null && isLibraryKind(r.library_kind) ? r.library_kind : libraryKindOf(String(r.kind ?? "character"));

  const candidates: HandleCandidate[] = pending
    .filter((r) => r.handle == null)
    .map((r) => ({ id: String(r.id), name: String(r.name ?? ""), libraryKind: kindOf(r) }));
  const handles = assignHandles(candidates, rows.flatMap((r) => (r.handle == null ? [] : [String(r.handle)])));

  /* The first version each element was given, for the ones whose origin is not yet written. */
  const firsts = new Map<string, FirstVersion>();
  if (pending.some((r) => r.origin == null)) {
    const versions = await c.execute(
      `SELECT element_id, upload_id, gen_id, identity_id FROM attribute_versions
        WHERE element_id IN (SELECT id FROM elements WHERE origin IS NULL)
        ORDER BY created_at, rowid`,
    );
    for (const v of versions.rows as unknown as { element_id: string; upload_id: string | null; gen_id: string | null; identity_id: string | null }[]) {
      const key = String(v.element_id);
      if (!firsts.has(key)) firsts.set(key, { uploadId: v.upload_id ?? null, genId: v.gen_id ?? null, identityId: v.identity_id ?? null });
    }
  }

  /* COALESCE: a column someone else filled since the read keeps its value; nothing already written is rewritten. A
     handle another fill gave a different row in the meantime fails the unique index, the whole write rolls back, and
     fillLibrary reads again. updated_at is left alone: filing is not an edit. */
  const statements = pending.map((r) => {
    const handle = r.handle == null ? handles.get(String(r.id)) ?? null : null;
    const kind: LibraryKind | null = r.library_kind == null ? kindOf(r) : null;
    const origin: LibraryOrigin | null = r.origin == null ? originOf(r.from_gen_id ?? null, firsts.get(String(r.id)) ?? null) : null;
    const status: LibraryStatus | null = r.library_status == null ? "active" : null;   // every element is usable today
    if (handle) done.handles++;
    if (kind) done.kinds++;
    if (origin) done.origins++;
    if (status) done.statuses++;
    return {
      sql: `UPDATE elements SET handle = COALESCE(handle, ?), library_kind = COALESCE(library_kind, ?),
              origin = COALESCE(origin, ?), library_status = COALESCE(library_status, ?) WHERE id = ?`,
      args: [handle, kind, origin, status, String(r.id)],
    };
  });
  await c.batch([...statements, ...INDEXES], "write");
  indexed.add(c);
  return done;
}

/**
 * Fill the Library's columns on every element that is missing any of them. The one-time backfill and the catch-up for
 * elements made since are the same call: it only ever fills NULLs, so running it twice, or after a crash, or beside
 * people at work, finishes the job and changes nothing already written. Callers check v30LibraryOn first.
 */
export async function fillLibrary(): Promise<LibraryFill> {
  await ready();
  try {
    return await fillOnce();
  } catch (e) {
    /* Another fill won a handle between our read and our write. Read again, once. */
    if (!/unique|constraint/i.test(e instanceof Error ? e.message : String(e))) throw e;
    return await fillOnce();
  }
}

export type LibraryElement = {
  id: string;
  projectId: string | null;
  name: string;
  handle: string;
  libraryKind: LibraryKind;
  origin: LibraryOrigin;
  status: LibraryStatus;
};

/** This production's Library and the workspace-wide one, or null while the switch is off for this workspace. */
export async function listLibrary(projectId?: string | null): Promise<LibraryElement[] | null> {
  if (!(await v30LibraryOn())) return null;
  await fillLibrary();
  const sql = `SELECT id, project_id, name, handle, library_kind, origin, library_status FROM elements
                WHERE handle IS NOT NULL${projectId ? " AND (project_id = ? OR project_id IS NULL)" : ""}
                ORDER BY library_kind, LOWER(handle)`;
  const rs = await db().execute({ sql, args: projectId ? [projectId] : [] });
  return (rs.rows as unknown as Row[]).map((r) => ({
    id: String(r.id),
    projectId: r.project_id ?? null,
    name: String(r.name ?? ""),
    handle: String(r.handle),
    libraryKind: isLibraryKind(r.library_kind) ? r.library_kind : "character",
    origin: r.origin === "generated" ? "generated" : "uploaded",
    status: r.library_status === "draft" ? "draft" : "active",
  }));
}
