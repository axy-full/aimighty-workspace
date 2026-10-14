import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Handing a board to another owner (board sharing, PR 4, server). Owner, 13 Oct: admins can transfer a board's ownership when a member leaves; the work belongs to the
 * workspace; never across workspaces. Nothing is moved or re-keyed: a row in `workbench_board_owners` says whose the board is now, and every ownership rule reads it.
 * Only an admin, only to an active member of the same workspace, each handover and each Undo a line in the workspace's history, nothing ever deleted.
 * Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-transfer-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);

const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: `Name ${id}`, email: `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });

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
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Workspace A: u_owner and u_mate (members), u_admin (admin), u_new (an active member), u_off (a disabled member); u_gone has left, their board is still here.
 * Workspace B: its own admin and member. Each has boards of its own.
 */
async function fixture(name: string) {
  const A = workspace(`bt-a-${name}-${run}`), B = workspace(`bt-b-${name}-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const platform = await import("../../lib/platform");
  const draft = await import("../../lib/draftProject");
  await platform.platformReady();
  const person = async (ws: TenantWorkspace, id: string, role: string, member = true, disabled = false) => {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, `Name ${id}`, "x"] });
    if (member) await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,0)", args: [ws.id, id, role, disabled ? 1 : 0] });
  };
  for (const [id, role] of [["u_owner", "member"], ["u_mate", "member"], ["u_admin", "admin"], ["u_new", "member"]] as const) await person(A, id, role);
  await person(A, "u_off", "member", true, true);
  await person(A, "u_gone", "member", false);
  await person(B, "u_badmin", "admin");
  await person(B, "u_bmember", "member");
  let current = who("u_owner");
  const projects = loadRoute<ProjectsRoute>("app/api/workbench/projects/route.ts", () => current);
  const canvas = loadRoute<CanvasRoute>("app/api/workbench/team-canvas/route.ts", () => current);
  const as = <T,>(ws: TenantWorkspace, p: Who, fn: () => Promise<T>) => { current = p; return tenant.runInTenant(ws, fn, asUser(p)); };
  const save = async (ws: TenantWorkspace, owner: string, draftId: string) => {
    const first = await as(ws, who(owner), async () => { await records.workbenchReady(); return records.saveDraft(owner, { ...newProject(`Board ${draftId}`), id: draftId, nodes: [] } as never, 0); });
    return first.productionProjectId as string;
  };
  const ids = {
    priv: await save(A, "u_owner", "d-private"), second: await save(A, "u_owner", "d-second"), gone: await save(A, "u_gone", "d-gone"),
    b: await save(B, "u_badmin", "d-b"),
  };
  const post = (ws: TenantWorkspace, p: Who, body: Json) => as(ws, p, async () => {
    const res = await projects.POST(new Request("https://particl.test/api/workbench/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never);
    return { status: res.status, body: (await res.json()) as Json };
  });
  const get = (ws: TenantWorkspace, p: Who, query: string) => as(ws, p, async () => { const res = await projects.GET(new Request(`https://particl.test/api/workbench/projects?${query}`), undefined as never); return { status: res.status, body: (await res.json()) as Json }; });
  const put = (ws: TenantWorkspace, p: Who, body: Json) => as(ws, p, async () => { const res = await projects.PUT(new Request("https://particl.test/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never); return { status: res.status, body: (await res.json()) as Json }; });
  const patchCanvas = (ws: TenantWorkspace, p: Who, productionId: string) => as(ws, p, async () => (await canvas.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }) }), undefined as never)).status);
  const rows = (ws: TenantWorkspace, sql: string, args: (string | number)[] = []) => as(ws, who("u_admin", "admin"), async () => (await database.db().execute({ sql, args })).rows as unknown as Json[]);
  const audit = (ws: TenantWorkspace) => rows(ws, "SELECT actor_id, action, target_type, target_id, workspace_id, details FROM security_audit WHERE action LIKE 'board.transfer%' ORDER BY created_at, id");
  const owner = (ws: TenantWorkspace, projectId: string) => as(ws, who("u_admin", "admin"), async () => (await draft.boardOwnerOf(projectId))?.owner ?? null);
  const counts = (ws: TenantWorkspace) => as(ws, who("u_admin", "admin"), async () => {
    const out: Record<string, number> = {};
    for (const t of ["workbench_projects", "projects", "shots", "generations", "workbench_team_canvas", "uploads", "meter_events"])
      out[t] = Number((await database.db().execute(`SELECT COUNT(*) AS n FROM ${t}`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n);
    return out;
  });
  return { A, B, tenant, database, records, platform, draft, as, post, get, put, patchCanvas, rows, audit, owner, counts, ids };
}
const ADMIN = who("u_admin", "admin");

test("a same-workspace admin hands a board to an active member: one line in the workspace's history, the draft not moved, the ownership read from the row", async () => {
  const f = await fixture("basic");
  const before = await f.counts(f.A);
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_owner");
  const res = await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_new" });
  expect(res.status).toBe(200);
  expect(res.body.moved).toEqual([{ projectId: f.ids.priv, draftId: "d-private", name: "Board d-private", from: "u_owner", to: "u_new" }]);
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_new");
  expect(await f.audit(f.A)).toEqual([{ actor_id: "u_admin", action: "board.transferred", target_type: "board", target_id: f.ids.priv, workspace_id: f.A.id, details: JSON.stringify({ from: "u_owner", to: "u_new" }) }]);
  /* Not re-keyed: the draft is still stored under the first owner's key at the same revision. */
  const stored = await f.rows(f.A, "SELECT owner, project_id, revision FROM workbench_projects WHERE key='u_owner:d-private'");
  expect(stored).toHaveLength(1);
  expect(await f.rows(f.A, "SELECT 1 FROM workbench_projects WHERE owner='u_new'")).toHaveLength(0);
  expect(await f.counts(f.A)).toEqual(before);
  /* "You": the admin may hand a board to themself. */
  expect((await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.second], to: "u_admin" })).status).toBe(200);
  expect(await f.owner(f.A, f.ids.second)).toBe("u_admin");
  /* Already theirs: nothing changes. */
  expect((await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_new" })).status).toBe(409);
  expect(await f.audit(f.A)).toHaveLength(2);
});

test("a member cannot hand a board over, not even their own; nothing is written", async () => {
  const f = await fixture("member");
  for (const p of [who("u_owner"), who("u_mate"), who("u_new")]) {
    const res = await f.post(f.A, p, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_mate" });
    expect(res.status, p.id).toBe(403);
    const all = await f.post(f.A, p, { action: "transfer-all", from: "u_owner", to: "u_mate" });
    expect(all.status, `${p.id} all`).toBe(403);
    expect((await f.post(f.A, p, { action: "undo-transfer", projectIds: [f.ids.priv] })).status, `${p.id} undo`).toBe(403);
  }
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_owner");
  expect(await f.rows(f.A, "SELECT 1 FROM workbench_board_owners")).toHaveLength(0);
  expect(await f.audit(f.A)).toEqual([]);
});

test("an admin of another workspace cannot hand over a board here, nor move boards of their own to someone here", async () => {
  const f = await fixture("other");
  const outsider = who("u_badmin", "admin");
  /* Inside their own workspace the ids of this one are no boards. */
  expect((await f.post(f.B, outsider, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_bmember" })).status).toBe(404);
  expect((await f.post(f.B, outsider, { action: "transfer-all", from: "u_owner", to: "u_bmember" })).body.moved).toEqual([]);
  /* Their own board to someone who is a member of the other workspace only. */
  expect((await f.post(f.B, outsider, { action: "transfer-boards", projectIds: [f.ids.b], to: "u_new" })).status).toBe(404);
  /* With their sign-in inside this workspace (they are no member here) the target is still the workspace's own members and the board is not theirs to hand over by default. */
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_owner");
  expect(await f.rows(f.A, "SELECT 1 FROM workbench_board_owners")).toHaveLength(0);
  expect(await f.rows(f.B, "SELECT 1 FROM workbench_board_owners")).toHaveLength(0);
  expect(await f.audit(f.A)).toEqual([]);
  expect(await f.audit(f.B)).toEqual([]);
});

test("the new owner must be an active member of the same workspace: another workspace's member, a disabled member, a stranger, an Atomik run and nothing are refused", async () => {
  const f = await fixture("target");
  for (const to of ["u_bmember", "u_badmin", "u_off", "u_gone", "u_nobody", "agent:run_1", "server", "", 7, null] as const) {
    const res = await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to });
    expect([400, 404], String(to)).toContain(res.status);
  }
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_owner");
  expect(await f.audit(f.A)).toEqual([]);
  expect((await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_new" })).status).toBe(200);
});

test("after a handover the new owner reads and writes and the old owner does not, unless it is shared; uploads follow; money rows and takes are untouched", async () => {
  const f = await fixture("after");
  const { uploadOpenableBy } = await import("../../lib/uploadAccess");
  /* Two uploads the old owner made: one the board's draft holds, one on its team canvas. */
  await f.as(f.A, ADMIN, async () => {
    const db = f.database.db();
    for (const id of ["upl_draft", "upl_canvas", "upl_other"])
      await db.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,uploader_id) VALUES(?,?,?,?,1,'x',NULL,NULL,'',1,'image','u_owner')", args: [id, "a.png", "image/png", "png"] });
    await db.execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.zzRef',json('{\"uploadId\":\"upl_draft\"}')) WHERE key='u_owner:d-private'", args: [] });
    await f.records.workbenchReady();
    const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
    await teamCanvasReady();
    await db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,1,'u_owner',1)", args: [f.ids.priv, JSON.stringify({ nodes: { n1: { id: "n1", title: "x", uploadId: "upl_canvas" } } })] });
  });
  const opens = (p: Who, id: string) => f.as(f.A, p, () => uploadOpenableBy(id, { id: p.id, role: p.role }));
  const OWNER = who("u_owner"), NEW = who("u_new"), MATE = who("u_mate");
  for (const id of ["upl_draft", "upl_canvas"]) {
    expect(await opens(NEW, id), `before: new owner ${id}`).toBe(false);
    expect(await opens(OWNER, id), `before: uploader ${id}`).toBe(true);
  }
  const before = await f.counts(f.A);
  expect((await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_new" })).status).toBe(200);
  expect(await f.counts(f.A), "takes, shots, uploads, the canvas and the meter are exactly as they were").toEqual(before);
  /* Uploads follow the board; they stay the uploader's too; nobody else's. */
  for (const id of ["upl_draft", "upl_canvas"]) {
    expect(await opens(NEW, id), `after: new owner ${id}`).toBe(true);
    expect(await opens(OWNER, id), `after: uploader ${id}`).toBe(true);
    expect(await opens(MATE, id), `after: a teammate ${id}`).toBe(false);
    expect(await opens(ADMIN, id), `after: an admin who is not the owner ${id}`).toBe(false);
  }
  expect(await opens(NEW, "upl_other"), "an upload no handed board holds").toBe(false);
  /* Reach: the new owner reads and writes; the old owner and a teammate do not. */
  const { mayReachProject, projectLister } = await import("../../lib/draftProject");
  const reach = (p: Who, access: "read" | "write") => f.as(f.A, p, () => mayReachProject({ id: p.id, role: p.role }, f.ids.priv, access));
  expect([await reach(NEW, "read"), await reach(NEW, "write")]).toEqual([true, true]);
  expect([await reach(OWNER, "read"), await reach(OWNER, "write")]).toEqual([false, false]);
  expect([await reach(MATE, "read"), await reach(MATE, "write")]).toEqual([false, false]);
  const lists = (p: Who) => f.as(f.A, p, async () => (await projectLister({ id: p.id, role: p.role }))(f.ids.priv));
  expect([await lists(NEW), await lists(OWNER), await lists(MATE)]).toEqual([true, false, false]);
  /* The boards each lists as theirs. */
  expect((await f.get(f.A, NEW, "")).body.projects.map((b: Json) => b.id)).toEqual(["d-private"]);
  expect((await f.get(f.A, OWNER, "")).body.projects.map((b: Json) => b.id)).toEqual(["d-second"]);
  /* Opening and saving: the new owner's save goes to the stored draft, as them; the old owner's goes nowhere. */
  const opened = await f.get(f.A, NEW, "id=d-private");
  expect(opened.body.project?.id).toBe("d-private");
  expect(opened.body.viewOnly).toBeUndefined();
  const saved = await f.put(f.A, NEW, { project: { ...opened.body.project, name: "Renamed by the new owner" }, revision: opened.body.revision });
  expect(saved.status).toBe(200);
  expect((await f.rows(f.A, "SELECT updated_by, owner FROM workbench_projects WHERE key='u_owner:d-private'"))[0]).toMatchObject({ updated_by: "u_new", owner: "u_owner" });
  const stale = await f.get(f.A, OWNER, "id=d-private");
  expect(stale.body.project).toBeNull();
  const oldSave = await f.put(f.A, OWNER, { project: { ...opened.body.project, name: "Back again" }, revision: saved.body.revision });
  expect(oldSave.status).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(String((await f.rows(f.A, "SELECT body FROM workbench_projects WHERE key='u_owner:d-private'"))[0].body)).name).toBe("Renamed by the new owner");
  /* The canvas: the new owner writes; the old owner and a teammate are answered as for a board that is not there. */
  expect(await f.patchCanvas(f.A, NEW, f.ids.priv)).toBe(200);
  expect(await f.patchCanvas(f.A, OWNER, f.ids.priv)).toBe(404);
  expect(await f.patchCanvas(f.A, MATE, f.ids.priv)).toBe(404);
  /* Sharing is the new owner's to change (and not the old owner's); shared to look at, the old owner looks like any teammate. */
  expect((await f.post(f.A, OWNER, { action: "team-share", projectId: "d-private", owner: "u_owner", mode: "view" })).status).toBeGreaterThanOrEqual(400);
  const shared = await f.post(f.A, NEW, { action: "team-share", projectId: "d-private", mode: "view" });
  expect(shared.status).toBe(200);
  const looked = await f.get(f.A, OWNER, "id=d-private&owner=u_new");
  expect(looked.status).toBe(200);
  expect(looked.body.viewOnly?.owner?.id).toBe("u_new");
  expect([await reach(OWNER, "read"), await reach(OWNER, "write")]).toEqual([true, false]);
  /* A teammate's list names the new owner as its maker. */
  const team = await f.get(f.A, MATE, "team=1");
  expect(team.body.team.find((b: Json) => b.id === "d-private")).toMatchObject({ owner: { id: "u_new" }, mine: false });
});

test("Undo gives the board back to who it was, is itself audited, can be undone in turn, and refuses a board that was never moved", async () => {
  const f = await fixture("undo");
  expect((await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: [f.ids.priv] })).status).toBe(409);
  await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_new" });
  await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv], to: "u_mate" });
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_mate");
  const undone = await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: [f.ids.priv] });
  expect(undone.status).toBe(200);
  expect(undone.body.restored).toEqual([{ projectId: f.ids.priv, draftId: "d-private", name: "Board d-private", from: "u_mate", to: "u_new" }]);
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_new");
  const lines = await f.audit(f.A);
  expect(lines.map((l) => l.action)).toEqual(["board.transferred", "board.transferred", "board.transfer_undone"]);
  expect(JSON.parse(String(lines[2].details))).toEqual({ from: "u_mate", to: "u_new" });
  expect(lines[2]).toMatchObject({ actor_id: "u_admin", target_id: f.ids.priv, workspace_id: f.A.id });
  /* And again: back to the first owner, who then owns it as if nothing had happened. */
  await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: [f.ids.priv] });
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_mate");
  await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: [f.ids.priv] });
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_new");
  /* A single move and its Undo: the original owner has it again, can open and save it. */
  await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.second], to: "u_new" });
  await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: [f.ids.second] });
  expect(await f.owner(f.A, f.ids.second)).toBe("u_owner");
  const reopened = await f.get(f.A, who("u_owner"), "id=d-second");
  expect(reopened.body.project?.id).toBe("d-second");
  expect((await f.put(f.A, who("u_owner"), { project: reopened.body.project, revision: reopened.body.revision })).status).toBe(200);
  expect(await f.put(f.A, who("u_new"), { project: reopened.body.project, revision: reopened.body.revision + 1 }).then((r) => r.status)).toBeGreaterThanOrEqual(400);
});

test("the never-delete rule: a handover and its Undo remove nothing, the row stays, and no board, take, shot, upload or canvas is lost", async () => {
  const f = await fixture("keep");
  const before = await f.counts(f.A);
  await f.post(f.A, ADMIN, { action: "transfer-boards", projectIds: [f.ids.priv, f.ids.second], to: "u_new" });
  await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: [f.ids.priv, f.ids.second] });
  expect(await f.counts(f.A)).toEqual(before);
  const rows = await f.rows(f.A, "SELECT project_id, owner, previous_owner FROM workbench_board_owners ORDER BY project_id");
  expect(rows).toHaveLength(2);
  for (const r of rows) expect(r).toMatchObject({ owner: "u_owner", previous_owner: "u_new" });
  expect(await f.audit(f.A)).toHaveLength(4);
  /* There is no statement in the transfer code that deletes anything. */
  const source = readFileSync(path.resolve("lib/workbench/board-transfer.ts"), "utf8");
  expect(source).not.toMatch(/\bDELETE\b/i);
  expect(source).not.toMatch(/\bDROP\b/i);
});

test("moving all of a member's boards: one action for a member who has left or is leaving, to an active member or to the admin; the sample and other people's boards are left", async () => {
  const f = await fixture("batch");
  /* A member who has left: their board goes to the admin ("You"). */
  const left = await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_gone", to: "u_admin" });
  expect(left.status).toBe(200);
  expect(left.body.moved.map((m: Json) => [m.draftId, m.from, m.to])).toEqual([["d-gone", "u_gone", "u_admin"]]);
  expect(await f.owner(f.A, f.ids.gone)).toBe("u_admin");
  /* The admin can then work on it as their own. */
  const opened = await f.get(f.A, ADMIN, "id=d-gone");
  expect(opened.body.project?.id).toBe("d-gone");
  expect(opened.body.viewOnly).toBeUndefined();
  /* A member's two boards, to another member; the same member twice moves nothing more. */
  const all = await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_owner", to: "u_new" });
  expect(all.body.moved.map((m: Json) => m.draftId).sort()).toEqual(["d-private", "d-second"]);
  expect((await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_owner", to: "u_new" })).body.moved).toEqual([]);
  expect((await f.get(f.A, who("u_new"), "")).body.projects.map((b: Json) => b.id).sort()).toEqual(["d-private", "d-second"]);
  expect((await f.get(f.A, who("u_owner"), "")).body.projects).toEqual([]);
  /* A board the target already owns is not "moved"; boards moved onward follow the new owner. */
  const onward = await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_new", to: "u_mate" });
  expect(onward.body.moved).toHaveLength(2);
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_mate");
  /* Refusals: the same person, a target who is not a member, a stranger as the source. */
  expect((await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_mate", to: "u_mate" })).status).toBe(409);
  expect((await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_mate", to: "u_off" })).status).toBe(404);
  expect((await f.post(f.A, ADMIN, { action: "transfer-all", from: "u_nobody", to: "u_new" })).body.moved).toEqual([]);
  expect((await f.audit(f.A)).length).toBe(1 + 2 + 2);
  /* Undo the whole batch. */
  const ids = onward.body.moved.map((m: Json) => m.projectId);
  expect((await f.post(f.A, ADMIN, { action: "undo-transfer", projectIds: ids })).status).toBe(200);
  expect(await f.owner(f.A, f.ids.priv)).toBe("u_new");
});
