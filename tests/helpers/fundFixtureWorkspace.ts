import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Explicit funds for disposable lifecycle fixtures, never an admission bypass. */
export async function fundFixtureWorkspace(credits = 10_000): Promise<void> {
  const { currentTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const workspace = currentTenant()?.workspace;
  if (!workspace) throw new Error("The fixture needs a workspace");
  await platformReady();
  const file = String((await platformDb().execute("SELECT file FROM pragma_database_list WHERE name='main'")).rows[0]?.file ?? "");
  const root = realpathSync(tmpdir()) + path.sep;
  if (!file || !realpathSync(file).startsWith(root)) throw new Error("Fixture funds require a disposable local database");
  if ((await platformDb().execute({ sql: "SELECT 1 FROM credit_grants WHERE workspace_id=? LIMIT 1", args: [workspace.id] })).rows.length) return;
  /* In today's credits, saying so (unit_usd): a grant row without one is a legacy US$0.10 grant. */
  const { creditUsd } = await import("../../lib/creditTerms");
  await platformDb().execute({
    sql: "INSERT OR IGNORE INTO credit_grants(id,workspace_id,credits,kind,created_at,unit_usd) VALUES(?,?,?,'manual',0,?)",
    args: [`fixture_funds_${workspace.id}`, workspace.id, credits, creditUsd()],
  });
}
