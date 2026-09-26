import { test, expect } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/* Owner, 2026-09-24: "The data should be available on the server
   indefinitely." A delete hides; it never erases. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-never-delete-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const workspace = (name: string) => ({
  id: name, name, slug: name, dbUrl: `file:${path.join(dir, name + ".db")}`,
  legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false,
}) as TenantWorkspace;

function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx|mjs)$/.test(name) ? [full] : [];
  });
}

test("a delete copies the whole row to the archive before it leaves the table", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { archiveAndDelete } = await import("../../lib/archive");
  await runInTenant(workspace("archive"), async () => {
    await ready();
    await db().execute("CREATE TABLE sample(id TEXT PRIMARY KEY, n INTEGER, b BLOB, t TEXT)");
    await db().execute({ sql: "INSERT INTO sample VALUES(?,?,?,?),(?,?,?,?)", args: ["a", 1, new Uint8Array([1, 255]), "kept", "b", 2, null, "stays"] });
    expect(await archiveAndDelete(db(), "sample", "id=?", ["a"], { by: "u1" })).toBe(1);
    expect((await db().execute("SELECT id FROM sample")).rows.map((r) => r.id)).toEqual(["b"]);
    const archived = (await db().execute("SELECT * FROM archived_rows")).rows;
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ table_name: "sample", row_id: "a", reason: "deleted", archived_by: "u1" });
    expect(JSON.parse(String(archived[0].body))).toEqual({ id: "a", n: 1, b: "01FF", t: "kept" });
    await expect(archiveAndDelete(db(), "sample; DROP TABLE sample", "1", [])).rejects.toThrow("Invalid archive table.");
  });
});

test("an archive copy and its delete land together, and a multi-step delete lands whole or not at all", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { archiveAndDelete, archiveTransaction } = await import("../../lib/archive");
  await runInTenant(workspace("archive-atomic"), async () => {
    await ready();
    await db().execute("CREATE TABLE sample(id TEXT PRIMARY KEY, n INTEGER)");
    await db().execute("INSERT INTO sample VALUES('a',1),('b',2)");
    const archived = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM archived_rows WHERE table_name='sample'")).rows[0].n);
    const ids = async () => (await db().execute("SELECT id FROM sample ORDER BY id")).rows.map((r) => r.id);
    // On a plain client: if the delete fails, the copy is not left behind either.
    await db().execute("CREATE TRIGGER refuse BEFORE DELETE ON sample BEGIN SELECT RAISE(ABORT,'fixture refusal'); END");
    await expect(archiveAndDelete(db(), "sample", "id=?", ["a"])).rejects.toThrow(/fixture refusal/);
    expect(await archived()).toBe(0);
    await db().execute("DROP TRIGGER refuse");
    // Several steps: a failure halfway leaves every row where it was.
    await expect(archiveTransaction(async (tx) => {
      await archiveAndDelete(tx, "sample", "id=?", ["a"]);
      throw new Error("fixture failure halfway");
    })).rejects.toThrow(/halfway/);
    expect(await ids()).toEqual(["a", "b"]);
    expect(await archived()).toBe(0);
    expect(await archiveTransaction(async (tx) =>
      (await archiveAndDelete(tx, "sample", "id=?", ["a"])) + (await archiveAndDelete(tx, "sample", "id=?", ["b"])))).toBe(2);
    expect(await ids()).toEqual([]);
    expect(await archived()).toBe(2);
    expect(await archiveAndDelete(db(), "sample", "id=?", ["missing"])).toBe(0);
  });
});

test("a delete across many tables reads each table once and writes in one batch, whole or not at all", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { archiveDeleteStatements, archiveTransaction } = await import("../../lib/archive");
  await runInTenant(workspace("archive-batch"), async () => {
    await ready();
    await db().batch([
      "CREATE TABLE parents(id TEXT PRIMARY KEY, name TEXT)",
      "CREATE TABLE children(id TEXT PRIMARY KEY, parent_id TEXT, n INTEGER)",
      "INSERT INTO parents VALUES('p1','first'),('p2','second')",
      "INSERT INTO children VALUES('c1','p1',1),('c2','p1',2),('c3','p2',3)",
    ], "write");
    const steps = [
      { table: "children", where: "id IN (?,?)", args: ["c1", "c2"] },
      { table: "children", where: "parent_id = ?", args: ["p1"] },
      { table: "parents", where: "id = ?", args: ["p1"], by: "u1" },
    ];
    const rows = async () => (await db().execute("SELECT id FROM children UNION ALL SELECT id FROM parents ORDER BY id")).rows.map((r) => r.id);
    const archived = async () => (await db().execute("SELECT table_name, row_id, archived_by FROM archived_rows ORDER BY row_id")).rows.map((r) => `${r.table_name}:${r.row_id}:${r.archived_by ?? ""}`);

    // A refusal on the last step leaves every row where it was, with no copies.
    await db().execute("CREATE TRIGGER refuse BEFORE DELETE ON parents BEGIN SELECT RAISE(ABORT,'fixture refusal'); END");
    await expect(archiveTransaction(async (tx) => { await tx.batch(await archiveDeleteStatements(tx, steps)); })).rejects.toThrow(/fixture refusal/);
    expect(await rows()).toEqual(["c1", "c2", "c3", "p1", "p2"]);
    expect(await archived()).toEqual([]);
    await db().execute("DROP TRIGGER refuse");

    const calls = { execute: 0, batch: 0 };
    await archiveTransaction(async (tx) => {
      const execute = tx.execute.bind(tx), batch = tx.batch.bind(tx);
      tx.execute = ((...a: Parameters<typeof execute>) => { calls.execute++; return execute(...a); }) as typeof tx.execute;
      tx.batch = ((...a: Parameters<typeof batch>) => { calls.batch++; return batch(...a); }) as typeof tx.batch;
      await tx.batch(await archiveDeleteStatements(tx, steps));
    });
    // No schema statements again, one read of both tables' columns, one write.
    expect(calls).toEqual({ execute: 0, batch: 2 });
    expect(await rows()).toEqual(["c3", "p2"]);
    // Each row is copied once, by the first step that reaches it.
    expect(await archived()).toEqual(["children:c1:", "children:c2:", "parents:p1:u1"]);
  });
});

test("deleting a production archives everything filed under it in one write, and unfiles its renders", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const dbModule = await import("../../lib/db");
  const archive = await import("../../lib/archive");
  const { loadIsolated } = await import("./storageSeam");
  const { db, ready } = dbModule;
  const route = loadIsolated<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts", {
    "@/lib/db": dbModule,
    "@/lib/archive": archive,
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: { id: "u1" } }) },
    "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
  });
  const remove = (id: string) => route.DELETE(new Request(`https://studio.test/api/projects/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
  await runInTenant(workspace("project-delete"), async () => {
    await ready();
    /** A row with the given values and a placeholder in every other required column. */
    const insert = async (table: string, values: Record<string, unknown>) => {
      const required = (await db().execute(`PRAGMA table_info(${table})`)).rows
        .filter((c) => Number(c.notnull) && c.dflt_value == null && !(String(c.name) in values));
      const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
      await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
    };
    for (const project of ["prod", "other"]) await insert("projects", { id: project, name: project });
    await insert("shots", { id: "sh1", project_id: "prod" });
    await insert("shots", { id: "sh2", project_id: "other" });
    await insert("cast_members", { id: "cm1", project_id: "prod" });
    await insert("elements", { id: "el1", project_id: "prod" });
    await insert("element_attributes", { id: "ea1", element_id: "el1" });
    await insert("attribute_versions", { id: "av1", element_id: "el1" });
    await insert("bindings", { id: "bd1", element_id: "el1", project_id: "prod", shot_id: "sh1" });
    await insert("canvas_items", { id: "ci1", project_id: "prod" });
    await insert("generations", { id: "g1", project_id: "prod", deleted: 0 });
    /* Originals filed in each project's Library (the table a project library creates when first used). */
    await db().execute("CREATE TABLE IF NOT EXISTS project_library_uploads (project_id TEXT NOT NULL, upload_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_id,upload_id))");
    await insert("project_library_uploads", { project_id: "prod", upload_id: "up1", created_by: "u1", created_at: 1 });
    await insert("project_library_uploads", { project_id: "other", upload_id: "up2", created_by: "u1", created_at: 1 });

    expect((await remove("prod")).status).toBe(200);
    const count = async (table: string, where = "1") => Number((await db().execute(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);
    for (const table of ["cast_members", "elements", "element_attributes", "attribute_versions", "bindings", "canvas_items"])
      expect(await count(table)).toBe(0);
    expect(await count("shots")).toBe(1);
    expect(await count("projects")).toBe(1);
    expect(await count("generations", "id='g1' AND project_id IS NULL")).toBe(1);
    /* Its filings are archived, so the originals can be deleted later; another project's stay. */
    expect((await db().execute("SELECT project_id, upload_id FROM project_library_uploads")).rows.map((r) => `${r.project_id}:${r.upload_id}`)).toEqual(["other:up2"]);
    expect(await count("archived_rows", "table_name='project_library_uploads' AND json_extract(body,'$.upload_id')='up1'")).toBe(1);
    const archived = (await db().execute("SELECT table_name, row_id FROM archived_rows ORDER BY table_name, row_id")).rows.map((r) => `${r.table_name}:${r.row_id}`);
    expect(archived).toEqual(expect.arrayContaining([
      "attribute_versions:av1", "bindings:bd1", "canvas_items:ci1", "cast_members:cm1", "element_attributes:ea1",
      "elements:el1", "generations.project_id:prod", "projects:prod", "shots:sh1",
    ]));
    // A column named for an SQL keyword (shots.cast) is copied like any other.
    const shot = (await db().execute("SELECT body FROM archived_rows WHERE table_name='shots' AND row_id='sh1'")).rows[0];
    expect(JSON.parse(String(shot.body))).toMatchObject({ id: "sh1", project_id: "prod", cast: "[]" });
    expect((await remove("prod")).status).toBe(404);
  });
});

test("deleting an upload archives its row and leaves the file in storage", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { uploadReservationsReady, queueUploadDeletion } = await import("../../lib/uploadReservations");
  await runInTenant(workspace("uploads"), async () => {
    await ready();
    await uploadReservationsReady();
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES(?,?,?,?,?,?,?,?)",
      args: ["up1", "plate.exr", "image/x-exr", "exr", 42, "f".repeat(64), "https://blob.example/ws/up1.exr", 1],
    });
    const tx = await db().transaction("write");
    try { expect(await queueUploadDeletion(tx, "owner", "up1")).toBe("up1"); await tx.commit(); } finally { tx.close(); }
    expect((await db().execute("SELECT id FROM uploads")).rows).toHaveLength(0);
    // No cleanup session was queued: nothing will ever remove the bytes.
    expect((await db().execute("SELECT id FROM upload_sessions")).rows).toHaveLength(0);
    const body = JSON.parse(String((await db().execute("SELECT body FROM archived_rows WHERE table_name='uploads'")).rows[0].body));
    expect(body).toMatchObject({ id: "up1", stored_url: "https://blob.example/ws/up1.exr", bytes: 42 });
  });
});

test("no route, cron or library path erases media, a workspace or a team's rows", () => {
  const files = [...sources("app"), ...sources("lib")].filter((f) => !f.endsWith(path.join("lib", "archive.ts")));
  // Kept as library code for their own tests; never called at runtime.
  const retired = /\b(cleanupDeletedGenerations|purgeWorkspace|retryWorkspacePurges|cleanupAstraArtifacts)\s*\(/;
  const definedIn = new Set([path.join("lib", "mediaDeletion.ts"), path.join("lib", "purge.ts")]);
  // What a team makes. Security and housekeeping tables (sessions, chunks, logs) are not listed.
  const content = /DELETE FROM (uploads|projects|shots|canvas_items|cast_members|ideas|identities|crew_members|crew_solutions|workspace_rules|topups|ledger_checks|atomik_messages|atomik_steps|elements|element_attributes|attribute_versions|bindings|shot_presets|generations|project_library_uploads|workbench_projects)\b/;
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!definedIn.has(file) && retired.test(text)) offenders.push(`${file}: calls a retired purge`);
    if (content.test(text)) offenders.push(`${file}: ${text.match(content)![0]}`);
  }
  expect(offenders).toEqual([]);
});

test("a deleted workspace keeps its database and files; only its key is retired", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { retireDeletedWorkspaces, PURGE_GRACE_MS } = await import("../../lib/purge");
  await platformReady();
  const cols = (await platformDb().execute("PRAGMA table_info(workspaces)")).rows.map((r) => String(r.name));
  const values: Record<string, unknown> = {
    id: "gone", name: "Gone", slug: "gone", db_url: "file:gone.db", legacy: 0, gateway_key_id: "key_1",
    db_token_enc: "sealed", keys_enc: "sealed", deleted_at: Date.now() - PURGE_GRACE_MS - 1, created_at: 1, updated_at: 1,
  };
  // Fill any other required column so the fixture survives schema growth.
  for (const col of (await platformDb().execute("PRAGMA table_info(workspaces)")).rows)
    if (Number(col.notnull) && col.dflt_value == null && !(String(col.name) in values)) values[String(col.name)] = `x-${String(col.name)}`;
  const used = Object.keys(values).filter((k) => cols.includes(k));
  await platformDb().execute({ sql: `INSERT INTO workspaces(${used.join(",")}) VALUES(${used.map(() => "?").join(",")})`, args: used.map((k) => values[k] as string | number) });
  const revoked: string[] = [];
  expect(await retireDeletedWorkspaces(5, async (id) => { revoked.push(id); })).toEqual({ attempted: 1, failed: 0 });
  expect(revoked).toEqual(["key_1"]);
  const row = (await platformDb().execute("SELECT * FROM workspaces WHERE id='gone'")).rows[0];
  expect(row).toMatchObject({ gateway_key_id: null, purged_at: null, db_token_enc: "sealed", keys_enc: "sealed" });
});
