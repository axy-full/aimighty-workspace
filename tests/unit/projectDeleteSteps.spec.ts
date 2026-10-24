import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/* Deleting a project archives its v30 production steps with it, and only where the steps table exists: a customer
   workspace has never made it, and its deletes must keep working (the film record's M1, docs/film-record-schema.md). */

const dir = mkdtempSync(path.join(tmpdir(), "particl-project-delete-steps-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const workspace = (name: string) => ({
  id: name, name, slug: name, dbUrl: `file:${path.join(dir, name + ".db")}`,
  legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false,
}) as TenantWorkspace;

async function harness() {
  const dbModule = await import("../../lib/db");
  const archive = await import("../../lib/archive");
  const { loadIsolated } = await import("./storageSeam");
  const route = loadIsolated<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts", {
    "@/lib/db": dbModule,
    "@/lib/archive": archive,
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: { id: "u1", role: "admin" } }) },
    "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
    "@/lib/workAccess": await import("../../lib/workAccess"),
  });
  const remove = (id: string) => route.DELETE(new Request(`https://studio.test/api/projects/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
  const { db, ready } = dbModule;
  const insert = async (table: string, values: Record<string, unknown>) => {
    const required = (await db().execute(`PRAGMA table_info(${table})`)).rows
      .filter((c) => Number(c.notnull) && c.dflt_value == null && !(String(c.name) in values));
    const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
    await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
  };
  const count = async (table: string, where = "1") => Number((await db().execute(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);
  return { db, ready, remove, insert, count };
}

test("a project deletes in a workspace that never made the steps table", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const h = await harness();
  await runInTenant(workspace("no-steps"), async () => {
    await h.ready();
    expect(await h.count("sqlite_master", "type='table' AND name='production_steps'")).toBe(0);
    await h.insert("projects", { id: "p1", name: "p1" });
    expect((await h.remove("p1")).status).toBe(200);
    expect(await h.count("projects")).toBe(0);
    expect(await h.count("sqlite_master", "type='table' AND name='production_steps'")).toBe(0);
  });
});

test("a project's steps are archived with it, and another project's or workspace's stay", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { stepStoreForTests } = await import("../../lib/productionModel/steps");
  const h = await harness();
  await runInTenant(workspace("with-steps"), async () => {
    await h.ready();
    /* The steps table as the store makes it; the rows written directly, so no switch is needed. */
    await stepStoreForTests(h.db(), "with-steps", { V30_PRODUCTION_MODEL: "1" }).ready();
    for (const project of ["p1", "p2"]) await h.insert("projects", { id: project, name: project });
    await h.insert("production_steps", { workspace_id: "with-steps", id: "st1", production_id: "p1", page_id: "brief", kind: "brief", surface: "document" });
    await h.insert("production_steps", { workspace_id: "with-steps", id: "st2", production_id: "p2", page_id: "brief", kind: "brief", surface: "document" });
    await h.insert("production_steps", { workspace_id: "elsewhere", id: "st3", production_id: "p1", page_id: "brief", kind: "brief", surface: "document" });
    expect((await h.remove("p1")).status).toBe(200);
    expect((await h.db().execute("SELECT id FROM production_steps ORDER BY id")).rows.map((r) => String(r.id))).toEqual(["st2", "st3"]);
    expect(await h.count("archived_rows", "table_name='production_steps' AND row_id='st1'")).toBe(1);
    expect(await h.count("archived_rows", "table_name='production_steps' AND row_id IN ('st2','st3')")).toBe(0);
  });
});
