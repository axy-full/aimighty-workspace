import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createClient, type Client, type InStatement } from "@libsql/client";

/*
 * Server processes booting together (WEB_CONCURRENCY, ops/selfhost/cluster.mjs) run the same additive bootstraps on
 * one database. Each reads which columns exist, then adds the missing ones; the other process can add a column in
 * between, and the late ALTER fails with "duplicate column name". Each bootstrap here meets exactly that race: the
 * "other process" (a second connection) adds the column just before this one's ALTER. The bootstrap must accept it
 * once the column is there, and still throw any other failure. Local temporary database files only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-column-race-"));
process.env.ENGINE_MOCK = "1";
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const file = (name: string) => `file:${path.join(dir, `${name}.db`)}`;

function load<T>(source: string, deps: Record<string, unknown>): T {
  const filename = path.resolve(source), req = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => (Object.hasOwn(deps, name) ? deps[name] : req(name)),
    mod, mod.exports,
  );
  return mod.exports as T;
}

const sqlOf = (stmt: InStatement | string) => (typeof stmt === "string" ? stmt : stmt.sql);
/** This process's client, except that another process runs every ADD COLUMN a moment before it does. */
function racing(mine: Client, other: Client, raced: string[]): Client {
  const first = async (stmt: InStatement | string) => {
    if (/ADD COLUMN/i.test(sqlOf(stmt))) { await other.execute(sqlOf(stmt)); raced.push(sqlOf(stmt)); }
  };
  return new Proxy(mine, {
    get(target, prop) {
      if (prop === "execute") return async (stmt: InStatement | string, args?: unknown) => {
        await first(stmt);
        return typeof stmt === "string" ? target.execute(stmt, args as never) : target.execute(stmt);
      };
      if (prop === "batch") return async (stmts: (InStatement | string)[], mode?: never) => {
        for (const stmt of stmts) await first(stmt);
        return target.batch(stmts as never, mode);
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function columns(client: Client, table: string) {
  return (await client.execute(`SELECT name FROM pragma_table_info('${table}')`)).rows.map((r) => String(r.name));
}

test("the billing ledger's bootstrap accepts columns another process added first", async () => {
  const mine = createClient({ url: file("billing") }), other = createClient({ url: file("billing") }), raced: string[] = [];
  /* The tables as they stood before these columns. */
  await mine.batch([
    `CREATE TABLE billing_lots(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, credits REAL NOT NULL,
      drawn REAL NOT NULL DEFAULT 0, expires_at INTEGER, off_plan_remaining_ms INTEGER, clock_updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE billing_debits(workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, credits REAL NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,event_id))`,
    `CREATE TABLE billing_unit(id INTEGER PRIMARY KEY CHECK(id=1), unit_usd REAL NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`,
  ], "write");
  const client = racing(mine, other, raced);
  const ledger = load<typeof import("../../lib/billingLedger")>("lib/billingLedger.ts", {
    "./platform": { platformDb: () => client, platformReady: async () => {} },
  });
  await ledger.billingReady();
  expect(raced).toHaveLength(4);
  expect(await columns(mine, "billing_lots")).toEqual(expect.arrayContaining(["clock_started_at", "off_plan_lifetime_ms"]));
  expect(await columns(mine, "billing_debits")).toContain("legacy");
  expect(await columns(mine, "billing_unit")).toContain("paused_since");
  mine.close(); other.close();
});

test("the credit conversion bootstrap accepts columns another process added first", async () => {
  const mine = createClient({ url: file("conversion") }), other = createClient({ url: file("conversion") }), raced: string[] = [];
  await mine.execute(`CREATE TABLE billing_unit_conversions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const client = racing(mine, other, raced);
  const conversion = load<typeof import("../../lib/creditConversion")>("lib/creditConversion.ts", {
    "./platform": { platformDb: () => client, platformReady: async () => {}, getWorkspace: async () => null },
    "./billingLedger": { billingReady: async () => {} },
  });
  await conversion.conversionsReady();
  expect(raced).toHaveLength(2);
  expect(await columns(mine, "billing_unit_conversions")).toEqual(expect.arrayContaining(["end_at", "caps_json"]));
  mine.close(); other.close();
});

test("the identity training bootstrap accepts the column another process added first", async () => {
  const mine = createClient({ url: file("identities") }), other = createClient({ url: file("identities") }), raced: string[] = [];
  await mine.batch([`CREATE TABLE identities(id TEXT PRIMARY KEY, created_by TEXT)`, `CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT)`], "write");
  const client = racing(mine, other, raced);
  const identities = load<typeof import("../../lib/identities")>("lib/identities.ts", {
    "./db": { db: () => client, ready: async () => {}, now: () => 0, id: () => "id" },
    "./tenant": { currentTenant: () => null, requireTenant: () => ({ id: "ws_race" }) },
  });
  /* The bootstrap runs first; past it, an identity that does not exist is refused as always. */
  await expect(identities.startTraining("missing")).rejects.toThrow("No such identity.");
  expect(raced).toHaveLength(1);
  expect(await columns(mine, "identities")).toContain("training_run_id");
  mine.close(); other.close();
});

test("the consumer store's bootstrap accepts a duplicate column only once it is there, and throws anything else", async () => {
  /* Inside its write transaction the race cannot happen on SQLite; the guard is for a backend where it can. */
  const transaction = (failure: string, appears: boolean) => {
    let added = false;
    return {
      execute: async (stmt: InStatement | string) => {
        const sql = sqlOf(stmt);
        if (/pragma_table_info/.test(sql)) return { rows: added ? [{ name: "subject_hash" }] : [] };
        if (/ADD COLUMN/.test(sql)) { added = appears; throw new Error(failure); }
        return { rows: [] };
      },
    };
  };
  const store = (tx: unknown) => load<typeof import("../../lib/higgsfield-consumer/store")>("lib/higgsfield-consumer/store.ts", {
    "../accountDb": { accountTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) },
    "../keyring": { open: (v: string) => v, seal: (v: string) => v },
  });
  await expect(store(transaction("SQLITE_ERROR: duplicate column name: subject_hash", true)).consumerStoreReady()).resolves.toBeUndefined();
  await expect(store(transaction("SQLITE_ERROR: duplicate column name: subject_hash", false)).consumerStoreReady()).rejects.toThrow("duplicate column");
  await expect(store(transaction("SQLITE_IOERR: disk I/O error", true)).consumerStoreReady()).rejects.toThrow("disk I/O error");
});
