import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A board's Trash (lib/boardTrash.ts): a take or a shot removed to it, what the browser removed recorded in it, and each put back; nothing erased and nothing
 * that touches billing. Scoped to the workspace and to the people who can write the board (a private board's is its owner's; to anyone else it is as absent as
 * an unknown board). Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-trash-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member", owner = false) => ({ id, email: `${id}@example.test`, name: id, role, owner, disabled: false, lastSeen: null, createdAt: 0 });
type Actor = { user: ReturnType<typeof user>; token?: unknown };
const as = (id: string, role: "admin" | "member" = "member", token = false, owner = false): Actor => ({ user: user(id, role, owner), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null } } : {}) });
const OWNER = as("u_owner"), MATE = as("u_mate"), MATE_TOKEN = as("u_mate", "member", true), ADMIN = as("u_admin", "admin"), ADMIN_TOKEN = as("u_admin", "admin", true);

function loadRoute<T>(file: string, who: () => Actor): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = { "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ ...who() }) } };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

/* Boards: a private one (the owner's), and an ordinary production nobody owns as a draft (the workspace's, so a member changes only what is their own and an admin anything). */
async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const priv = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const id of ["u_owner", "u_mate", "u_admin"]) await db.execute({ sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'x',0)", args: [id, `${id}@example.test`, id] });
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,'Private',0),('prod_open','Ordinary',0)", args: [priv] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: priv })] });
    const take = (id: string, project: string, by: string, status = "succeeded", cost = 0.5) => db.execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url,bytes,cost_usd) VALUES(?,?,?,?,?,1,1,'image',?,0,?,?,?,?,?)",
      args: [id, "m", `prompt ${id}`, "{}", status, `Title ${id}`, by, project, status === "succeeded" ? `/api/media/${id}` : null, status === "succeeded" ? 1000 : 0, cost] });
    await take(`t_priv_${run}`, priv, "u_owner"); await take(`t_run_${run}`, priv, "u_owner", "running"); await take(`t_held_${run}`, priv, "u_owner", "held");
    await take(`t_mate_${run}`, "prod_open", "u_mate"); await take(`t_owner_${run}`, "prod_open", "u_owner");
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,status,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'open',1,'u_owner',1,1)", args: [`shot_${run}`, priv, "010", "Opening", "d"] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,status,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'open',1,'u_owner',1,1)", args: [`shot_open_${run}`, "prod_open", "010", "Open shot", "d"] });
    await take(`t_inshot1_${run}`, priv, "u_owner"); await take(`t_inshot2_${run}`, priv, "u_owner");
    await db.execute({ sql: "UPDATE generations SET shot_id=? WHERE id IN (?,?)", args: [`shot_${run}`, `t_inshot1_${run}`, `t_inshot2_${run}`] });
    await db.execute({ sql: "INSERT INTO bindings(id,shot_id,project_id,slot,ordinal,element_id,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'el1','u_owner',1,1)", args: [`b_${run}`, `shot_${run}`, priv, "character"] });
  }, { user: user("u_owner") });
  return { tenant, database, priv };
}

function api(tenant: typeof import("../../lib/tenant"), ws: TenantWorkspace) {
  let who: Actor = OWNER;
  const list = loadRoute<typeof import("../../app/api/boards/[id]/trash/route")>("app/api/boards/[id]/trash/route.ts", () => who);
  const restore = loadRoute<typeof import("../../app/api/boards/[id]/trash/[entryId]/restore/route")>("app/api/boards/[id]/trash/[entryId]/restore/route.ts", () => who);
  const call = <R>(actor: Actor, fn: () => Promise<R>, within = ws) => { who = actor; return tenant.runInTenant(within, fn, { user: actor.user, token: actor.token as never }); };
  const json = async (res: Response) => [res.status, await res.json()] as const;
  return {
    items: (actor: Actor, board: string, within?: TenantWorkspace) => call(actor, async () => json(await list.GET(new Request("https://particl.test/x"), { params: Promise.resolve({ id: board }) })), within),
    remove: (actor: Actor, board: string, body: unknown, within?: TenantWorkspace) => call(actor, async () => json(await list.POST(new Request("https://particl.test/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: board }) })), within),
    restore: (actor: Actor, board: string, entry: string, within?: TenantWorkspace) => call(actor, async () => json(await restore.POST(new Request("https://particl.test/x", { method: "POST" }), { params: Promise.resolve({ id: board, entryId: entry }) })), within),
  };
}

/** What billing and the take's own money are, as one string: nothing the Trash does may change it. */
async function money(tenant: typeof import("../../lib/tenant"), database: typeof import("../../lib/db"), ws: TenantWorkspace) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ledger = JSON.stringify((await platformDb().execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=? ORDER BY id", args: [ws.id] })).rows) + JSON.stringify((await platformDb().execute({ sql: "SELECT * FROM credit_grants WHERE workspace_id=? ORDER BY id", args: [ws.id] })).rows);
  const takes = await tenant.runInTenant(ws, async () => JSON.stringify((await database.db().execute("SELECT id, cost_usd, refine_cost_usd, params, status, bytes, stored_url FROM generations ORDER BY id")).rows), { user: user("u_owner") });
  return ledger + takes;
}

test("a take: removed to the Trash and put back whole; billing and its bytes untouched; removing twice is one removal; a render still going is refused", async () => {
  const ws = workspace(`bt-a-${run}`);
  const { tenant, database, priv } = await fixture(ws);
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,'image','google','m','succeeded',0.5,5,1,'u_owner',1,1)", args: [`t_priv_${run}`, ws.id, priv] });
  const trash = api(tenant, ws);
  const before = await money(tenant, database, ws);
  const removed = await trash.remove(OWNER, priv, { kind: "take", itemId: `t_priv_${run}` });
  expect(removed[0]).toBe(200);
  expect(removed[1].entry).toMatchObject({ kind: "take", itemId: `t_priv_${run}`, label: `Title t_priv_${run}`, restorable: true });
  expect(await trash.remove(OWNER, priv, { kind: "take", itemId: `t_priv_${run}` })).toEqual([200, { entry: { ...removed[1].entry, removedBy: removed[1].entry.removedBy } }]);
  const read = async (id: string) => tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT deleted, stored_url, bytes FROM generations WHERE id=?", args: [id] })).rows[0], { user: user("u_owner") });
  expect(Number((await read(`t_priv_${run}`)).deleted)).toBe(1);
  const items = await trash.items(OWNER, priv);
  expect(items[1].items.map((i: { itemId: string }) => i.itemId)).toEqual([`t_priv_${run}`]);
  expect(items[1].items[0].removedBy).toEqual({ id: "u_owner", name: "u_owner" });
  /* Its original is kept: the clean-up of deleted takes leaves a take in the Trash alone. */
  const { cleanupDeletedGenerations } = await import("../../lib/mediaDeletion");
  await tenant.runInTenant(ws, () => cleanupDeletedGenerations(20), { user: user("u_owner") });
  expect(await read(`t_priv_${run}`)).toMatchObject({ stored_url: `/api/media/t_priv_${run}`, bytes: 1000 });
  /* Restore: once, whole. */
  const back = await trash.restore(OWNER, priv, removed[1].entry.id);
  expect(back[0]).toBe(200);
  expect(Number((await read(`t_priv_${run}`)).deleted)).toBe(0);
  expect((await trash.items(OWNER, priv))[1].items).toEqual([]);
  expect((await trash.restore(OWNER, priv, removed[1].entry.id))[0]).toBe(404);
  /* Billing and the take's money are exactly as they were. */
  expect(await money(tenant, database, ws)).toBe(before);
  /* A render still going, and one waiting for approval, are not removed; a take of another board is an unknown take. */
  expect((await trash.remove(OWNER, priv, { kind: "take", itemId: `t_run_${run}` }))[0]).toBe(409);
  expect((await trash.remove(OWNER, priv, { kind: "take", itemId: `t_held_${run}` }))[0]).toBe(409);
  expect((await trash.remove(OWNER, priv, { kind: "take", itemId: `t_mate_${run}` }))[0]).toBe(404);
  expect((await trash.remove(OWNER, priv, { kind: "take", itemId: "t_none" }))[0]).toBe(404);
  /* A take hidden before the Trash existed is listed (no one recorded), and can be put back by its `take:` id. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE generations SET deleted=1 WHERE id=?", args: [`t_inshot1_${run}`] }), { user: user("u_owner") });
  const legacy = (await trash.items(OWNER, priv))[1].items.find((i: { itemId: string }) => i.itemId === `t_inshot1_${run}`);
  expect(legacy).toMatchObject({ id: `take:t_inshot1_${run}`, removedBy: null, restorable: true });
  expect((await trash.restore(OWNER, priv, legacy.id))[0]).toBe(200);
  expect(Number((await read(`t_inshot1_${run}`)).deleted)).toBe(0);
  expect(await money(tenant, database, ws)).toBe(before);
});

test("a shot: removed with its wires and its takes unfiled, put back with its wires and the takes that were filed under it", async () => {
  const ws = workspace(`bt-b-${run}`);
  const { tenant, database, priv } = await fixture(ws);
  const trash = api(tenant, ws);
  const before = await money(tenant, database, ws);
  const inDb = <R>(fn: (db: ReturnType<typeof database.db>) => Promise<R>) => tenant.runInTenant(ws, () => fn(database.db()), { user: user("u_owner") });
  const removed = await trash.remove(OWNER, priv, { kind: "shot", itemId: `shot_${run}` });
  expect(removed[0]).toBe(200);
  expect(removed[1].entry).toMatchObject({ kind: "shot", label: "Opening" });
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT id FROM shots WHERE id=?", args: [`shot_${run}`] })).rows.length)).toBe(0);
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT id FROM bindings WHERE shot_id=?", args: [`shot_${run}`] })).rows.length)).toBe(0);
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT id FROM generations WHERE shot_id=?", args: [`shot_${run}`] })).rows.length)).toBe(0);
  /* The usual archive copy is there too: nothing erased. */
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT id FROM archived_rows WHERE table_name='shots' AND row_id=?", args: [`shot_${run}`] })).rows.length)).toBe(1);
  expect((await trash.remove(OWNER, priv, { kind: "shot", itemId: `shot_${run}` }))[0]).toBe(404);
  const back = await trash.restore(OWNER, priv, removed[1].entry.id);
  expect(back[0]).toBe(200);
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT title, code FROM shots WHERE id=?", args: [`shot_${run}`] })).rows[0])).toMatchObject({ title: "Opening", code: "010" });
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT id FROM bindings WHERE shot_id=?", args: [`shot_${run}`] })).rows.length)).toBe(1);
  expect(await inDb(async (db) => (await db.execute({ sql: "SELECT id FROM generations WHERE shot_id=? ORDER BY id", args: [`shot_${run}`] })).rows.map((r) => String(r.id)))).toEqual([`t_inshot1_${run}`, `t_inshot2_${run}`]);
  expect((await trash.restore(OWNER, priv, removed[1].entry.id))[0]).toBe(404);
  expect(await money(tenant, database, ws)).toBe(before);
});

test("what the browser removed (a card, a note, a frame...) is recorded whole and handed back once; a bad kind or an oversized item is refused", async () => {
  const ws = workspace(`bt-c-${run}`);
  const { tenant, priv } = await fixture(ws);
  const trash = api(tenant, ws);
  const node = { id: "node-abc", type: "note", title: "A note", text: "words", x: 10, y: 20, width: 200, linked: [] };
  const saved = await trash.remove(OWNER, priv, { kind: "note", itemId: "node-abc", label: "A note", payload: node });
  expect(saved[0]).toBe(200);
  expect(saved[1].entry).toMatchObject({ kind: "note", itemId: "node-abc", label: "A note", restorable: true });
  expect(JSON.stringify(saved[1])).not.toContain("words");
  expect((await trash.remove(OWNER, priv, { kind: "note", itemId: "node-abc", payload: node }))[1].entry.id).toBe(saved[1].entry.id);
  const listed = await trash.items(OWNER, priv);
  expect(listed[1].items.map((i: { kind: string }) => i.kind)).toEqual(["note"]);
  expect(JSON.stringify(listed[1])).not.toContain("words");
  const back = await trash.restore(OWNER, priv, saved[1].entry.id);
  expect(back[1].payload).toEqual(node);
  expect((await trash.restore(OWNER, priv, saved[1].entry.id))[0]).toBe(404);
  expect((await trash.remove(OWNER, priv, { kind: "nonsense", itemId: "x", payload: {} }))[0]).toBe(400);
  expect((await trash.remove(OWNER, priv, { kind: "frame", itemId: "x" }))[0]).toBe(400);
  expect((await trash.remove(OWNER, priv, { kind: "frame", itemId: "../x", payload: {} }))[0]).toBe(400);
  expect((await trash.remove(OWNER, priv, { kind: "frame", itemId: "big", payload: { text: "x".repeat(250_000) } }))[0]).toBe(413);
});

test("who may: the board's owner on a private board; a member only their own work on an ordinary one; an admin anything there; a private board is absent to everyone else; another workspace has none", async () => {
  const ws = workspace(`bt-d-${run}`);
  const { tenant, database, priv } = await fixture(ws);
  const trash = api(tenant, ws);
  /* A private board: as absent as an unknown board to a teammate, a teammate's token and an admin (the board's reach is its owner's; lib/draftProject.ts). */
  const unknown = await trash.items(MATE, "prj_wb_doesnotexist0000000000");
  expect(unknown[0]).toBe(404);
  for (const actor of [MATE, MATE_TOKEN, ADMIN, ADMIN_TOKEN]) {
    expect(await trash.items(actor, priv), actor.user.id).toEqual(unknown);
    expect(await trash.remove(actor, priv, { kind: "take", itemId: `t_priv_${run}` }), actor.user.id).toEqual(unknown);
    expect(await trash.remove(actor, priv, { kind: "note", itemId: "n1", payload: {} }), actor.user.id).toEqual(unknown);
  }
  const mine = await trash.remove(OWNER, priv, { kind: "take", itemId: `t_priv_${run}` });
  for (const actor of [MATE, MATE_TOKEN, ADMIN]) expect(await trash.restore(actor, priv, mine[1].entry.id), actor.user.id).toEqual(unknown);
  expect((await trash.restore(OWNER, priv, mine[1].entry.id))[0]).toBe(200);
  /* An ordinary production: a member removes their own take and not the owner's; an admin removes anything. */
  expect((await trash.remove(MATE, "prod_open", { kind: "take", itemId: `t_mate_${run}` }))[0]).toBe(200);
  expect((await trash.remove(MATE, "prod_open", { kind: "take", itemId: `t_owner_${run}` }))[0]).toBe(403);
  expect((await trash.remove(MATE_TOKEN, "prod_open", { kind: "shot", itemId: `shot_open_${run}` }))[0]).toBe(403);
  expect((await trash.remove(ADMIN_TOKEN, "prod_open", { kind: "take", itemId: `t_owner_${run}` }))[0]).toBe(200);
  expect((await trash.remove(ADMIN, "prod_open", { kind: "shot", itemId: `shot_open_${run}` }))[0]).toBe(200);
  const open = await trash.items(MATE, "prod_open");
  expect(open[1].items.map((i: { kind: string }) => i.kind).sort()).toEqual(["shot", "take", "take"]);
  /* Put back by someone who may not change that work: refused, and nothing changes. */
  const theirs = open[1].items.find((i: { itemId: string }) => i.itemId === `t_owner_${run}`);
  expect((await trash.restore(MATE, "prod_open", theirs.id))[0]).toBe(403);
  expect((await trash.restore(ADMIN, "prod_open", theirs.id))[0]).toBe(200);
  /* Another workspace: its database has none of these boards or entries. */
  const other = workspace(`bt-d2-${run}`);
  await tenant.runInTenant(other, async () => { await database.ready(); }, { user: user("u_admin", "admin") });
  expect(await trash.items(ADMIN, "prod_open", other)).toEqual(unknown);
  expect(await trash.items(ADMIN, priv, other)).toEqual(unknown);
  expect(await trash.restore(ADMIN, "prod_open", theirs.id, other)).toEqual(unknown);
});

test("the marked sample is nobody's to write: removing from it or restoring into it is the view-only refusal, and its Trash is not listed", async () => {
  const ws = workspace(`bt-e-${run}`);
  const { tenant, database, priv } = await fixture(ws);
  const trash = api(tenant, ws);
  const mine = await trash.remove(OWNER, priv, { kind: "take", itemId: `t_priv_${run}` });
  expect(mine[0]).toBe(200);
  /* The owner's board is now the workspace's marked sample: a write into it is refused for everyone, and nothing moves. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "INSERT OR REPLACE INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_admin',0)", args: [JSON.stringify({ version: 1, projectId: priv, name: "Sample", draftOwner: "u_owner", draftId: "d1", markedBy: "u_admin", markedAt: 0 })] }), { user: user("u_admin", "admin") });
  for (const actor of [OWNER, MATE, ADMIN]) {
    const removed = await trash.remove(actor, priv, { kind: "note", itemId: "n1", payload: {} });
    expect(removed[0], actor.user.id).toBe(403);
    expect(removed[1].code ?? removed[1].error, actor.user.id).toBeTruthy();
    expect((await trash.restore(actor, priv, mine[1].entry.id))[0], actor.user.id).toBe(403);
  }
  expect((await trash.items(OWNER, priv))[0]).toBe(404);
  expect(await tenant.runInTenant(ws, async () => Number((await database.db().execute({ sql: "SELECT deleted FROM generations WHERE id=?", args: [`t_priv_${run}`] })).rows[0].deleted), { user: user("u_owner") })).toBe(1);
});


test("browser items are the remover's alone: a teammate (or an admin) cannot list or restore my note, and cannot pre-empt it with a forged one", async () => {
  const ws = workspace(`bt-f-${run}`);
  const { tenant } = await fixture(ws);
  const trash = api(tenant, ws);
  /* An ordinary production, where several people can write: each person's draft is their own, so each person's Trash of what they removed is too. */
  const real = { id: "node-same", type: "note", title: "Mine", text: "the owner's real words", x: 1, y: 2, width: 200, linked: [] };
  const forged = { id: "node-same", type: "note", title: "Forged", text: "a teammate's forgery", x: 9, y: 9, width: 200, linked: [] };
  /* A teammate records first, under the id the owner's card has. */
  const planted = await trash.remove(MATE, "prod_open", { kind: "note", itemId: "node-same", label: "Forged", payload: forged });
  expect(planted[0]).toBe(200);
  /* The owner's own removal of that card is its own record (not dropped for the teammate's), and it hands back the owner's payload. */
  const mine = await trash.remove(OWNER, "prod_open", { kind: "note", itemId: "node-same", label: "Mine", payload: real });
  expect(mine[0]).toBe(200);
  expect(mine[1].entry.id).not.toBe(planted[1].entry.id);
  expect((await trash.items(OWNER, "prod_open"))[1].items.map((i: { id: string }) => i.id)).toEqual([mine[1].entry.id]);
  expect((await trash.items(MATE, "prod_open"))[1].items.map((i: { id: string }) => i.id)).toEqual([planted[1].entry.id]);
  expect((await trash.items(ADMIN, "prod_open"))[1].items).toEqual([]);
  /* Nobody else can restore it, whatever the id says: the answer is an entry that is not there. */
  const gone = await trash.restore(OWNER, "prod_open", "nothing-like-this");
  for (const actor of [MATE, MATE_TOKEN, ADMIN, ADMIN_TOKEN]) expect(await trash.restore(actor, "prod_open", mine[1].entry.id), actor.user.id).toEqual(gone);
  expect((await trash.restore(MATE, "prod_open", planted[1].entry.id))[1].payload.text).toBe("a teammate's forgery");
  expect((await trash.restore(OWNER, "prod_open", mine[1].entry.id))[1].payload.text).toBe("the owner's real words");
});

test("a failed shot restore keeps its entry (the claim rolls back); a person holds at most 500 browser items on a board, and the cap is per person", async () => {
  const ws = workspace(`bt-g-${run}`);
  const { tenant, database, priv } = await fixture(ws);
  const trash = api(tenant, ws);
  const inDb = <R>(fn: (db: ReturnType<typeof database.db>) => Promise<R>) => tenant.runInTenant(ws, () => fn(database.db()), { user: user("u_owner") });
  const removed = await trash.remove(OWNER, priv, { kind: "shot", itemId: `shot_${run}` });
  expect(removed[0]).toBe(200);
  /* A shot with the same id appears (a teammate's tool, a re-import): the restore is refused in plain words and the entry is still there. */
  await inDb((db) => db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,status,position,created_by,created_at,updated_at) VALUES(?,?,'020','Clash','d','open',2,'u_owner',1,1)", args: [`shot_${run}`, priv] }));
  const refused = await trash.restore(OWNER, priv, removed[1].entry.id);
  expect(refused[0]).toBe(409);
  expect(refused[1].error).toMatch(/already on the board/);
  expect((await trash.items(OWNER, priv))[1].items.map((i: { id: string }) => i.id)).toEqual([removed[1].entry.id]);
  await inDb((db) => db.execute({ sql: "DELETE FROM shots WHERE id=?", args: [`shot_${run}`] }));
  expect((await trash.restore(OWNER, priv, removed[1].entry.id))[0]).toBe(200);
  /* The cap: 500 open browser items by one person on one board; the next is refused in words; another person's own are not counted against them. */
  await inDb((db) => db.batch(Array.from({ length: 500 }, (_, i) => ({ sql: "INSERT INTO board_trash(id,project_id,kind,item_id,label,payload,removed_by,removed_at,holder) VALUES(?,?,'note',?,'n','{}','u_owner',1,'u_owner')", args: [`cap-${i}`, "prod_open", `n-${i}`] })), "write"));
  const over = await trash.remove(OWNER, "prod_open", { kind: "note", itemId: "n-over", payload: {} });
  expect(over[0]).toBe(409);
  expect(over[1].error).toMatch(/500 items/);
  expect((await trash.remove(OWNER, "prod_open", { kind: "note", itemId: "n-0", payload: {} }))[0], "an item already recorded is the same record").toBe(200);
  expect((await trash.remove(MATE, "prod_open", { kind: "note", itemId: "n-over", payload: {} }))[0], "the cap is per person").toBe(200);
});

test("the customer export holds a person's own browser items and the takes and shots of boards they may list, never a teammate's private Trash", async () => {
  const ws = workspace(`bt-h-${run}`);
  const { tenant, priv } = await fixture(ws);
  const { workspaceExport } = await import("../../lib/workspaceExport");
  const trash = api(tenant, ws);
  await trash.remove(OWNER, priv, { kind: "note", itemId: "n-owner", label: "Owner's note", payload: { text: "private words" } });
  await trash.remove(OWNER, priv, { kind: "shot", itemId: `shot_${run}` });
  await trash.remove(OWNER, priv, { kind: "take", itemId: `t_priv_${run}` });
  await trash.remove(MATE, "prod_open", { kind: "note", itemId: "n-mate", label: "Mate's note", payload: { text: "mate words" } });
  await trash.remove(MATE, "prod_open", { kind: "take", itemId: `t_mate_${run}` });
  const exported = (actor: Actor) => tenant.runInTenant(ws, () => workspaceExport(actor.user.id, actor.user.email), { user: actor.user });
  const items = (e: { board_trash?: { item_id: string; kind: string }[] }) => (e.board_trash ?? []).map((r) => `${r.kind}:${r.item_id}`).sort();
  /* The owner: their own note, and the shot and take on their own board and the ordinary production's take. */
  expect(items(await exported(OWNER) as never)).toEqual([`note:n-owner`, `shot:shot_${run}`, `take:t_mate_${run}`, `take:t_priv_${run}`].sort());
  /* A teammate: their own note, and what is on boards they may list: the ordinary production's take, and none of the owner's private board's. */
  const mate = await exported(MATE) as never;
  expect(items(mate)).toEqual([`note:n-mate`, `take:t_mate_${run}`].sort());
  expect(JSON.stringify((mate as { board_trash?: unknown }).board_trash)).not.toMatch(/private words|Owner's note|prj_wb_/);
  /* An admin who removed nothing: only what is on boards they may list. */
  expect(items(await exported(ADMIN) as never)).toEqual([`take:t_mate_${run}`]);
});

test("a take removed or put back through the older routes goes through the Trash too, and one in the Trash cannot be moved; an agent puts back only what it removed", async () => {
  const ws = workspace(`bt-i-${run}`);
  const { tenant, database } = await fixture(ws);
  const trash = api(tenant, ws);
  let who: Actor = ADMIN;
  const jobs = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => who);
  const call = (actor: Actor, method: "PATCH" | "DELETE", id: string, body?: unknown) => { who = actor; return tenant.runInTenant(ws, async () => { const res = await jobs[method](new Request(`https://particl.test/api/jobs/${id}`, { method, headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${ws.id}-${actor.user.id}` }, body: body ? JSON.stringify(body) : undefined }), { params: Promise.resolve({ id }) }); return [res.status, await res.json().catch(() => ({}))] as const; }, { user: actor.user, token: actor.token as never }); };
  const open = async () => (await trash.items(ADMIN, "prod_open"))[1].items as { id: string; itemId: string; kind: string; removedBy: { id: string } | null }[];
  /* PATCH trashed:true records it; trashed:false closes the record. */
  const first = await call(ADMIN, "PATCH", `t_mate_${run}`, { trashed: true });
  expect(first[1], JSON.stringify(first[1])).toBeTruthy();
  expect(first[0], JSON.stringify(first[1])).toBe(200);
  expect((await open()).map((i) => i.itemId)).toEqual([`t_mate_${run}`]);
  expect((await open())[0].removedBy).toMatchObject({ id: "u_admin" });
  /* A take in the Trash is not moved until it is put back. */
  expect((await call(ADMIN, "PATCH", `t_mate_${run}`, { projectId: null }))[0]).toBe(409);
  expect((await call(ADMIN, "PATCH", `t_mate_${run}`, { trashed: false }))[0]).toBe(200);
  expect(await open()).toEqual([]);
  /* DELETE too. */
  expect((await call(ADMIN, "DELETE", `t_owner_${run}`))[0]).toBe(200);
  const entry = (await open())[0];
  expect(entry).toMatchObject({ itemId: `t_owner_${run}`, kind: "take" });
  /* Restoring by its `take:` id closes the same open record. */
  expect((await trash.restore(ADMIN, "prod_open", `take:t_owner_${run}`))[0]).toBe(200);
  expect(await open()).toEqual([]);
  /* An agent run puts back only what it removed itself. */
  const { restoreFromTrash, removeToTrash } = await import("../../lib/boardTrash");
  const agent = { id: "agent:run1", role: "member" as const };
  await trash.remove(ADMIN, "prod_open", { kind: "take", itemId: `t_owner_${run}` });
  const theirs = (await open())[0];
  const refused = await tenant.runInTenant(ws, () => restoreFromTrash(agent, "prod_open", theirs.id), { user: user("u_admin", "admin") });
  expect(refused).toMatchObject({ ok: false, status: 404 });
  expect((await open()).map((i) => i.id)).toEqual([theirs.id]);
  void removeToTrash; void database;
});

test("the registry tools list_trash, remove_to_trash and restore_from_trash run the same routes under the same rules, as the token's person", async () => {
  const { runTool } = await import("../../lib/mcp");
  const ws = workspace(`bt-j-${run}`);
  const { tenant } = await fixture(ws);
  const trash = api(tenant, ws);
  let who: Actor = MATE_TOKEN;
  const list = loadRoute<typeof import("../../app/api/boards/[id]/trash/route")>("app/api/boards/[id]/trash/route.ts", () => who);
  const restore = loadRoute<typeof import("../../app/api/boards/[id]/trash/[entryId]/restore/route")>("app/api/boards/[id]/trash/[entryId]/restore/route.ts", () => who);
  const wsList = loadRoute<typeof import("../../app/api/trash/route")>("app/api/trash/route.ts", () => who);
  const wsRestore = loadRoute<typeof import("../../app/api/trash/[entryId]/restore/route")>("app/api/trash/[entryId]/restore/route.ts", () => who);
  /* The caller the MCP bridge makes (lib/mcp.ts makeCaller), answered by the real routes for this token's person. */
  const caller = (actor: Actor) => async (pathname: string, init: { method?: string; body?: unknown } = {}) => {
    who = actor;
    return tenant.runInTenant(ws, async () => {
      if (pathname === "/api/projects") return { projects: [{ id: "prod_open", name: "Ordinary" }] };
      const url = new URL(`https://particl.test${pathname}`);
      const w = /^\/api\/trash(?:\/([^/]+)\/restore)?$/.exec(url.pathname);
      if (w) {
        const res = w[1] ? await wsRestore.POST(new Request(url, { method: "POST" }), { params: Promise.resolve({ entryId: w[1] }) }) : await wsList.GET(new Request(url), undefined as never);
        const json = (await res.json()) as Record<string, unknown>;
        if (!res.ok) throw new Error(String(json.error));
        return json;
      }
      const m = /^\/api\/boards\/([^/]+)\/trash(?:\/([^/]+)\/restore)?$/.exec(url.pathname)!;
      const req = new Request(url, { method: init.method ?? "GET", body: init.body ? JSON.stringify(init.body) : undefined });
      const res = m[2] ? await restore.POST(req, { params: Promise.resolve({ id: m[1], entryId: m[2] }) }) : init.method === "POST" ? await list.POST(req, { params: Promise.resolve({ id: m[1] }) }) : await list.GET(req, { params: Promise.resolve({ id: m[1] }) });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json.error));
      return json;
    }, { user: actor.user, token: actor.token as never });
  };
  const tool = (actor: Actor, name: string, args: Record<string, string>) => runTool(name, args, caller(actor) as never, "https://particl.test");
  expect(await tool(MATE_TOKEN, "list_trash", { project: "Ordinary" })).toBe("The Trash is empty.");
  /* A member's token removes the take of its own person, and not the owner's. */
  expect(await tool(MATE_TOKEN, "remove_to_trash", { project: "Ordinary", kind: "take", id: `t_mate_${run}` })).toMatch(/Removed take .* to the Trash/);
  await expect(tool(MATE_TOKEN, "remove_to_trash", { project: "Ordinary", kind: "take", id: `t_owner_${run}` })).rejects.toThrow(/someone else's work/);
  const listed = await tool(MATE_TOKEN, "list_trash", { project: "Ordinary" });
  expect(listed).toContain(`take · Title t_mate_${run}`);
  const entry = (await trash.items(MATE, "prod_open"))[1].items[0].id as string;
  /* An admin's token puts it back; nothing is charged and the Trash is empty again. */
  expect(await tool(ADMIN_TOKEN, "restore_from_trash", { project: "Ordinary", entry })).toMatch(/back\. Nothing was charged/);
  expect(await tool(MATE_TOKEN, "list_trash", { project: "Ordinary" })).toBe("The Trash is empty.");
  await expect(tool(MATE_TOKEN, "remove_to_trash", { project: "Ordinary", kind: "note", id: "x" })).rejects.toThrow(/take or shot/);
  /* With no project, the workspace's Trash: a take its person unfiled and removed. */
  const { cleanupDeletedGenerations } = await import("../../lib/mediaDeletion"); void cleanupDeletedGenerations;
  await tenant.runInTenant(ws, async () => { const db = (await import("../../lib/db")).db(); await db.execute({ sql: "UPDATE generations SET project_id=NULL WHERE id=?", args: [`t_mate_${run}`] }); const { workbenchTransaction } = await import("../../lib/workbench/records"); const { markGenerationDeletion, mediaDeletionReady } = await import("../../lib/mediaDeletion"); await mediaDeletionReady(); await workbenchTransaction((tx) => markGenerationDeletion(tx, `t_mate_${run}`, Date.now(), "u_mate")); }, { user: MATE.user });
  const unfiled = await tool(MATE_TOKEN, "list_trash", {});
  expect(unfiled).toContain(`take · Title t_mate_${run}`);
  const unfiledEntry = unfiled.split(" · ")[0];
  expect(await tool(MATE_TOKEN, "list_trash", {})).not.toBe("The Trash is empty.");
  expect(await tool(MATE_TOKEN, "restore_from_trash", { entry: unfiledEntry })).toMatch(/back\. Nothing was charged/);
  expect(await tool(MATE_TOKEN, "list_trash", {})).toBe("The Trash is empty.");
});

test("an unfiled take removed by a person is in the workspace's Trash: its bytes are kept, its remover (and an admin) can put it back, nobody else can see it", async () => {
  const ws = workspace(`bt-k-${run}`);
  const { tenant, database } = await fixture(ws);
  let who: Actor = MATE;
  const jobs = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => who);
  const wsList = loadRoute<typeof import("../../app/api/trash/route")>("app/api/trash/route.ts", () => who);
  const wsRestore = loadRoute<typeof import("../../app/api/trash/[entryId]/restore/route")>("app/api/trash/[entryId]/restore/route.ts", () => who);
  const as_ = <R>(actor: Actor, fn: () => Promise<R>) => { who = actor; return tenant.runInTenant(ws, fn, { user: actor.user, token: actor.token as never }); };
  const patch = (actor: Actor, id: string, body: unknown) => as_(actor, async () => { const res = await jobs.PATCH(new Request(`https://particl.test/api/jobs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${ws.id}-${actor.user.id}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }); return res.status; });
  const items = (actor: Actor) => as_(actor, async () => ((await (await wsList.GET(new Request("https://particl.test/api/trash"), undefined as never)).json()) as { items: { id: string; itemId: string; restorable: boolean }[] }).items);
  const restore = (actor: Actor, entry: string) => as_(actor, async () => { const res = await wsRestore.POST(new Request("https://particl.test/x", { method: "POST" }), { params: Promise.resolve({ entryId: entry }) }); return [res.status, await res.json()] as const; });
  const take = `t_mate_${run}`;
  const row = () => tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT deleted, project_id, stored_url, bytes FROM generations WHERE id=?", args: [take] })).rows[0], { user: user("u_owner") });
  /* The person unfiles their take, then removes it. */
  expect(await patch(MATE, take, { projectId: null })).toBe(200);
  expect((await row()).project_id).toBeNull();
  expect(await patch(MATE, take, { trashed: true })).toBe(200);
  expect(Number((await row()).deleted)).toBe(1);
  /* Its bytes are kept through the clean-up. */
  const { cleanupDeletedGenerations } = await import("../../lib/mediaDeletion");
  await tenant.runInTenant(ws, () => cleanupDeletedGenerations(20), { user: user("u_owner") });
  expect(await row()).toMatchObject({ stored_url: `/api/media/${take}`, bytes: 1000 });
  /* Its remover lists it; an admin does; another member does not, and cannot put it back. */
  const mine = await items(MATE);
  expect(mine.map((i) => i.itemId)).toEqual([take]);
  expect(mine[0].restorable).toBe(true);
  expect((await items(ADMIN)).map((i) => i.itemId)).toEqual([take]);
  expect(await items(OWNER)).toEqual([]);
  expect((await restore(OWNER, mine[0].id))[0]).toBe(404);
  /* A take in the Trash is not filed anywhere until it is put back. */
  expect(await patch(MATE, take, { projectId: "prod_open" })).toBe(409);
  /* Put back by its remover: it is back, unfiled, whole, and the Trash is empty. */
  expect((await restore(MATE, mine[0].id))[0]).toBe(200);
  expect(await row()).toMatchObject({ deleted: 0, stored_url: `/api/media/${take}`, bytes: 1000 });
  expect(await items(MATE)).toEqual([]);
  expect((await restore(MATE, mine[0].id))[0]).toBe(404);
  /* An admin puts one back that a member removed, too. */
  expect(await patch(MATE, take, { trashed: true })).toBe(200);
  const again = (await items(ADMIN))[0];
  expect((await restore(ADMIN, again.id))[0]).toBe(200);
  expect(Number((await row()).deleted)).toBe(0);
  /* An admin removes a member's unfiled take: the take's maker sees it and can put it back too; another member still cannot. */
  expect(await patch(ADMIN, take, { trashed: true })).toBe(200);
  const adminsEntry = (await items(MATE))[0];
  expect(adminsEntry.itemId).toBe(take);
  expect(await items(OWNER)).toEqual([]);
  expect((await restore(OWNER, adminsEntry.id))[0]).toBe(404);
  expect((await restore(MATE, adminsEntry.id))[0]).toBe(200);
  expect(Number((await row()).deleted)).toBe(0);
});

test("the older schema of the Trash is brought up to date: the holder column, and a one-open-record index that includes it", async () => {
  const ws = workspace(`bt-l-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db");
  await tenant.runInTenant(ws, async () => { await database.ready(); }, { user: user("u_owner") });
  /* A database that holds the first shape: no holder, and the index that let one person pre-empt another. */
  const { createClient } = await import("@libsql/client");
  const file = createClient({ url: ws.dbUrl });
  await file.batch(["DROP INDEX IF EXISTS idx_board_trash_open_v2", "DROP TABLE board_trash",
    "CREATE TABLE board_trash (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', payload TEXT, removed_by TEXT NOT NULL, removed_at INTEGER NOT NULL, restored_by TEXT, restored_at INTEGER)",
    "CREATE UNIQUE INDEX idx_board_trash_open ON board_trash(project_id, kind, item_id) WHERE restored_at IS NULL"], "write");
  file.close();
  /* The next start (a new client for the same file) migrates it. */
  const ws2 = { ...ws, id: `${ws.id}-again` } as TenantWorkspace;
  await tenant.runInTenant(ws2, async () => { await database.ready(); }, { user: user("u_owner") });
  const check = createClient({ url: ws.dbUrl });
  const cols = (await check.execute("PRAGMA table_info(board_trash)")).rows.map((r) => String(r.name));
  const indexes = (await check.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='board_trash'")).rows.map((r) => String(r.name));
  check.close();
  expect(cols).toContain("holder");
  expect(indexes).toContain("idx_board_trash_open_v2");
  expect(indexes).not.toContain("idx_board_trash_open");
});
