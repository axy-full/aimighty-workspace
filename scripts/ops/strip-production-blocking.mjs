#!/usr/bin/env node
/*
 * Takes an additive project field out of stored project bodies, for a rollback past the build that accepts it, and puts it back. A build from before
 * the field rejects any project body that holds it (its project schema is strict), so such a project could not be saved until the field is gone.
 * Fields (--field=<name>, default blocking):
 *   blocking         `production.blocking`, 3D blocking per shot (part A)
 *   scriptVersions   `scriptVersions`, the earlier scripts a replaced script is kept as
 *
 * IT NEVER ERASES. Before a value is removed from a body, it is copied into the additive table `workbench_blocking_archive` in the SAME
 * database (created on the first write if missing: no other table, column or row is changed; each copy says which field it holds). `--restore` puts archived values back.
 *
 * DRY RUN BY DEFAULT, in both modes: it reads, prints the database HOST (never a token, path or password) and COUNTS ONLY, and writes
 * nothing. It writes only when BOTH are given, which is the owner's yes:   --apply   --owner-said-yes
 *   strip   (default mode)   per project that holds the field: archive the value, then remove it from the body and bump the revision by one
 *   --restore                per archived value not yet restored, whose project no longer holds the field: put it back and bump the revision
 * A row is only ever written if it is still the revision that was read (a save that landed meanwhile is never overwritten; it is found on the
 * next run), and the archive copy and the body change happen in one transaction, so there is never a removal without its copy. Rows are never
 * deleted. Frames filed from blocking stay as ordinary reference inputs and Library files.
 *
 * One database per run (each workspace has its own):
 *   STRIP_BLOCKING_DB_URL=<libsql url or file: path> STRIP_BLOCKING_DB_TOKEN=<token, if any> node scripts/ops/strip-production-blocking.mjs [--field=blocking|scriptVersions] [--restore] [--apply --owner-said-yes]
 * Nothing about a project (its name, id, text) is printed.
 */
import { createClient } from "@libsql/client";

const ARCHIVE = "workbench_blocking_archive";
const apply = process.argv.includes("--apply");
const yes = process.argv.includes("--owner-said-yes");
const restore = process.argv.includes("--restore");
const FIELDS = { blocking: ["production", "blocking"], scriptVersions: ["scriptVersions"] };
const fieldArg = process.argv.find((a) => a.startsWith("--field="))?.slice(8) ?? "blocking";
if (!Object.hasOwn(FIELDS, fieldArg)) { console.error(`--field must be one of: ${Object.keys(FIELDS).join(", ")}. Nothing was read.`); process.exit(2); }
const FIELD = fieldArg;
const PATH = FIELDS[FIELD];
const getField = (body) => PATH.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), body);
const withoutField = (body) => {
  if (PATH.length === 1) { const { [PATH[0]]: _gone, ...rest } = body; return rest; }
  const { [PATH[1]]: _gone, ...inner } = body[PATH[0]]; return { ...body, [PATH[0]]: inner };
};
const withField = (body, value) => (PATH.length === 1 ? { ...body, [PATH[0]]: value } : { ...body, [PATH[0]]: { ...(body[PATH[0]] ?? {}), [PATH[1]]: value } });
const count = (value) => (Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0);
const url = process.env.STRIP_BLOCKING_DB_URL;
if (!url) { console.error("Set STRIP_BLOCKING_DB_URL to the database to read."); process.exit(2); }
if (apply && !yes) { console.error("--apply also needs --owner-said-yes. Nothing was written."); process.exit(2); }
const writing = apply && yes;

/** The database's host, or its kind for a local file: enough to tell which database this is, and nothing secret. */
function whereIs(value) {
  try { const u = new URL(value); return u.protocol === "file:" ? "a local file" : u.host; } catch { return "an unreadable address"; }
}

const db = createClient({ url, authToken: process.env.STRIP_BLOCKING_DB_TOKEN });
console.log(`Database host: ${whereIs(url)}. Field: ${FIELD}`);
let read = 0, holding = 0, entries = 0, unreadable = 0, changed = 0, archived = 0, skipped = 0;
try {
  const archiveExists = (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [ARCHIVE] })).rows.length > 0;
  if (writing && !archiveExists) {
    await db.execute(`CREATE TABLE IF NOT EXISTS ${ARCHIVE} (id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, revision_before INTEGER NOT NULL, blocking_json TEXT NOT NULL, archived_at INTEGER NOT NULL, restored_at INTEGER, field TEXT NOT NULL DEFAULT 'blocking')`);
  }
  const tableNow = writing || archiveExists;

  if (!restore) {
    const rows = (await db.execute("SELECT key, body, revision FROM workbench_projects")).rows;
    for (const row of rows) {
      read++;
      let body;
      try { body = JSON.parse(String(row.body)); } catch { unreadable++; continue; }
      const blocking = getField(body);
      if (blocking === undefined) continue;
      holding++;
      entries += count(blocking);
      if (!writing) continue;
      const tx = await db.transaction("write");
      try {
        await tx.execute({ sql: `INSERT INTO ${ARCHIVE} (project_key, revision_before, blocking_json, archived_at, field) VALUES (?, ?, ?, ?, ?)`, args: [row.key, row.revision, JSON.stringify(blocking), Date.now(), FIELD] });
        const result = await tx.execute({
          sql: "UPDATE workbench_projects SET body = ?, revision = revision + 1, updated_at = ? WHERE key = ? AND revision = ?",
          args: [JSON.stringify(withoutField(body)), Date.now(), row.key, row.revision],
        });
        if (result.rowsAffected === 1) { await tx.commit(); changed++; archived++; } else { await tx.rollback(); skipped++; }
      } catch (error) { await tx.rollback().catch(() => {}); throw error; }
    }
    console.log(`${writing ? "APPLIED" : "DRY RUN (nothing written)"}: ${read} projects read, ${holding} hold the field (${entries} entries), ${unreadable} unreadable${writing ? `, ${archived} copied to ${ARCHIVE}, ${changed} rewritten without it, ${skipped} changed meanwhile and left` : ""}`);
  } else {
    const pending = tableNow ? (await db.execute({ sql: `SELECT id, project_key, blocking_json FROM ${ARCHIVE} WHERE restored_at IS NULL AND field = ? ORDER BY id`, args: [FIELD] })).rows : [];
    for (const item of pending) {
      read++;
      const row = (await db.execute({ sql: "SELECT body, revision FROM workbench_projects WHERE key = ?", args: [item.project_key] })).rows[0];
      let body;
      try { body = row ? JSON.parse(String(row.body)) : null; } catch { body = null; }
      /* Only into a project that is still there and holds no blocking now: what a person has made since is never overwritten. */
      if (!row || !body || getField(body) !== undefined) { skipped++; continue; }
      let value;
      try { value = JSON.parse(String(item.blocking_json)); } catch { unreadable++; continue; }
      holding++;
      entries += count(value);
      if (!writing) continue;
      const tx = await db.transaction("write");
      try {
        const result = await tx.execute({
          sql: "UPDATE workbench_projects SET body = ?, revision = revision + 1, updated_at = ? WHERE key = ? AND revision = ?",
          args: [JSON.stringify(withField(body, value)), Date.now(), item.project_key, row.revision],
        });
        if (result.rowsAffected === 1) { await tx.execute({ sql: `UPDATE ${ARCHIVE} SET restored_at = ? WHERE id = ?`, args: [Date.now(), item.id] }); await tx.commit(); changed++; } else { await tx.rollback(); skipped++; }
      } catch (error) { await tx.rollback().catch(() => {}); throw error; }
    }
    console.log(`${writing ? "RESTORED" : "DRY RUN (nothing written)"}: ${pending.length} archived values waiting, ${holding} can be put back (${entries} entries), ${skipped} left (project gone or holds blocking now), ${unreadable} unreadable${writing ? `, ${changed} restored` : ""}`);
  }
} finally { db.close(); }
