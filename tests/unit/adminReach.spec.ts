import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Admin reach (board sharing, PR 1, server part). Owner, 13 Oct: "admins CAN open any board in their own workspace (view, and edit if they choose), and can transfer a
 * board's ownership when a member leaves — the work belongs to the workspace. Members still can't see each other's private boards. Never across workspaces." An admin
 * opening a private board is written to the workspace's history, and its maker reads "Viewed by <admin>, <date>" (nobody is notified).
 *
 * The guards that REFUSE an admin today (privateCanvas, privateShots, uploadAccess) are not touched here: these are new tests beside them. Real temporary databases;
 * sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-admin-reach-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);

const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
type Who = { id: string; role: "admin" | "member"; name: string; email: string; owner?: boolean };
const who = (id: string, role: "admin" | "member" = "member", owner = false): Who => ({ id, role, name: `Name ${id}`, email: `${id}@example.test`, owner });
const asUser = (w: Who) => ({ user: { ...w, owner: w.owner === true, disabled: false, lastSeen: null, createdAt: 0 } });

function loadRoute<T>(file: string, viewer: () => Who): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: asUser(viewer()).user }), requireSession: async () => ({ user: asUser(viewer()).user }), requireRender: async () => ({ user: asUser(viewer()).user }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

type ProjectsRoute = typeof import("../../app/api/workbench/projects/route");
type CanvasRoute = typeof import("../../app/api/workbench/team-canvas/route");

/** Workspace A: u_owner and u_mate (members), u_admin (admin), u_wsowner (the workspace's owner); u_gone has left but their board is still here. Workspace B: its own admin, with its own board. */
async function fixture(name: string) {
  const A = workspace(`ar-a-${name}-${run}`), B = workspace(`ar-b-${name}-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const platform = await import("../../lib/platform");
  await platform.platformReady();
  const person = async (ws: TenantWorkspace, id: string, role: string, member = true) => {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, `Name ${id}`, "x"] });
    if (member) await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, role] });
  };
  for (const [id, role] of [["u_owner", "member"], ["u_mate", "member"], ["u_admin", "admin"], ["u_wsowner", "owner"]] as const) await person(A, id, role);
  await person(A, "u_gone", "member", false);
  await person(B, "u_badmin", "admin");
  let current = who("u_owner");
  const projects = loadRoute<ProjectsRoute>("app/api/workbench/projects/route.ts", () => current);
  const canvas = loadRoute<CanvasRoute>("app/api/workbench/team-canvas/route.ts", () => current);
  const as = <T,>(ws: TenantWorkspace, person: Who, fn: () => Promise<T>) => { current = person; return tenant.runInTenant(ws, fn, asUser(person)); };
  const save = async (ws: TenantWorkspace, owner: string, draftId: string, share?: "view" | "edit") => {
    const first = await as(ws, who(owner), async () => { await records.workbenchReady(); return records.saveDraft(owner, { ...newProject(`Board ${draftId}`), id: draftId, nodes: [] } as never, 0); });
    if (share) await as(ws, who(owner), () => records.setBoardSharing(owner, draftId, { teamShared: true, teamEdit: share === "edit" }));
    return first.productionProjectId as string;
  };
  const private1 = await save(A, "u_owner", "d-private");
  const shared = await save(A, "u_owner", "d-shared", "view");
  const departed = await save(A, "u_gone", "d-gone");
  const otherWs = await save(B, "u_badmin", "d-b");
  const get = (ws: TenantWorkspace, person: Who, query: string) => as(ws, person, async () => { const res = await projects.GET(new Request(`https://particl.test/api/workbench/projects?${query}`), undefined as never); return { status: res.status, body: (await res.json()) as Record<string, any> }; }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const history = (ws: TenantWorkspace) => as(ws, who("u_admin", "admin"), async () => (await database.db().execute({ sql: "SELECT actor_id, action, target_type, target_id, workspace_id FROM security_audit WHERE action LIKE 'board.%' ORDER BY created_at, id", args: [] })).rows.map((r) => ({ actor: String(r.actor_id), action: String(r.action), target: String(r.target_id), type: String(r.target_type), workspace: String(r.workspace_id) })));
  return { A, B, tenant, database, records, platform, projects, canvas, as, get, history, private1, shared, departed, otherWs };
}

test("an admin of the same workspace reaches a member's private board, to look and to write; a member does not; the workspace's owner counts as an admin; nobody is let in who is not a person", async () => {
  const f = await fixture("reach");
  const { mayReachProject } = await import("../../lib/draftProject");
  const reach = (person: Parameters<typeof mayReachProject>[0], projectId: string, access: "read" | "write" | "admit") => f.tenant.runInTenant(f.A, () => mayReachProject(person, projectId, access), asUser(who("u_admin", "admin")));
  expect(await reach({ id: "u_admin", role: "admin" }, f.private1, "read"), "admin read").toBe(true);
  expect(await reach({ id: "u_admin", role: "admin" }, f.private1, "write"), "admin write").toBe(true);
  expect(await reach({ id: "u_wsowner", role: "member", owner: true }, f.private1, "write"), "the workspace's owner").toBe(true);
  expect(await reach({ id: "u_gone2", role: "admin" }, f.departed, "read"), "a member who has left their board").toBe(true);
  expect(await reach({ id: "u_mate", role: "member" }, f.private1, "read"), "a member").toBe(false);
  expect(await reach({ id: "u_mate", role: "member" }, f.private1, "write"), "a member").toBe(false);
  expect(await reach({ id: "u_mate" }, f.private1, "read"), "no role is a member").toBe(false);
  expect(await reach({ id: "agent:run_1", role: "admin" }, f.private1, "read"), "an Atomik run is never an admin").toBe(false);
  expect(await reach({ id: "server", role: "admin" }, f.private1, "write"), "the server is never an admin").toBe(false);
  expect(await reach({ id: "u_admin", role: "admin" }, f.private1, "admit"), "rendering on it is still its owner's or an editor's").toBe(false);
  expect(await reach({ id: "u_admin", role: "admin" }, "prj_wb_doesnotexist0000000000", "read"), "an id no board holds").toBe(false);
  expect(await reach(null, f.private1, "read"), "background work is as before").toBe(true);
});

test("the marked sample stays read-only for an admin", async () => {
  const f = await fixture("sample");
  const { mayReachProject } = await import("../../lib/draftProject");
  const draft = await f.tenant.runInTenant(f.A, async () => {
    await f.database.db().execute({ sql: "INSERT OR REPLACE INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_owner',0)", args: [JSON.stringify({ version: 1, projectId: f.private1, name: "Sample", draftOwner: "u_owner", draftId: "d-private", markedBy: "u_owner", markedAt: 1 })] });
    return { read: await mayReachProject({ id: "u_admin", role: "admin" }, f.private1, "read"), write: await mayReachProject({ id: "u_admin", role: "admin" }, f.private1, "write") };
  }, asUser(who("u_admin", "admin")));
  expect(draft).toEqual({ read: true, write: false });
});

test("an admin of ANOTHER workspace reaches nothing here: the model, the board routes, the list of every board, the canvas and the views", async () => {
  const f = await fixture("other");
  const outsider = who("u_badmin", "admin");
  const { mayReachProject, projectLister } = await import("../../lib/draftProject");
  /* Asked inside their own workspace (where the ids are nobody's) and inside this one with their sign-in from the other (the account is no member of A). */
  expect(await f.tenant.runInTenant(f.B, () => mayReachProject({ id: "u_badmin", role: "admin" }, f.private1, "read"), asUser(outsider))).toBe(false);
  expect(await f.tenant.runInTenant(f.B, () => mayReachProject({ id: "u_badmin", role: "admin" }, f.departed, "write"), asUser(outsider))).toBe(false);
  expect((await f.tenant.runInTenant(f.B, async () => (await projectLister({ id: "u_badmin", role: "admin" }, undefined, { only: f.private1 }))(f.private1), asUser(outsider)))).toBe(false);
  for (const query of [`id=d-private&owner=u_owner`, `id=d-gone&owner=u_gone`]) {
    const res = await f.get(f.B, outsider, query);
    expect(res.status, query).toBe(404);
  }
  /* Their list of every board is their own workspace's: nothing of this one is in it. */
  const named = await f.get(f.B, outsider, `all=1`);
  expect((named.body.boards as { id: string }[]).map((b) => b.id)).toEqual(["d-b"]);
  /* The canvas route answers a board of the other workspace as one that does not exist, and writes nothing and records nothing there. */
  const patch = await f.as(f.B, outsider, async () => (await f.canvas.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId: f.private1, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }) }), undefined as never)).status);
  expect(patch).toBe(404);
  expect(await f.history(f.B)).toEqual([]);
  /* The views belong to a board's maker: an admin of another workspace has none. */
  expect((await f.get(f.B, outsider, "views=1")).body.views).toEqual([]);
  /* Its own board is its own. */
  expect((await f.get(f.B, outsider, "id=d-b")).status).toBe(200);
});

test("the routes: an admin opens a member's private board to look (view-only), edits when they choose and saves under the owner's key; a member is answered as for an unknown board", async () => {
  const f = await fixture("routes");
  const admin = who("u_admin", "admin");
  for (const [query, label] of [["id=d-private&owner=u_owner", "private"], ["id=d-gone&owner=u_gone", "a member who has left"]] as const) {
    const looked = await f.get(f.A, admin, query);
    expect(looked.status, label).toBe(200);
    expect(looked.body.project.id, label).toBe(query.split("&")[0].slice(3));
    expect(looked.body.viewOnly, `${label}: an admin looks first`).toBeTruthy();
    expect(looked.body.actingOn, label).toBeUndefined();
    const mate = await f.get(f.A, who("u_mate"), query);
    expect(mate.status, `a member: ${label}`).toBe(404);
  }
  expect((await f.get(f.A, admin, "id=d-private&owner=u_owner")).body.viewOnly.owner.name).toBe("Name u_owner");
  expect((await f.get(f.A, admin, "id=d-gone&owner=u_gone")).body.viewOnly.owner).toMatchObject({ id: "u_gone", former: true });
  /* Choosing to edit: the answer names whose board it is, and a save lands under the owner's key as the admin. */
  const edit = await f.get(f.A, admin, "id=d-private&owner=u_owner&edit=1");
  expect(edit.body.actingOn.owner.id).toBe("u_owner");
  const saved = await f.as(f.A, admin, async () => {
    const res = await f.projects.PUT(new Request("https://particl.test/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: { ...edit.body.project, name: "Renamed by an admin" }, revision: edit.body.revision, owner: "u_owner" }) }), undefined as never);
    return { status: res.status, row: (await f.database.db().execute({ sql: "SELECT updated_by, owner FROM workbench_projects WHERE key=?", args: ["u_owner:d-private"] })).rows[0] };
  });
  expect(saved.status).toBe(200);
  expect(saved.row).toMatchObject({ updated_by: "u_admin", owner: "u_owner" });
  expect(await f.as(f.A, admin, async () => (await f.database.db().execute({ sql: "SELECT 1 FROM workbench_projects WHERE key=?", args: ["u_admin:d-private"] })).rows.length), "nothing under the admin's own key").toBe(0);
  /* A member cannot save into it. */
  const refused = await f.as(f.A, who("u_mate"), async () => (await f.projects.PUT(new Request("https://particl.test/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: { ...edit.body.project, name: "Hijack" }, revision: edit.body.revision + 1, owner: "u_owner" }) }), undefined as never)).status);
  expect(refused).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(String((await f.as(f.A, admin, () => f.database.db().execute({ sql: "SELECT body FROM workbench_projects WHERE key=?", args: ["u_owner:d-private"] }))).rows[0].body)).name).toBe("Renamed by an admin");
  /* A shared board an admin opens: view-only by default too, as before for them; the sharing is the maker's alone. */
  expect((await f.get(f.A, admin, "id=d-shared&owner=u_owner")).body.viewOnly).toBeTruthy();
  /* The link's reach question: an admin may open a board; a member may not; the answer names no private board's maker to a member. */
  expect((await f.get(f.A, admin, `reach=${f.private1}`)).body.reach).toMatchObject({ reachable: true, shared: { id: "d-private" } });
  expect((await f.get(f.A, who("u_mate"), `reach=${f.private1}`)).body.reach).toEqual({ reachable: false, shared: null });
});

test("the admins' list of every board: private boards and the boards of members who have left included; a member is answered as for a route that is not there", async () => {
  const f = await fixture("all");
  const all = await f.get(f.A, who("u_admin", "admin"), "all=1");
  expect(all.status).toBe(200);
  const boards = all.body.boards as { id: string; owner: { id: string; former?: true }; sharing: string; mine: boolean }[];
  expect(boards.map((b) => [b.id, b.sharing, !!b.owner.former]).sort()).toEqual([["d-gone", "private", true], ["d-private", "private", false], ["d-shared", "view", false]]);
  expect(boards.every((b) => !b.mine)).toBe(true);
  expect((await f.get(f.A, who("u_wsowner", "member", true), "all=1")).status, "the workspace's owner").toBe(200);
  expect((await f.get(f.A, who("u_mate"), "all=1")).status).toBe(404);
  expect((await f.get(f.A, who("u_owner"), "all=1")).status, "a maker sees their own list as before, not everyone's").toBe(404);
  /* Listing is not opening: no history line. */
  expect(await f.history(f.A)).toEqual([]);
});

test("every admin open or edit of a private board is a line in the workspace's history; looking at a shared board, their own board or being refused is not", async () => {
  const f = await fixture("audit");
  const admin = who("u_admin", "admin");
  await f.get(f.A, admin, "id=d-private&owner=u_owner");
  let lines = await f.history(f.A);
  expect(lines).toEqual([{ actor: "u_admin", action: "board.opened_by_admin", target: f.private1, type: "board", workspace: f.A.id }]);
  /* The same look again soon after is the same line. */
  await f.get(f.A, admin, "id=d-private&owner=u_owner");
  expect(await f.history(f.A)).toHaveLength(1);
  /* An edit is its own line. */
  const edit = await f.get(f.A, admin, "id=d-private&owner=u_owner&edit=1");
  expect(edit.status).toBe(200);
  lines = await f.history(f.A);
  expect(lines.map((l) => l.action)).toEqual(["board.opened_by_admin", "board.edited_by_admin"]);
  /* A board of a member who has left. */
  await f.get(f.A, admin, "id=d-gone&owner=u_gone");
  expect((await f.history(f.A)).at(-1)).toMatchObject({ actor: "u_admin", action: "board.opened_by_admin", target: f.departed });
  /* The canvas: an admin's write to a private board's canvas is a line too (an edit). */
  const before = (await f.history(f.A)).length;
  const patch = await f.as(f.A, who("u_wsowner", "member", true), async () => (await f.canvas.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId: f.private1, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }) }), undefined as never)).status);
  expect(patch).toBe(200);
  const after = await f.history(f.A);
  expect(after.length).toBe(before + 1);
  expect(after.at(-1)).toMatchObject({ actor: "u_wsowner", action: "board.edited_by_admin", target: f.private1 });
  /* Not lines: a shared board, the admin's own board, a member's refused try. */
  const count = after.length;
  await f.get(f.A, admin, "id=d-shared&owner=u_owner");
  await f.get(f.A, who("u_mate"), "id=d-private&owner=u_owner");
  await f.get(f.A, who("u_owner"), "id=d-private");
  expect(await f.history(f.A)).toHaveLength(count);
  /* No line means no reach: when the line cannot be written the admin is not let in. */
  const failing = await f.as(f.A, admin, async () => {
    const { mayReachProject } = await import("../../lib/draftProject");
    const real = f.database.db();
    const wrapped = { execute: (s: unknown) => (JSON.stringify(s).includes("INSERT INTO security_audit") ? Promise.reject(new Error("history is down")) : real.execute(s as never)) };
    return mayReachProject({ id: "u_other_admin", role: "admin" }, f.departed, "read", wrapped as never);
  });
  expect(failing).toBe(false);
});

test("\"Viewed by\": a board's maker reads who looked at or changed it as an admin, and when; nobody else reads it; nobody is notified", async () => {
  const f = await fixture("viewed");
  const admin = who("u_admin", "admin");
  await f.get(f.A, admin, "id=d-private&owner=u_owner");
  await f.get(f.A, admin, "id=d-private&owner=u_owner&edit=1");
  await f.get(f.A, admin, "id=d-gone&owner=u_gone");
  const mine = await f.get(f.A, who("u_owner"), "views=1");
  expect(mine.status).toBe(200);
  const views = mine.body.views as { boardId: string; by: { id: string; name: string }; what: string; at: number }[];
  expect(views.map((v) => [v.boardId, v.by.id, v.by.name, v.what]).sort()).toEqual([["d-private", "u_admin", "Name u_admin", "edited"], ["d-private", "u_admin", "Name u_admin", "viewed"]]);
  expect(views.every((v) => Number.isFinite(v.at) && v.at > 0)).toBe(true);
  expect(JSON.stringify(mine.body)).not.toContain("u_gone");
  /* Narrowed to one of their boards. */
  expect((await f.get(f.A, who("u_owner"), "views=1&id=d-shared")).body.views).toEqual([]);
  /* Another member, and the admin themself, read the lines of their OWN boards only: none about someone else's. */
  expect((await f.get(f.A, who("u_mate"), "views=1")).body.views).toEqual([]);
  expect((await f.get(f.A, admin, "views=1")).body.views).toEqual([]);
  expect((await f.get(f.A, who("u_wsowner", "member", true), "views=1")).body.views).toEqual([]);
  /* The departed maker's board is not anyone's to read the views of from here. */
  expect((await f.get(f.A, who("u_mate"), "views=1&id=d-gone")).body.views).toEqual([]);
  /* Nothing is sent to anyone: the only record is the history line. */
  const tables = await f.as(f.A, who("u_owner"), async () => (await f.database.db().execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%notif%' OR name LIKE '%inbox%')", args: [] })).rows.map((r) => String(r.name)));
  for (const table of tables) expect((await f.as(f.A, who("u_owner"), async () => (await f.database.db().execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] })).rows[0].n)), table).toBe(0);
});

test("a member's list of shots on one board reads it for an admin only through the gate that writes the line; lists of boards stay as they were", async () => {
  const f = await fixture("lister");
  const { projectLister } = await import("../../lib/draftProject");
  const admin = { id: "u_admin", role: "admin" };
  const listed = await f.tenant.runInTenant(f.A, async () => ({
    plain: (await projectLister(admin))(f.private1),
    one: (await projectLister(admin, undefined, { only: f.private1 }))(f.private1),
    otherOnes: (await projectLister(admin, undefined, { only: f.private1 }))(f.departed),
    member: (await projectLister({ id: "u_mate", role: "member" }, undefined, { only: f.private1 }))(f.private1),
    ordinary: (await projectLister(admin))("prod_plain"),
  }), asUser(who("u_admin", "admin")));
  expect(listed).toEqual({ plain: false, one: true, otherOnes: false, member: false, ordinary: true });
  expect((await f.history(f.A)).map((l) => l.target)).toEqual([f.private1]);
});
