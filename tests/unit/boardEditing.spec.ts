import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * "Can edit" (board sharing, PR 6): the share mode (none, view, edit) is the server's, set only by the owner through `team-share`; a teammate may write
 * a board shared with edit (save, check, map shots, publish, open it as the board itself) through an explicit grant, and nothing else: not its sharing,
 * not its rename or deletion, not a client link; a board shared to view, not shared, a disabled owner's, or one linked to an ordinary production stays
 * out of reach. Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-acting-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const WRITER = crypto.randomUUID();
const ROOT_EMAIL = `root-${run}@example.test`;
let envBefore: string | undefined;
test.beforeEach(async () => { envBefore = process.env.SUPER_ADMIN_EMAIL; process.env.SUPER_ADMIN_EMAIL = ROOT_EMAIL; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });
test.afterEach(async () => { if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });

const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: id, email: id === "u_root" ? ROOT_EMAIL : `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });

function loadRoute<T>(file: string, viewer: () => Who): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer() }), requireSession: async () => ({ user: viewer() }), requireRender: async () => ({ user: viewer() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

type Route = typeof import("../../app/api/workbench/projects/route");

async function fixture(name: string, options: { sample?: boolean } = {}) {
  const ws = workspace(`ba-${name}-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { createNode } = await import("../../lib/workbench/node-graph");
  const platform = await import("../../lib/platform");
  /* The workspace's people, as the platform holds them: a key named in a request must be an active member's. */
  await platform.platformReady();
  for (const id of ["u_owner", "u_mate", "u_root"]) {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x"] });
    await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, "member"] });
  }
  let current = who("u_owner");
  const route = loadRoute<Route>("app/api/workbench/projects/route.ts", () => current);
  const as = <T,>(person: Who, fn: () => Promise<T>) => { current = person; return tenant.runInTenant(ws, fn, asUser(person)); };
  const request = (method: string, body: unknown) => new Request("https://particl.test/api/workbench/projects", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const put = (project: unknown, revision: number, extra: Record<string, unknown> = {}) => route.PUT(request("PUT", { project, revision, ...extra }), undefined as never);
  const post = (body: Record<string, unknown>) => route.POST(request("POST", body), undefined as never);
  /* The owner's board, saved the ordinary way, with one card so a shot can be mapped. */
  let board = { ...newProject("Board"), id: "d1", nodes: [{ ...createNode("scene", 0), id: "n1" }] } as never as ReturnType<typeof newProject>;
  const first = await as(who("u_owner"), async () => { await records.workbenchReady(); return records.saveDraft("u_owner", board, 0); });
  board = { ...board, productionProjectId: first.productionProjectId } as typeof board;
  /* The owner's board is the marked sample: the platform owner (not its marker) has write reach to it (#694), a teammate has not. */
  if (options.sample) await as(who("u_owner"), async () => {
    await database.db().execute({ sql: "INSERT OR REPLACE INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_owner',0)", args: [JSON.stringify({ version: 1, projectId: first.productionProjectId, name: "Sample", draftOwner: "u_owner", draftId: "d1", markedBy: "u_owner", markedAt: 1 })] });
  });
  const members = { disable: (id: string) => platform.platformDb().execute({ sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?", args: [ws.id, id] }) };
  const row = (owner = "u_owner") => as(who("u_owner"), async () => (await database.db().execute({ sql: "SELECT body,revision,updated_by,owner FROM workbench_projects WHERE key=?", args: [`${owner}:d1`] })).rows[0]);
  return { ws, tenant, database, records, members, route, as, put, post, board, row, first };
}


const modeOf = async (f: Awaited<ReturnType<typeof fixture>>) => { const b = JSON.parse(String((await f.row()).body)); return b.teamShared ? (b.teamEdit ? "edit" : "view") : "none"; };

test("the owner sets the mode; only the owner; a save never does; edit needs sharing", async () => {
  const f = await fixture("modes");
  const set = (person: Who, mode: unknown, extra: Record<string, unknown> = {}) => f.as(person, () => f.post({ action: "team-share", projectId: "d1", mode, ...extra }));
  expect(await modeOf(f)).toBe("none");
  for (const mode of ["view", "edit", "view", "none", "edit"] as const) {
    const res = await set(who("u_owner"), mode);
    expect(await res.json()).toMatchObject({ ok: true, mode, shared: mode !== "none" });
    expect(await modeOf(f)).toBe(mode);
  }
  // Same mode again: nothing to do; a mode that is not one: refused.
  expect(await (await set(who("u_owner"), "edit")).json()).toMatchObject({ ok: true, mode: "edit" });
  expect((await set(who("u_owner"), "everyone")).status).toBe(400);
  expect(await modeOf(f)).toBe("edit");
  // The older shared:true/false still works: true keeps an existing mode, false stops.
  const legacy = (shared: boolean) => f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", shared }));
  expect(await (await legacy(true)).json()).toMatchObject({ mode: "edit" });
  expect(await (await legacy(false)).json()).toMatchObject({ mode: "none", shared: false });
  await set(who("u_owner"), "edit");
  // An editor cannot change it, whichever way they name the board.
  for (const extra of [{}, { owner: "u_owner" }]) {
    const res = await set(who("u_mate"), "none", extra);
    expect([403, 404], JSON.stringify(extra)).toContain(res.status);
  }
  expect(await modeOf(f)).toBe("edit");
  // No save, from the owner or an editor, changes it.
  const raise = await f.as(who("u_owner"), () => f.put({ ...f.board, teamShared: false, teamEdit: false, name: "Saved" }, 1));
  expect(raise.status).toBe(200);
  expect(await modeOf(f)).toBe("edit");
  // The edit flag alone is no sharing: only via the action does "edit" imply "shared".
  await set(who("u_owner"), "none");
  expect(JSON.parse(String((await f.row()).body)).teamEdit).toBeUndefined();
});

test("a teammate may write a board shared with Can edit as themselves, through the route, and nothing else changes hands", async () => {
  const f = await fixture("edit");
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  const mate = who("u_mate");
  const revision = Number((await f.row()).revision);
  // Opened by its draft id, the board comes back as the board itself, to edit, naming whose it is; no copy is made.
  const got = await f.as(mate, () => f.route.GET(new Request("https://particl.test/api/workbench/projects?id=d1&owner=u_owner"), undefined as never));
  const opened = await got.json();
  expect(opened).toMatchObject({ revision, actingOn: { owner: { id: "u_owner" } } });
  expect(opened.viewOnly).toBeUndefined();
  expect(opened.project.id).toBe("d1");
  // By its production, as the Library and links open it.
  const byProduction = await f.as(mate, () => f.post({ action: "open", projectId: f.first.productionProjectId }));
  expect(await byProduction.json()).toMatchObject({ revision, actingOn: { owner: { id: "u_owner" } }, project: { id: "d1" } });
  // Saved, naming the owner, and by the draft id alone: the same board, the same key, the editor recorded.
  const named = await f.as(mate, () => f.put({ ...opened.project, name: "Named by the editor" }, revision, { owner: "u_owner", write: { writer: WRITER, seq: 1 } }));
  expect(named.status, JSON.stringify(await named.clone().json())).toBe(200);
  expect(await f.row()).toMatchObject({ owner: "u_owner", revision: revision + 1, updated_by: "u_mate" });
  const alone = await f.as(mate, () => f.put({ ...opened.project, name: "By the id alone" }, revision + 1));
  expect(alone.status).toBe(200);
  expect(JSON.parse(String((await f.row()).body)).name).toBe("By the id alone");
  expect(await f.as(mate, () => f.records.readDraft("u_mate", "d1")), "nothing under the editor's own key").toBeNull();
  // The save is checkable, mapping a shot and publishing work as the editor.
  expect(await (await f.as(mate, () => f.post({ action: "check-write", projectId: "d1", write: { writer: WRITER, seq: 1 }, owner: "u_owner" }))).json()).toMatchObject({ landed: revision + 1 });
  const mapped = await f.as(mate, () => f.post({ action: "map-shot", projectId: "d1", nodeId: "n1" }));
  const shotId = (await mapped.json()).shotId as string;
  expect((await f.as(mate, async () => (await f.database.db().execute({ sql: "SELECT created_by FROM shots WHERE id=?", args: [shotId] })).rows[0])).created_by).toBe("u_mate");
  expect((await f.as(mate, () => f.post({ action: "publish", projectId: "d1", expectedBibleVersion: 0 }))).status).toBe(200);
  // A stale revision is refused for the editor, as for the owner.
  const stale = await f.as(mate, () => f.put({ ...opened.project, name: "Late" }, revision));
  expect(stale.status).toBe(409);
  // And the editor's saves never changed the mode.
  expect(await modeOf(f)).toBe("edit");
  // Not the editor's: renaming or deleting the production (maker or admin), a client link (admin), the board's sharing.
  const { mayChangeProject } = await import("../../lib/workAccess");
  expect(await f.as(mate, () => mayChangeProject({ id: "u_mate", role: "member" }, f.first.productionProjectId))).toBe(false);
  expect(await f.as(who("u_owner"), () => mayChangeProject({ id: "u_owner", role: "member" }, f.first.productionProjectId))).toBe(true);
  expect((await f.as(mate, () => f.post({ action: "team-share", projectId: "d1", mode: "view" }))).status).toBeGreaterThanOrEqual(400);
});

test("the reach is read at every request: view, none, a disabled owner or a stranger's key take the write back, and nothing is written", async () => {
  const f = await fixture("revoke");
  const mate = who("u_mate");
  const snapshot = () => f.row().then((r) => JSON.stringify(r));
  const tryWrite = async () => {
    const before = await snapshot();
    const res = await f.as(mate, () => f.put({ ...f.board, name: "Try" }, Number(JSON.parse(before).revision), { owner: "u_owner" }));
    const alone = await f.as(mate, () => f.put({ ...f.board, name: "Try alone" }, Number(JSON.parse(before).revision)));
    return { named: res.status, alone: alone.status, unchanged: (await snapshot()) === before };
  };
  // Not shared and shared to view: refused, nothing written.
  const none = await tryWrite();
  expect(none.named).toBeGreaterThanOrEqual(400);
  expect(none.unchanged).toBe(true);
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "view" }));
  const view = await tryWrite();
  expect(view.named).toBeGreaterThanOrEqual(400);
  expect(view.unchanged).toBe(true);
  // Edit: allowed. Then the owner is disabled: refused again.
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  const revision = Number((await f.row()).revision);
  expect((await f.as(mate, () => f.put({ ...f.board, name: "Allowed" }, revision, { owner: "u_owner" }))).status).toBe(200);
  await f.members.disable("u_owner");
  const refused = await f.as(mate, () => f.put({ ...f.board, name: "Not any more" }, revision + 1, { owner: "u_owner" }));
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(String((await f.row()).body)).name).toBe("Allowed");
  // Everywhere the same: the reach itself (the canvas route, its rooms and a render's admission ask it) refuses write and render, and read stays.
  const { mayReachProject } = await import("../../lib/draftProject");
  const board = f.first.productionProjectId as string;
  const reach = (access: "read" | "write" | "admit") => f.as(mate, () => mayReachProject({ id: "u_mate" }, board, access));
  expect([await reach("read"), await reach("write"), await reach("admit")]).toEqual([true, false, false]);
});

test("a board linked to an ordinary production is not an editable board, even when its draft says Can edit", async () => {
  const f = await fixture("ordinary-edit");
  const { newProject } = await import("../../lib/workbench/studio");
  const { createNode } = await import("../../lib/workbench/node-graph");
  await f.as(who("u_owner"), async () => {
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_ordinary','Ordinary',0)", args: [] });
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prj_ordinary','Ordinary project',0,'prod_ordinary')", args: [] });
    const draft = { ...newProject("starter-d"), id: "starter-d", productionProjectId: "prj_ordinary", teamShared: true, teamEdit: true, nodes: [{ ...createNode("scene", 0), id: "n1" }] };
    await f.database.db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,3,0)", args: ["u_owner:starter-d", "u_owner", "starter-d", "s", JSON.stringify(draft)] });
  });
  const mate = who("u_mate");
  const before = JSON.stringify(await f.as(who("u_owner"), async () => (await f.database.db().execute("SELECT key,body,revision FROM workbench_projects ORDER BY key")).rows));
  for (const owner of [{ owner: "u_owner" }, {}]) {
    const put = await f.as(mate, () => f.put({ ...newProject("starter-d"), id: "starter-d", productionProjectId: "prj_ordinary", name: "Overwritten" }, 3, owner));
    expect(put.status, JSON.stringify(owner)).not.toBe(200);
    const check = await f.as(mate, () => f.post({ action: "check-write", projectId: "starter-d", write: { writer: WRITER, seq: 1 }, ...owner }));
    expect(await check.clone().text()).not.toMatch(/"project":\{/);
  }
  expect(JSON.stringify(await f.as(who("u_owner"), async () => (await f.database.db().execute("SELECT key,body,revision FROM workbench_projects ORDER BY key")).rows))).toBe(before);
});

test("reach, as one rule: owner, edit, view, none, for reading, writing and rendering", async () => {
  const f = await fixture("matrix");
  const { mayReachProject, draftShareMode } = await import("../../lib/draftProject");
  const board = f.first.productionProjectId as string;
  const reach = (person: string, access: "read" | "write" | "admit") => f.as(who(person), () => mayReachProject({ id: person }, board, access));
  const setMode = (mode: string) => f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode }));
  const expected = {
    none: { u_owner: [true, true, true], u_mate: [false, false, false] },
    view: { u_owner: [true, true, true], u_mate: [true, false, false] },
    edit: { u_owner: [true, true, true], u_mate: [true, true, true] },
  } as const;
  for (const mode of ["none", "view", "edit", "none"] as const) {
    await setMode(mode);
    expect(await f.as(who("u_mate"), () => draftShareMode(board))).toBe(mode);
    for (const person of ["u_owner", "u_mate"] as const) {
      expect([await reach(person, "read"), await reach(person, "write"), await reach(person, "admit")], `${mode} ${person}`).toEqual(expected[mode === "none" ? "none" : mode][person]);
    }
  }
});

test("a save by draft id alone that cannot be settled is refused with a clear 409: never a guess, never someone else's board", async () => {
  const f = await fixture("ambiguous");
  const { newProject } = await import("../../lib/workbench/studio");
  const { mappedId } = await import("../../lib/workbench/records");
  const platform = await import("../../lib/platform");
  const mate = who("u_mate");
  const put = (project: unknown, revision: number, extra: Record<string, unknown> = {}) => f.as(mate, () => f.put(project, revision, extra));
  // A second person's board with the very same draft id, also shared with Can edit (ids are random, so this is a collision on purpose).
  await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('u_third','u_third@example.test','u_third','x',0)", args: [] });
  await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,'u_third','member',0,0)", args: [f.ws.id] });
  const second = mappedId("prj_wb_", f.ws.id, "u_third", "d1");
  await f.as(who("u_owner"), async () => {
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [second, "Third's board"] });
    await f.database.db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_third:d1", "u_third", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: second, teamShared: true, teamEdit: true })] });
  });
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  const all = () => f.as(who("u_owner"), async () => JSON.stringify((await f.database.db().execute("SELECT key,body,revision FROM workbench_projects ORDER BY key")).rows));
  const before = await all();
  // Two edit-shared boards under that id: a save by id alone, and a check, are refused, and nothing is written for either owner or for the person.
  const two = await put({ ...f.board, name: "Which one?" }, 1);
  expect(two.status).toBe(409);
  expect(await two.json()).toMatchObject({ code: "board_id_ambiguous", error: expect.stringContaining("Open that board to edit it") });
  const check = await f.as(mate, () => f.post({ action: "check-write", projectId: "d1", write: { writer: WRITER, seq: 1 } }));
  expect(check.status).toBe(409);
  expect(await all()).toBe(before);
  // Naming the owner settles it: the board is that owner's, and written as such.
  const named = await put({ ...f.board, name: "Named" }, 1, { owner: "u_owner" });
  expect(named.status).toBe(200);
  expect(JSON.parse(String((await f.row()).body)).name).toBe("Named");
  // One edit-shared board under the id, which the person may not write (its maker is switched off): a new board with that id is refused, not made.
  await f.as(who("u_owner"), () => f.database.db().execute("DELETE FROM workbench_projects WHERE key='u_third:d1'"));
  await f.members.disable("u_owner");
  const collide = await put({ ...newProject("d1"), id: "d1", name: "Mine?" }, 0);
  expect(collide.status).toBe(409);
  expect((await collide.json()).code).toBe("board_id_ambiguous");
  expect(await f.as(mate, () => f.records.readDraft("u_mate", "d1"))).toBeNull();
  // The person's own draft of an id always wins, and an id nobody has shared is simply new.
  const fresh = await put({ ...newProject("d9"), id: "d9", name: "Brand new" }, 0);
  expect(fresh.status).toBe(200);
  expect(await f.as(mate, () => f.records.readDraft("u_mate", "d9"))).not.toBeNull();
});

test("an admin who is also an editor keeps an admin's rights over the production (rename, delete, client links); a plain editor has none of them", async () => {
  const f = await fixture("admin-editor");
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  const { mayChangeProject } = await import("../../lib/workAccess");
  const board = f.first.productionProjectId as string;
  expect(await f.as(who("u_root", "admin"), () => mayChangeProject({ id: "u_root", role: "admin" }, board)), "an admin").toBe(true);
  expect(await f.as(who("u_mate"), () => mayChangeProject({ id: "u_mate", role: "member" }, board)), "a plain editor").toBe(false);
  const { readFileSync } = await import("node:fs");
  const links = readFileSync("app/api/review-links/route.ts", "utf8");
  expect((links.match(/got\.user\.role !== "admin"/g) ?? []).length, "making and withdrawing a client link are the admin role's").toBe(2);
});
