import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
const dir = mkdtempSync(path.join(tmpdir(), "particl-media-deletion-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
function workspace(name: string) {
  return {
    id: name,
    name,
    slug: name,
    dbUrl: `file:${path.join(dir, name + ".db")}`,
    legacy: false,
    dbToken: null,
    keys: {},
    storageQuotaBytes: 10,
    usesPlatformKeys: false,
  } as TenantWorkspace;
}
async function load(
  remove: (id: string, strict: boolean, url: string | null) => Promise<void>,
) {
  const compiled = ts.transpileModule(
    readFileSync(path.resolve("lib/mediaDeletion.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const dependencies: Record<string, unknown> = {
    "./db": await import("../../lib/db"),
    "node:crypto": await import("node:crypto"),
    "./storage": { deleteVideo: remove },
    "./mediaBindings": await import("../../lib/mediaBindings"),
    "./higgsfield-consumer/original-retention": await import("../../lib/higgsfield-consumer/original-retention"),
  };
  const mod = { exports: {} as typeof import("../../lib/mediaDeletion") };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected dependency");
      return dependencies[name];
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}

test("a failed generation Blob deletion retains original locations and billed cost until a successful retry", async () => {
  let fail = true;
  const calls: unknown[][] = [];
  const api = await load(async (...args) => {
    calls.push(args);
    if (fail) throw new Error("fixture Blob outage");
  });
  const { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db"),
    { standing } = await import("../../lib/limits");
  await runInTenant(workspace("failure"), async () => {
    await api.mediaDeletionReady();
    await db().execute(
      "INSERT INTO generations(id,model,prompt,params,status,stored_url,source_url,bytes,cost_usd,created_at,updated_at) VALUES('take','fixture','','{}','succeeded','https://fixture.private.blob/master-random.mp4','original-provider-handle',6,2.5,0,1)",
    );
    const tx = await db().transaction("write");
    await api.markGenerationDeletion(tx, "take", 2);
    await tx.commit();
    tx.close();
    expect(await api.cleanupDeletedGenerations()).toEqual({
      attempted: 1,
      cleaned: 0,
      failed: 1,
    });
    const retained = (
      await db().execute("SELECT * FROM generations WHERE id='take'")
    ).rows[0];
    expect(retained.stored_url).toBe(
      "https://fixture.private.blob/master-random.mp4",
    );
    expect(retained.source_url).toBe("original-provider-handle");
    expect(retained.bytes).toBe(6);
    // Hidden renders are kept but no longer count toward the storage cap.
    expect((await standing()).usedBytes).toBe(0);
    fail = false;
    expect(await api.cleanupDeletedGenerations()).toEqual({
      attempted: 1,
      cleaned: 1,
      failed: 0,
    });
    const final = (
      await db().execute("SELECT * FROM generations WHERE id='take'")
    ).rows[0];
    expect(final.stored_url).toBeNull();
    expect(final.source_url).toBeNull();
    expect(final.bytes).toBe(0);
    expect(final.cost_usd).toBe(2.5);
    expect(final.deleted).toBe(1);
    expect((await standing()).usedBytes).toBe(0);
    expect(await api.cleanupDeletedGenerations()).toEqual({
      attempted: 0,
      cleaned: 0,
      failed: 0,
    });
    expect(calls).toEqual([
      ["take", true, "https://fixture.private.blob/master-random.mp4"],
      ["take", true, "https://fixture.private.blob/master-random.mp4"],
    ]);
  });
});

test("cleanup ownership prevents duplicate deletes and a late generation update cannot release newer bytes", async () => {
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true,
    calls = 0;
  const api = await load(async () => {
    calls++;
    if (first) {
      first = false;
      entered();
      await held;
    }
  });
  const { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("concurrent"), async () => {
    await api.mediaDeletionReady();
    await db().execute(
      "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,deleted,created_at,updated_at) VALUES('take','fixture','','{}','succeeded','first',6,1,0,1)",
    );
    const clean = api.cleanupDeletedGenerations();
    await enteredPromise;
    expect(await api.cleanupDeletedGenerations()).toEqual({
      attempted: 0,
      cleaned: 0,
      failed: 0,
    });
    await db().execute(
      "UPDATE generations SET stored_url='newer',bytes=8,updated_at=3 WHERE id='take'",
    );
    release();
    expect((await clean).failed).toBe(1);
    const row = (
      await db().execute("SELECT * FROM generations WHERE id='take'")
    ).rows[0];
    expect(row.stored_url).toBe("newer");
    expect(row.bytes).toBe(8);
    expect(calls).toBe(1);
    expect((await api.cleanupDeletedGenerations()).cleaned).toBe(1);
    expect(calls).toBe(2);
  });
});

test("legacy deleted rows without a stored URL still clear retained deterministic media bytes", async () => {
  const calls: unknown[][] = [];
  const api = await load(async (...args) => {
    calls.push(args);
  });
  const { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("legacy"), async () => {
    await api.mediaDeletionReady();
    await db().execute(
      "INSERT INTO generations(id,model,prompt,params,status,bytes,deleted,created_at,updated_at) VALUES('old','fixture','','{}','succeeded',6,1,0,1)",
    );
    expect((await api.cleanupDeletedGenerations()).cleaned).toBe(1);
    expect(calls).toEqual([["old", true, null]]);
    expect(
      (await db().execute("SELECT bytes FROM generations WHERE id='old'"))
        .rows[0].bytes,
    ).toBe(0);
  });
});

test("a permanently failing deletion cannot starve later tombstones in bounded cleanup runs", async () => {
  const calls: string[] = [];
  const api = await load(async (id) => {
    calls.push(id);
    if (id === "a-fails") throw new Error("fixture permanent storage error");
  });
  const { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("fair-cleanup"), async () => {
    await api.mediaDeletionReady();
    for (const id of ["a-fails", "b-next", "c-last"])
      await db().execute({
        sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,deleted,created_at,updated_at) VALUES(?,'fixture','','{}','succeeded','fixture',1,1,0,1)",
        args: [id],
      });
    expect(await api.cleanupDeletedGenerations(1, 10)).toEqual({
      attempted: 1,
      cleaned: 0,
      failed: 1,
    });
    expect(await api.cleanupDeletedGenerations(1, 20)).toEqual({
      attempted: 1,
      cleaned: 1,
      failed: 0,
    });
    expect(await api.cleanupDeletedGenerations(1, 30)).toEqual({
      attempted: 1,
      cleaned: 1,
      failed: 0,
    });
    expect(calls).toEqual(["a-fails", "b-next", "c-last"]);
    expect(
      (await db().execute("SELECT bytes FROM generations WHERE id='a-fails'"))
        .rows[0].bytes,
    ).toBe(1);
  });
});
