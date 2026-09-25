import type { Client, InArgs, InStatement, Transaction } from "@libsql/client";
import { db } from "./db";

/*
 * Nothing a team makes is ever erased (owner, 2026-09-24: "The data should be
 * available on the server indefinitely"). A delete in the app still takes a
 * row out of the table every screen reads, so no reader has to learn a new
 * filter, but the whole row is copied into archived_rows first, in the same
 * write. The archive lives in the workspace database, on the server with
 * everything else, and a row can be put back from its JSON copy.
 */

type Executor = Pick<Client | Transaction, "execute">;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const initialized = new WeakMap<Client, Promise<void>>();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS archived_rows (
    id TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_id TEXT,
    body TEXT NOT NULL, reason TEXT, archived_by TEXT, archived_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_archived_rows_table ON archived_rows(table_name, row_id)",
];

export async function archiveReady() {
  const client = db();
  let pending = initialized.get(client);
  if (!pending) {
    pending = client
      .batch(SCHEMA, "write")
      .then(() => {})
      .catch((error) => {
        initialized.delete(client);
        throw error;
      });
    initialized.set(client, pending);
  }
  await pending;
}

/**
 * The INSERT that copies every row matching `where` into the archive. Built
 * ahead of a batch or a transaction so the copy and the delete that follows
 * it land together or not at all.
 */
export async function archiveStatement(
  ex: Executor,
  table: string,
  where: string,
  args: InArgs,
  meta: { reason?: string; by?: string | null } = {},
): Promise<InStatement> {
  if (!IDENT.test(table)) throw new Error("Invalid archive table.");
  // On the caller's own executor: a second connection would wait on its open write.
  for (const sql of SCHEMA) await ex.execute(sql);
  const columns = (await ex.execute(`PRAGMA table_info(${table})`)).rows.map((row) => String(row.name));
  if (!columns.length || columns.some((name) => !IDENT.test(name)))
    throw new Error(`Cannot archive ${table}.`);
  // JSON cannot hold a BLOB; hex keeps the bytes recoverable.
  const body = columns
    .map((name) => `'${name}', CASE WHEN typeof(${name})='blob' THEN hex(${name}) ELSE ${name} END`)
    .join(", ");
  const key = columns.includes("id") ? "CAST(id AS TEXT)" : "CAST(rowid AS TEXT)";
  const leading = [table, meta.reason ?? "deleted", meta.by ?? null, Date.now()];
  return {
    sql: `INSERT INTO archived_rows(id,table_name,row_id,body,reason,archived_by,archived_at)
          SELECT lower(hex(randomblob(16))), ?, ${key}, json_object(${body}), ?, ?, ?
          FROM ${table} WHERE ${where}`,
    args: Array.isArray(args) ? [...leading, ...args] : (() => { throw new Error("Archive needs positional args."); })(),
  };
}

/** A plain client, as opposed to a transaction already open on one. */
const isClient = (ex: Executor): ex is Client =>
  typeof (ex as Partial<Client>).transaction === "function" && typeof (ex as Partial<Client>).batch === "function";

/**
 * Copy, then delete, as one write. Returns rows removed.
 *
 * Inside a caller's transaction the two statements already land together.
 * On a plain client they are sent as one write batch: two autocommitted
 * statements would let a row inserted or edited between them be deleted
 * without its archive copy.
 */
export async function archiveAndDelete(
  ex: Executor,
  table: string,
  where: string,
  args: unknown[],
  meta: { reason?: string; by?: string | null } = {},
): Promise<number> {
  const copy = await archiveStatement(ex, table, where, args as InArgs, meta);
  const remove: InStatement = { sql: `DELETE FROM ${table} WHERE ${where}`, args: args as InArgs };
  if (isClient(ex)) return (await ex.batch([copy, remove], "write"))[1].rowsAffected;
  await ex.execute(copy);
  return (await ex.execute(remove)).rowsAffected;
}

/**
 * Several archive-and-deletes, and whatever else a delete touches, as one
 * write: every step lands or none does, so a failure halfway through never
 * leaves a record half taken apart.
 */
export async function archiveTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  await archiveReady();
  const tx = await db().transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally {
    tx.close();
  }
}
