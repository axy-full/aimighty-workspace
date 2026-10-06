#!/usr/bin/env node
/*
 * Takes `production.blocking` out of stored project bodies, for a rollback past the build that accepts the field (3D blocking, part A).
 * A build from before it rejects any project body that holds the field (its production schema is strict), so such a project could not
 * be saved until the field is gone.
 *
 * DRY RUN BY DEFAULT: it reads, prints COUNTS ONLY (projects read, projects that hold the field, entries in them) and writes nothing.
 * It writes only when BOTH of these are given, which is the owner's yes:   --apply   --owner-said-yes
 * What a write does, per project that holds the field and nothing else: the field is removed from that body and the revision goes up by
 * one (as every save does), so a window with an older copy meets a conflict and merges instead of overwriting. The row is never deleted,
 * and no other field, row or table is touched. Frames filed from blocking stay as ordinary reference inputs and Library files.
 *
 * One database per run (each workspace has its own):
 *   STRIP_BLOCKING_DB_URL=<libsql url or file: path> STRIP_BLOCKING_DB_TOKEN=<token, if any> node scripts/ops/strip-production-blocking.mjs
 * Nothing about a project (its name, id, text) is printed.
 */
import { createClient } from "@libsql/client";

const apply = process.argv.includes("--apply");
const yes = process.argv.includes("--owner-said-yes");
const url = process.env.STRIP_BLOCKING_DB_URL;
if (!url) { console.error("Set STRIP_BLOCKING_DB_URL to the database to read."); process.exit(2); }
if (apply && !yes) { console.error("--apply also needs --owner-said-yes. Nothing was written."); process.exit(2); }

const db = createClient({ url, authToken: process.env.STRIP_BLOCKING_DB_TOKEN });
let read = 0, holding = 0, entries = 0, unreadable = 0, written = 0;
try {
  const rows = (await db.execute("SELECT key, body, revision FROM workbench_projects")).rows;
  for (const row of rows) {
    read++;
    let body;
    try { body = JSON.parse(String(row.body)); } catch { unreadable++; continue; }
    const blocking = body?.production?.blocking;
    if (blocking === undefined) continue;
    holding++;
    entries += blocking && typeof blocking === "object" ? Object.keys(blocking).length : 0;
    if (!(apply && yes)) continue;
    const { blocking: _gone, ...production } = body.production;
    const next = { ...body, production };
    /* Only if the row is still the revision that was read: a save that landed meanwhile is never overwritten (it is found on the next run). */
    const result = await db.execute({
      sql: "UPDATE workbench_projects SET body = ?, revision = revision + 1, updated_at = ? WHERE key = ? AND revision = ?",
      args: [JSON.stringify(next), Date.now(), row.key, row.revision],
    });
    if (result.rowsAffected === 1) written++;
  }
} finally { db.close(); }
console.log(`${apply && yes ? "APPLIED" : "DRY RUN (nothing written)"}: ${read} projects read, ${holding} hold production.blocking (${entries} entries), ${unreadable} unreadable${apply && yes ? `, ${written} rewritten without it` : ""}`);
