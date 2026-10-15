import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-memory-old-refs-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL ??= `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
function workspace(): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0 } as TenantWorkspace;
}
const person = (id: string, role: "owner" | "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: role === "owner", disabled: false, lastSeen: null, createdAt: 0 }) as TenantUser;

/**
 * Old references (kept before the board gate): a Library reference keeps the title it was kept with, and the Memory list and Atomik's planner serve that title to everyone who may read the
 * entry. They must not serve it to a person who may not open the take or the upload it names (a private board's take is its owner's; the same helpers the board uses, mayReadTake and
 * uploadOpenableBy): for that person the entry reads as no longer there (`available: false`, no title), and the planner leaves it out. Nothing is migrated or rewritten.
 */
const TITLE = "Secret take title";
const DELETED_TITLE = "Deleted secret title";
const mem = (n: string, values: Record<string, unknown>) => ({ id: `mem_${n.padEnd(20, "a")}`, kind: "reference", text: `Use this look ${n}.`, project_id: null, asset_kind: "image", status: "active", source: "person", created_at: 1, updated_at: 1, ...values });

async function seedOld() {
  const ws = workspace(); const owner = person("u_owner", "owner"), mate = person("u_mate");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { mappedId, DRAFT_PROJECT_PREFIX } = await import("../../lib/draftProject");
  const m = await import("../../lib/atomikMemory");
  const board = mappedId(DRAFT_PROJECT_PREFIX, ws.id, owner.id, "d1");
  await runInTenant(ws, async () => {
    await ready(); await m.memoryReady();
    const ins = async (table: string, values: Record<string, unknown>) => {
      const required = (await db().execute(`PRAGMA table_info(${table})`)).rows.filter((c) => Number(c.notnull) && c.dflt_value == null && !Number(c.pk) && !(String(c.name) in values));
      const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
      await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
    };
    await ins("projects", { id: board, name: "Private board", created_at: 1 });
    await ins("projects", { id: "prod_open", name: "Ordinary production", created_at: 1 });
    const body = JSON.stringify({ id: "d1", name: "Draft", productionProjectId: board });
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${owner.id}:d1`, owner.id, "d1", "Draft", body, 1] });
    const take = (id: string, project: string, title: string) => ins("generations", { id, model: "m", prompt: `Prompt of ${title}`, params: "{}", status: "succeeded", created_at: 1, updated_at: 1, kind: "image", title, project_id: project });
    await take("gen_private", board, TITLE); await take("gen_open", "prod_open", "Open take title");
    /* Soft-deleted takes (restorable): one on the private board, one on an ordinary project. */
    await take("gen_private_del", board, DELETED_TITLE); await take("gen_open_del", "prod_open", "Dropped open title");
    await db().execute("UPDATE generations SET deleted=1 WHERE id IN ('gen_private_del','gen_open_del')");
    await ins("uploads", { id: "up_private", uploader_id: owner.id, filename: "secret-photo.png", kind: "image", mime: "image/png" });
    await ins("uploads", { id: "up_unowned", uploader_id: null, filename: "old-logo.png", kind: "image", mime: "image/png" });
    const keep = (n: string, assetId: string, label: string) => ins("atomik_memory", mem(n, { workspace_id: ws.id, asset_id: assetId, asset_label: label, created_by: owner.id }));
    await keep("priv", "generation:gen_private", TITLE); await keep("open", "generation:gen_open", "Open take title");
    await keep("pdel", "generation:gen_private_del", DELETED_TITLE); await keep("odel", "generation:gen_open_del", "Dropped open title");
    /* A private upload that was hard-deleted: no row is left to ask who could open it. */
    await keep("urem", "upload:up_removed", "removed-photo.png");
    await keep("upriv", "upload:up_private", "secret-photo.png"); await keep("uopen", "upload:up_unowned", "old-logo.png");
  }, { user: owner });
  const as = <T,>(who: TenantUser, fn: () => Promise<T>) => runInTenant(ws, fn, { user: who });
  const view = (who: TenantUser) => as(who, async () => ({
    list: await m.listMemory(null, who.id),
    planner: await m.plannerMemoryText({ projectId: null, query: "look", viewer: who.id }),
  }));
  return { ws, owner, mate, board, m, as, view, db };
}
const byId = (list: { id: string }[], n: string) => list.find((e) => e.id === `mem_${n.padEnd(20, "a")}`) as { assetLabel: string | null; available: boolean } | undefined;

test("an old reference to a private take or upload is not served to a person who may not open it: no title, reads as no longer there, left out of the planner", async () => {
  const { mate, view } = await seedOld();
  const seen = await view(mate);
  const json = JSON.stringify(seen);
  expect(json).not.toContain(TITLE);
  expect(json).not.toContain("secret-photo");
  for (const n of ["priv", "upriv"]) { const e = byId(seen.list, n); expect(e?.available, n).toBe(false); expect(e?.assetLabel, n).toBeNull(); }
  expect(seen.planner).not.toContain("Use this look priv.");
  expect(seen.planner).not.toContain("Use this look upriv.");
  /* What everyone may open is untouched: an ordinary project's take, and an upload with no uploader. */
  expect(byId(seen.list, "open")).toMatchObject({ available: true, assetLabel: "Open take title" });
  expect(byId(seen.list, "uopen")).toMatchObject({ available: true, assetLabel: "old-logo.png" });
  expect(seen.planner).toContain("Open take title");
  expect(seen.planner).toContain("old-logo.png");
});

test("the owner of the take still sees their own title, in the list and in the planner", async () => {
  const { owner, view } = await seedOld();
  const seen = await view(owner);
  expect(byId(seen.list, "priv")).toMatchObject({ available: true, assetLabel: TITLE });
  expect(byId(seen.list, "upriv")).toMatchObject({ available: true, assetLabel: "secret-photo.png" });
  expect(seen.planner).toContain(TITLE);
});

test("once the owner shares the board, a teammate sees the take's title as before", async () => {
  const { ws, owner, mate, view, as, db } = await seedOld();
  await as(owner, () => db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner=?", args: [owner.id] }));
  const seen = await view(mate);
  expect(byId(seen.list, "priv")).toMatchObject({ available: true, assetLabel: TITLE });
  expect(seen.planner).toContain(TITLE);
  /* The upload on it was never part of the board's sharing: still the uploader's. */
  expect(byId(seen.list, "upriv")?.available).toBe(false);
  void ws;
});

test("a take on the marked sample is everyone's to read, the platform owner's included", async () => {
  const { ws, owner, mate, board, view, as, db } = await seedOld();
  const platform = person("u_platform", "admin");
  const previous = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = "u_platform@example.test";
  try {
    const mark = { version: 1, projectId: board, name: "Sample", draftOwner: owner.id, draftId: "d1", markedBy: owner.id, markedAt: 1 };
    await as(owner, () => db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: ["sampleProduction", JSON.stringify(mark), owner.id, 1] }));
    for (const who of [mate, platform]) {
      const seen = await view(who);
      expect(byId(seen.list, "priv"), who.id).toMatchObject({ available: true, assetLabel: TITLE });
      expect(seen.planner, who.id).toContain(TITLE);
    }
  } finally {
    if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = previous;
  }
  void ws;
});

test("a DELETED private take and a REMOVED private upload read blank for a teammate: no title, and no tell between them and a private one", async () => {
  const { mate, view } = await seedOld();
  const seen = await view(mate);
  const json = JSON.stringify(seen);
  expect(json).not.toContain(DELETED_TITLE);
  expect(json).not.toContain("removed-photo");
  for (const n of ["priv", "pdel", "urem"]) expect(byId(seen.list, n), n).toMatchObject({ available: false, assetLabel: null });
  /* A deleted take of an ordinary project is everyone's, as before: gone from the Library, its title kept. */
  expect(byId(seen.list, "odel")).toMatchObject({ available: false, assetLabel: "Dropped open title" });
  expect(seen.planner).not.toContain("Use this look pdel.");
  expect(seen.planner).not.toContain("Use this look urem.");
});

test("the owner still sees their own deleted take's title (gone, title kept); a removed upload has no row to ask, so it reads blank for everyone", async () => {
  const { owner, view } = await seedOld();
  const seen = await view(owner);
  expect(byId(seen.list, "pdel")).toMatchObject({ available: false, assetLabel: DELETED_TITLE });
  expect(byId(seen.list, "urem")).toMatchObject({ available: false, assetLabel: null });
  expect(seen.planner).not.toContain("Use this look pdel.");
});

test("an admin gets a blank title for a member's private take: an admin has no elevation here", async () => {
  const { view } = await seedOld();
  const admin = person("u_admin", "admin");
  const seen = await view(admin);
  expect(JSON.stringify(seen)).not.toContain(TITLE);
  expect(byId(seen.list, "priv")).toMatchObject({ available: false, assetLabel: null });
  expect(seen.planner).not.toContain("Use this look priv.");
});

test("an agent reading for a turn, with no viewer given, opens nothing private either (its id is not a person's)", async () => {
  const { ws, m, as } = await seedOld();
  const agent = person("agent:run1", "member");
  const text = await as(agent, () => m.plannerMemoryText({ projectId: null, query: "look" }));
  expect(text).not.toContain(TITLE);
  expect(text).not.toContain("Use this look priv.");
  void ws;
});
