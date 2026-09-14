import type { Client, InStatement } from "@libsql/client";

/** One catalog read per bootstrap, rather than a failing ALTER (and recovery
 * admission) for every column on every new function instance. The snapshot
 * belongs to this bootstrap only; retries and other databases read their own. */
export async function columnInstaller(client: Client) {
  const result =
    await client.execute(`SELECT m.name AS table_name,p.name AS column_name
    FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table'`);
  const columns = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const table = String(row.table_name);
    if (!columns.has(table)) columns.set(table, new Set());
    columns.get(table)!.add(String(row.column_name).toLowerCase());
  }
  return async (
    table: string,
    declaration: string,
    after: InStatement[] = [],
  ): Promise<boolean> => {
    const name = declaration
      .match(/^([A-Za-z_][A-Za-z0-9_]*)\s/)?.[1]
      ?.toLowerCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !name)
      throw new Error("Invalid schema column declaration");
    if (columns.get(table)?.has(name)) return false;
    const sql = `ALTER TABLE "${table}" ADD COLUMN ${declaration}`;
    try {
      // The column and its one-time data classification must land together:
      // a failed backfill must not leave a column that suppresses its retry.
      if (after.length) await client.batch([sql, ...after], "write");
      else await client.execute(sql);
    } catch (error) {
      if (
        !/duplicate column/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
      // Another initializer may have won after the catalog snapshot. Verify
      // the column before accepting the collision; all other failures escape.
      const present = await client.execute({
        sql: "SELECT name FROM pragma_table_info(?) WHERE lower(name)=?",
        args: [table, name],
      });
      if (!present.rows.length) throw error;
      if (!columns.has(table)) columns.set(table, new Set());
      columns.get(table)!.add(name);
      return false;
    }
    if (!columns.has(table)) columns.set(table, new Set());
    columns.get(table)!.add(name);
    return true;
  };
}
