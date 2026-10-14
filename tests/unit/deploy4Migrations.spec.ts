import { test, expect } from "@playwright/test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Deploy #4's migration files (ops/migrations/deploy-4/NN-*.sql) must be exactly what the app creates. Each file is applied to a fresh in-memory SQLite and the schema it leaves is
 * compared, table by table, with what the app's own bootstrap creates on THIS checkout (a tenant database made by lib/db.ts ready(); the lazy export_jobs table by exportJobsReady()):
 * columns, indexes and triggers. A file whose table the checkout does not have yet (its PR is not merged here) is skipped and said so; the file's own rules still run (it applies,
 * twice, and creates what it names). After each PR merges into release/1 the same test then compares for real: re-run it with
 *   env -u CREDIT_USD ENGINE_MOCK=1 npx playwright test --project=unit tests/unit/deploy4Migrations.spec.ts
 * and check the "compared" annotation lists that PR's tables. Run on each PR's own branch (the files copied in) it compared every one of them on 15 Oct 2026.
 * Additive only is checked too: no file drops, renames or updates anything.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-deploy4-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const MIGRATIONS = path.resolve("ops/migrations/deploy-4");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

/** What each file creates (and so what the app must have, if its PR is on this checkout). */
const EXPECT: Record<string, { tables: string[]; column?: { table: string; name: string } }> = {
  "01-pr702-workbench_projects-updated_by.sql": { tables: [], column: { table: "workbench_projects", name: "updated_by" } },
  "02-pr698-board_trash.sql": { tables: ["board_trash"] },
  "03-pr718-workbench_board_owners.sql": { tables: ["workbench_board_owners"] },
  "04-pr700-export_jobs.sql": { tables: ["export_jobs"] },
  "05-pr728-take_review_events.sql": { tables: ["take_review_events"] },
  "06-pr731-estimated_credits-tables.sql": { tables: ["estimated_credits", "estimated_credits_fill"] },
};

const squash = (sql: unknown) => String(sql ?? "").replace(/\s+/g, " ").replace(/\s*;\s*$/, "").trim();
async function shapeOf(c: Client, table: string) {
  const info = (await c.execute(`PRAGMA table_info("${table}")`)).rows.map((r) => [r.name, String(r.type).toUpperCase(), Number(r.notnull), r.dflt_value == null ? null : String(r.dflt_value), Number(r.pk)]);
  const lists = (await c.execute(`PRAGMA index_list("${table}")`)).rows.map((r) => [r.name, Number(r.unique), Number(r.partial)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const named = (await c.execute({ sql: "SELECT type, name, sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name", args: [table] })).rows.map((r) => [r.type, r.name, squash(r.sql)]);
  return { info, lists, named };
}

test("the migration folder is complete: one file per migration, in order, and the list in this test is the folder", () => {
  expect(files).toEqual(Object.keys(EXPECT).sort());
  expect(files.map((f) => f.slice(0, 2))).toEqual(["01", "02", "03", "04", "05", "06"]);
});

test("every file is additive and holds no secret, name or data: no DROP, RENAME, UPDATE, DELETE or INSERT statement is run, and nothing person- or workspace-specific is in it", () => {
  for (const file of files) {
    const text = readFileSync(path.join(MIGRATIONS, file), "utf8");
    const statements = text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements, file).not.toMatch(/\b(DROP|RENAME|UPDATE\s+\w|DELETE\s+FROM|INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|ATTACH|VACUUM|PRAGMA)\b/i);
    expect(text, file).not.toMatch(/libsql:\/\/|https?:\/\/|\b(?:token|secret|password)\b|@[a-z0-9-]+\.[a-z]{2,}|usr_|ws_[a-z0-9]/i);
    /* Every statement that creates anything is idempotent (the one ALTER is the stated exception). */
    for (const create of statements.match(/\bCREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\b[^;]*?(?=\bON\b|\()/gi) ?? []) expect(create, file).toMatch(/IF NOT EXISTS/i);
  }
});

test("each file applies to a fresh database and again: it creates what it names, a second run changes nothing (the ALTER alone says duplicate column, as stated), and no row is written", async () => {
  const baseDdl = readFileSync("lib/db.ts", "utf8").match(/`CREATE TABLE IF NOT EXISTS workbench_projects \([\s\S]*?\)`/)?.[0]?.slice(1, -1);
  expect(baseDdl, "the pre-migration table, read from lib/db.ts").toBeTruthy();
  for (const file of files) {
    const c = createClient({ url: ":memory:" });
    await c.execute(baseDdl!);
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    const before = (await c.execute("SELECT name FROM sqlite_master ORDER BY name")).rows.map((r) => String(r.name));
    await c.executeMultiple(sql);
    const created = (await c.execute("SELECT name FROM sqlite_master ORDER BY name")).rows.map((r) => String(r.name)).filter((n) => !before.includes(n));
    const spec = EXPECT[file];
    for (const table of spec.tables) expect(created, file).toContain(table);
    if (spec.column) expect((await c.execute(`PRAGMA table_info("${spec.column.table}")`)).rows.map((r) => String(r.name)), file).toContain(spec.column.name);
    const after = (await c.execute("SELECT name, sql FROM sqlite_master ORDER BY name")).rows.map((r) => [r.name, r.sql]);
    if (spec.column) await expect(c.executeMultiple(sql), file).rejects.toThrow(/duplicate column name: updated_by/i);
    else await c.executeMultiple(sql);
    expect((await c.execute("SELECT name, sql FROM sqlite_master ORDER BY name")).rows.map((r) => [r.name, r.sql]), file).toEqual(after);
    for (const table of spec.tables) expect(Number((await c.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n), `${file} ${table}`).toBe(0);
    c.close();
  }
});

test("each file leaves exactly the schema the app's own bootstrap creates (compared where this checkout has the app's side)", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const ws: TenantWorkspace = {
    id: "ws_deploy4", name: "ws_deploy4", slug: "ws_deploy4", legacy: false, dbUrl: `file:${path.join(dir, "ws_deploy4.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
    ownerId: "u1", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
  const baseDdl = readFileSync("lib/db.ts", "utf8").match(/`CREATE TABLE IF NOT EXISTS workbench_projects \([\s\S]*?\)`/)![0].slice(1, -1);
  const compared: string[] = [], skipped: string[] = [];
  await runInTenant(ws, async () => {
    await ready();
    /* The lazy table, where the checkout has it: created the way the app does, on first use. */
    try { const jobs = await import("../../lib/exports/jobs"); await jobs.exportJobsReady(); } catch { /* not on this checkout */ }
    const app = db();
    for (const file of files) {
      const spec = EXPECT[file];
      const have = new Set((await app.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name)));
      const appColumns = spec.column && have.has(spec.column.table) ? (await app.execute(`PRAGMA table_info("${spec.column.table}")`)).rows.map((r) => String(r.name)) : [];
      const present = spec.column ? appColumns.includes(spec.column.name) : spec.tables.every((t) => have.has(t));
      if (!present) { skipped.push(file); continue; }
      const c = createClient({ url: ":memory:" });
      await c.execute(baseDdl);
      await c.executeMultiple(readFileSync(path.join(MIGRATIONS, file), "utf8"));
      /* A column added to an existing table: its columns are compared (the table's own indexes belong to the earlier release). */
      if (spec.column) expect((await shapeOf(c, spec.column.table)).info, `${file}: ${spec.column.table}`).toEqual((await shapeOf(app, spec.column.table)).info);
      else for (const table of spec.tables) expect(await shapeOf(c, table), `${file}: ${table}`).toEqual(await shapeOf(app, table));
      c.close();
      compared.push(file);
    }
  });
  test.info().annotations.push({ type: "compared", description: compared.join(", ") || "none on this checkout" }, { type: "skipped (the PR is not on this checkout)", description: skipped.join(", ") || "none" });
  console.log(`deploy-4 migrations compared with the app: ${compared.join(", ") || "none"}; skipped: ${skipped.join(", ") || "none"}`);
});
