import { test, expect } from "@playwright/test";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { columnInstaller } from "../../lib/schemaInitialization";
import {
  currentTenant,
  runInTenant,
  type TenantWorkspace,
} from "../../lib/tenant";

function database() {
  const dir = mkdtempSync(path.join(tmpdir(), "particl-startup-"));
  const url = `file:${path.join(dir, "schema.db")}`;
  const native = createClient({ url });
  const calls: { kind: string; sql: string[] }[] = [];
  let failBatch = false;
  const sqlOf = (value: Parameters<Client["batch"]>[0][number]) =>
    typeof value === "string" ? value : Array.isArray(value) ? value[0] : value.sql;
  const client = new Proxy(native, {
    get(target, key) {
      if (key === "execute")
        return (...args: [InStatement]) => {
          calls.push({ kind: "execute", sql: [sqlOf(args[0])] });
          return target.execute(...args);
        };
      if (key === "batch")
        return (...args: Parameters<Client["batch"]>) => {
          calls.push({ kind: "batch", sql: args[0].map(sqlOf) });
          if (failBatch) {
            failBatch = false;
            return Promise.reject(new Error("simulated connection loss"));
          }
          return target.batch(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    client,
    url,
    calls,
    failNextBatch: () => {
      failBatch = true;
    },
  };
}

function load<T>(file: string, db: ReturnType<typeof database>): T {
  const filename = path.resolve(file),
    require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  const deps: Record<string, unknown> = {
    "./recoveryDatabaseClient": { fenceDatabase: (client: Client) => client },
    "./localDatabaseClient": { createPlatformDatabaseClient: () => db.client },
    "./tenant": { ...require(path.resolve("lib/tenant.ts")), currentTenant },
    "@libsql/client": { createClient: () => db.client },
  };
  new Function("require", "module", "exports", "process", compiled)(
    (name: string) => (Object.hasOwn(deps, name) ? deps[name] : require(name)),
    loaded,
    loaded.exports,
    {
      ...process,
      env: {
        ...process.env,
        PLATFORM_DATABASE_URL: db.url,
        TURSO_DATABASE_URL: db.url,
      },
    },
  );
  return loaded.exports as T;
}

test("column discovery is one read and skips existing columns without exception-driven writes", async () => {
  const d = database();
  try {
    await d.client.execute(
      "CREATE TABLE sample(id TEXT PRIMARY KEY, existing TEXT)",
    );
    d.calls.length = 0;
    const install = await columnInstaller(d.client);
    for (let i = 0; i < 20; i++)
      expect(await install("sample", "existing TEXT")).toBe(false);
    expect(d.calls).toHaveLength(1);
    expect(await install("sample", "added INTEGER NOT NULL DEFAULT 0")).toBe(
      true,
    );
    expect(await install("sample", "added INTEGER NOT NULL DEFAULT 0")).toBe(
      false,
    );
    expect(d.calls).toHaveLength(2);
  } finally {
    d.client.close();
  }
});

test("a failed classification rolls back its new column and retries the complete migration", async () => {
  const d = database();
  try {
    await d.client.execute(
      "CREATE TABLE grants(id TEXT PRIMARY KEY,note TEXT)",
    );
    await d.client.execute(
      "INSERT INTO grants VALUES('first','Welcome credits')",
    );
    const install = await columnInstaller(d.client);
    await expect(
      install("grants", "kind TEXT NOT NULL DEFAULT 'manual'", [
        "UPDATE missing_table SET kind='welcome'",
      ]),
    ).rejects.toThrow(/no such table/);
    expect(
      (
        await d.client.execute(
          "SELECT name FROM pragma_table_info('grants') WHERE name='kind'",
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      await install("grants", "kind TEXT NOT NULL DEFAULT 'manual'", [
        "UPDATE grants SET kind='welcome'",
      ]),
    ).toBe(true);
    expect((await d.client.execute("SELECT kind FROM grants")).rows).toEqual([
      { kind: "welcome" },
    ]);
    expect(
      await install("grants", "kind TEXT", ["UPDATE grants SET kind='wrong'"]),
    ).toBe(false);
    expect((await d.client.execute("SELECT kind FROM grants")).rows).toEqual([
      { kind: "welcome" },
    ]);
  } finally {
    d.client.close();
  }
});

test("concurrent catalog snapshots converge, while missing tables and real storage errors remain failures", async () => {
  const d = database();
  try {
    await d.client.execute("CREATE TABLE sample(id TEXT PRIMARY KEY)");
    const first = await columnInstaller(d.client),
      second = await columnInstaller(d.client);
    expect(await first("sample", "added TEXT")).toBe(true);
    expect(await second("sample", "added TEXT")).toBe(false);
    await expect(second("missing", "added TEXT")).rejects.toThrow(
      /no such table/,
    );
    await expect(
      second("sample;DROP TABLE sample", "bad TEXT"),
    ).rejects.toThrow(/Invalid/);
    d.client.close();
    await expect(second("sample", "new_column TEXT")).rejects.toThrow();
  } finally {
    if (!d.client.closed) d.client.close();
  }
});

test("platform startup preserves grant classification and retries an interrupted schema batch", async () => {
  const d = database();
  try {
    await d.client.execute(
      "CREATE TABLE credit_grants(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,credits REAL NOT NULL,note TEXT,created_by TEXT,created_at INTEGER NOT NULL)",
    );
    await d.client.execute(
      "INSERT INTO credit_grants VALUES('welcome','ws',250,'Welcome credits',NULL,0)",
    );
    const platform = load<typeof import("../../lib/platform")>(
      "lib/platform.ts",
      d,
    );
    d.failNextBatch();
    await expect(platform.platformReady()).rejects.toThrow(/connection loss/);
    await platform.platformReady();
    expect(
      (await d.client.execute("SELECT kind FROM credit_grants")).rows,
    ).toEqual([{ kind: "welcome" }]);
    expect(
      (
        await d.client.execute(
          "SELECT name FROM pragma_table_info('workspaces') WHERE name='deleted_at'",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    d.client.close();
  }
});

test("cold bootstrap of current tenant and platform schemas has bounded remote round trips", async ({}, info) => {
  async function measure(root: string) {
    const tenant = database(),
      platform = database();
    try {
      const ws = {
        id: "startup",
        dbUrl: tenant.url,
        dbToken: null,
        legacy: false,
      } as TenantWorkspace;
      await runInTenant(ws, () =>
        load<typeof import("../../lib/db")>(
          path.join(root, "lib/db.ts"),
          tenant,
        ).ready(),
      );
      tenant.calls.length = 0;
      await runInTenant(ws, () =>
        load<typeof import("../../lib/db")>(
          path.join(root, "lib/db.ts"),
          tenant,
        ).ready(),
      );
      await load<typeof import("../../lib/platform")>(
        path.join(root, "lib/platform.ts"),
        platform,
      ).platformReady();
      await platform.client.execute(
        "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES('ws','ws','Fixture','unused','owner',0,0)",
      );
      platform.calls.length = 0;
      await load<typeof import("../../lib/platform")>(
        path.join(root, "lib/platform.ts"),
        platform,
      ).platformReady();
      return {
        tenant: {
          roundTrips: tenant.calls.length,
          alterAttempts: tenant.calls
            .flatMap((c) => c.sql)
            .filter((sql) => /^ALTER TABLE/i.test(sql)).length,
        },
        platform: {
          roundTrips: platform.calls.length,
          alterAttempts: platform.calls
            .flatMap((c) => c.sql)
            .filter((sql) => /^ALTER TABLE/i.test(sql)).length,
        },
      };
    } finally {
      tenant.client.close();
      platform.client.close();
    }
  }
  const optimized = await measure(process.cwd());
  expect(optimized.tenant.roundTrips).toBeLessThanOrEqual(12);
  expect(optimized.platform.roundTrips).toBeLessThanOrEqual(4);
  expect(optimized.tenant.alterAttempts).toBe(0);
  expect(optimized.platform.alterAttempts).toBe(0);
  const baseline = process.env.SCHEMA_BASELINE_DIR
    ? await measure(process.env.SCHEMA_BASELINE_DIR)
    : undefined;
  const proof = {
    optimized,
    baseline,
    note: "Real SQLite migrations with client operations counted as remote round trips; not a production latency or load measurement.",
  };
  writeFileSync(
    info.outputPath("startup-roundtrips.json"),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
});
