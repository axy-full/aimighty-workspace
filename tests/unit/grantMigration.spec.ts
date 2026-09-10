import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The grant-kind migration, run against a database shaped like the live one.
 *
 * This is the risky half of the change: `platformReady()` is awaited by every
 * exported platform function, so a migration that throws does not degrade the
 * platform, it takes it down — and because the memo clears on failure, it
 * takes it down permanently with no self-recovery. The statements are
 * imported rather than retyped so this exercises the ones that actually run.
 */
const OLD_TABLE = `CREATE TABLE credit_grants (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, credits REAL NOT NULL,
  note TEXT, created_by TEXT, created_at INTEGER NOT NULL)`;

async function populated() {
  const { GRANT_KIND_COLUMN, GRANT_KIND_BACKFILL } = await import("../../lib/platform");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-grants-"));
  const c = createClient({ url: `file:${path.join(dir, "t.db")}` });
  await c.execute(OLD_TABLE);
  const rows: [string, string, number, string][] = [
    ["g1", "ws_a", 250, "Welcome credits"],
    ["g2", "ws_a", 2000, "Studio pack · 2,000 credits"],
    ["g3", "ws_a", 100, "Added by management"],
    ["g4", "ws_b", 500, "Starter pack · 500 credits"],
    ["g5", "ws_b", -50, "Taken back, duplicate render"],
    ["g6", "ws_b", 10000, "House pack · 10,000 credits"],
  ];
  for (const r of rows) {
    await c.execute({ sql: "INSERT INTO credit_grants (id, workspace_id, credits, note, created_by, created_at) VALUES (?,?,?,?,?,0)", args: [...r, "u"] });
  }
  const migrate = async () => {
    try {
      await c.execute(`ALTER TABLE credit_grants ADD COLUMN ${GRANT_KIND_COLUMN}`);
      for (const stmt of GRANT_KIND_BACKFILL) await c.execute(stmt);
      return "migrated";
    } catch (e) {
      if (!/duplicate column|already exists/i.test(String((e as Error).message))) throw e;
      return "skipped";
    }
  };
  return { c, migrate };
}

const kinds = async (c: Awaited<ReturnType<typeof populated>>["c"]) => {
  const rs = await c.execute(`SELECT id, kind FROM credit_grants ORDER BY id`);
  return Object.fromEntries((rs.rows as unknown as { id: string; kind: string }[]).map((r) => [r.id, r.kind]));
};

test("an existing database gains the column and its old rows are classified", async () => {
  const { c, migrate } = await populated();
  expect(await migrate()).toBe("migrated");
  expect(await kinds(c)).toEqual({
    g1: "welcome",                 // the sign-up grant, by its fixed note
    g2: "purchase", g4: "purchase", g6: "purchase",   // "<Label> pack · N credits"
    g3: "manual",                  // an admin adding credits
    g5: "manual",                  // ...and taking some back
  });
});

test("running it twice is a no-op, because it runs on every cold start", async () => {
  /* `platformReady()` is memoised per PROCESS, not per deployment, so this
     path is reached again on every new container for the life of the
     database. The second pass must neither throw nor re-scan. */
  const { c, migrate } = await populated();
  await migrate();
  await c.execute(`UPDATE credit_grants SET kind = 'bonus' WHERE id = 'g2'`);
  expect(await migrate()).toBe("skipped");
  // Still 'bonus': the backfill did not run again and overwrite a real kind.
  expect((await kinds(c)).g2).toBe("bonus");
});

test("a fresh database and a migrated one end up the same shape", async () => {
  const { GRANT_KIND_COLUMN } = await import("../../lib/platform");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-fresh-"));
  const fresh = createClient({ url: `file:${path.join(dir, "f.db")}` });
  await fresh.execute(`CREATE TABLE credit_grants (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, credits REAL NOT NULL,
    note TEXT, ${GRANT_KIND_COLUMN}, created_by TEXT, created_at INTEGER NOT NULL)`);
  // The ALTER a fresh database then runs is the one that has to be ignored.
  let skipped = false;
  try { await fresh.execute(`ALTER TABLE credit_grants ADD COLUMN ${GRANT_KIND_COLUMN}`); }
  catch (e) { skipped = /duplicate column|already exists/i.test(String((e as Error).message)); }
  expect(skipped, "the duplicate is the error that is ignored").toBe(true);

  await fresh.execute(`INSERT INTO credit_grants (id, workspace_id, credits, note, created_by, created_at) VALUES ('x','ws',1,'n','u',0)`);
  const rs = await fresh.execute(`SELECT kind FROM credit_grants WHERE id = 'x'`);
  expect((rs.rows[0] as Record<string, unknown>).kind).toBe("manual");
});

test("a row written before the column existed is never NULL", async () => {
  /* NOT NULL DEFAULT on ADD COLUMN is what makes the backfill optional rather
     than load-bearing: even a note nobody anticipated lands on 'manual',
     which reads as free, which is the safe side to be wrong on. */
  const { c, migrate } = await populated();
  await migrate();
  const rs = await c.execute(`SELECT COUNT(*) AS n FROM credit_grants WHERE kind IS NULL OR kind = ''`);
  expect(Number((rs.rows[0] as Record<string, unknown>).n)).toBe(0);
});
