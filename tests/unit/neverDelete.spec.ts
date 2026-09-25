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
