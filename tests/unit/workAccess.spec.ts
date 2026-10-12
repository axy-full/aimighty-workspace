import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Who may change work that is not theirs (lib/workAccess.ts; owner, 12 Oct 2026): only the board's owner or a workspace admin may rename, move,
 * pick, approve, trash, restore or delete a take, a shot or a project. The real routes, on real workspace databases in a temp directory:
 * PATCH and DELETE /api/jobs/:id, PATCH and DELETE /api/shots/:id, POST /api/shots/reorder, PATCH and DELETE /api/projects/:id.
 * A member who made the work keeps it fully editable; an API token acts as the person who made it; another workspace's people reach nothing here
 * (its database has none of these ids, so the routes answer as for an unknown one). Nothing renders and nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-work-access-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string): TenantWorkspace => ({
  id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
  ownerId: "u_admin", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null,
  rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});

type Who = { id: string; role: "admin" | "member"; owner?: boolean; token?: boolean };
const PEOPLE: Record<string, Who> = {
  maker: { id: "u_maker", role: "member" },
  teammate: { id: "u_teammate", role: "member" },
  stranger: { id: "u_stranger", role: "member" },
  admin: { id: "u_admin", role: "admin" },
  owner: { id: "u_owner", role: "admin", owner: true },
  strangerToken: { id: "u_stranger", role: "member", token: true },
  adminToken: { id: "u_admin", role: "admin", token: true },
};

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

async function setup(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const records = await import("../../lib/workbench/records");
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  const state = { who: PEOPLE.admin as Who, ws };
  const auth = {
    withTenant: (handler: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => tenant.runInTenant(state.ws, () => handler(...a)),
    requireUser: async () => ({ user: { id: state.who.id, name: state.who.id, role: state.who.role, owner: Boolean(state.who.owner) }, ...(state.who.token ? { token: { id: "tok", name: "t", scope: "render" } } : {}) }),
  };
  const common = { "@/lib/auth": auth, "@/lib/db": database, "@/lib/tenant": tenant, "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" }, "@/lib/workAccess": await import("../../lib/workAccess") };
  const jobs = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    ...common, "@/lib/workbench/records": records, "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
    "@/lib/mediaBindings": await import("../../lib/mediaBindings"), "@/lib/mediaDeletion": await import("../../lib/mediaDeletion"),
    "@/lib/jobs": await import("../../lib/jobs"), "@/lib/shots": await import("../../lib/shots"), "@/lib/held": await import("../../lib/held"),
    "next/server": { NextResponse, after: () => {} }, "@/lib/recovery": { reserveRecoveryContinuation: async (_n: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async () => {} }, "@/lib/usageLedger": {},
  });
  const shots = load<typeof import("../../app/api/shots/[id]/route")>("app/api/shots/[id]/route.ts", {
    ...common, "@/lib/archive": await import("../../lib/archive"), "@/lib/mediaMutation": await import("../../lib/mediaMutation"), "@/lib/shots": await import("../../lib/shots"),
  });
  const reorder = load<typeof import("../../app/api/shots/reorder/route")>("app/api/shots/reorder/route.ts", common);
  const productions = load<typeof import("../../app/api/productions/[id]/route")>("app/api/productions/[id]/route.ts", { ...common, "@/lib/productions": await import("../../lib/productions") });
  const sync = load<typeof import("../../app/api/shots/sync/route")>("app/api/shots/sync/route.ts", common);
  const projects = load<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts", {
    ...common, "@/lib/archive": await import("../../lib/archive"), "@/lib/caps": await import("../../lib/caps"), "@/lib/credits": await import("../../lib/credits"),
  });
  const req = (method: string, body?: unknown) => new Request("https://studio.test/api/x", { method, headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${state.ws.id}-${state.who.id}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  return {
    as: (name: string, other?: TenantWorkspace) => { state.who = PEOPLE[name]; if (other) state.ws = other; },
    jobPatch: (id: string, body: unknown) => jobs.PATCH(req("PATCH", body), ctx(id)),
    jobDelete: (id: string) => jobs.DELETE(req("DELETE"), ctx(id)),
    shotPatch: (id: string, body: unknown) => shots.PATCH(req("PATCH", body), ctx(id)),
    shotDelete: (id: string) => shots.DELETE(req("DELETE"), ctx(id)),
    reorder: (projectId: string, ids: string[]) => reorder.POST(req("POST", { projectId, ids }), ctx("")),
    productionPatch: (id: string, body: unknown) => productions.PATCH(req("PATCH", body), ctx(id)),
    sync: (projectId: string) => sync.POST(req("POST", { projectId }), ctx("")),
    projectPatch: (id: string, body: unknown) => projects.PATCH(req("PATCH", body), ctx(id)),
    projectDelete: (id: string) => projects.DELETE(req("DELETE"), ctx(id)),
    mappedId: records.mappedId,
  };
}

const ids = { draft: "draft-1" };
async function seed(ws: TenantWorkspace, mappedId: (p: string, ...parts: string[]) => string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const board = mappedId("prj_wb_", ws.id, PEOPLE.maker.id, ids.draft);
  const board2 = mappedId("prj_wb_", ws.id, PEOPLE.maker.id, "draft-2");
  await runInTenant(ws, async () => {
    await ready();
    const { workbenchReady } = await import("../../lib/workbench/records");
    await workbenchReady();
    await db().batch([
      /* The maker's board: a draft of theirs, whose own project (an id made from the workspace, the owner and the draft) it is. */
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${PEOPLE.maker.id}:${ids.draft}`, PEOPLE.maker.id, ids.draft, "Board", JSON.stringify({ id: ids.draft, name: "Board", productionProjectId: board })] },
      /* A second board of the maker's, and a teammate's own draft that NAMES the maker's board as its production (it links it; it does not make it theirs). */
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${PEOPLE.maker.id}:draft-2`, PEOPLE.maker.id, "draft-2", "Board two", JSON.stringify({ id: "draft-2", name: "Board two", productionProjectId: board2 })] },
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${PEOPLE.teammate.id}:draft-t`, PEOPLE.teammate.id, "draft-t", "Teammate's own draft of it", JSON.stringify({ id: "draft-t", name: "Teammate's own draft of it", productionProjectId: board })] },
      { sql: "INSERT INTO productions(id,name,created_at) VALUES('prod-board','Board production',0),('prod-plain','Plain production',0),('prod-two','Board two production',0)", args: [] },
      { sql: "INSERT INTO projects(id,name,created_at,production_id) VALUES(?,?,0,'prod-board'),(?,?,0,'prod-two'),('plain','Plain',0,'prod-plain'),('spare','Spare',0,NULL)", args: [board, "Board", board2, "Board two"] },
      { sql: "INSERT INTO shots(id,project_id,code,title,status,position,created_by,created_at,updated_at) VALUES('s-maker',?,'010','Own','open',0,?,0,0),('s-mate',?,'020','Mate','open',1,?,0,0),('s-plain','plain','030','Plain','open',0,?,0,0)", args: [board, PEOPLE.maker.id, board, PEOPLE.teammate.id, PEOPLE.teammate.id] },
      { sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url) VALUES
        ('t-maker','m','p','{}','succeeded',1,1,'image','Maker take',0,?,?,'/api/media/t-maker'),('t-mate','m','p','{}','succeeded',1,1,'image','Mate take',0,?,?,'/api/media/t-mate'),
        ('t-plain','m','p','{}','succeeded',1,1,'image','Plain take',0,?,'plain','/api/media/t-plain'),('t-unknown','m','p','{}','succeeded',1,1,'image','Unknown take',0,'',?,'/api/media/t-unknown')`,
        args: [PEOPLE.maker.id, board, PEOPLE.teammate.id, board, PEOPLE.teammate.id, board] },
    ], "write");
  });
  return board;
}
const boardTwo = (mappedId: (p: string, ...parts: string[]) => string, ws: TenantWorkspace) => mappedId("prj_wb_", ws.id, PEOPLE.maker.id, "draft-2");
const read = async (ws: TenantWorkspace, sql: string, args: unknown[] = []) => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  return runInTenant(ws, async () => (await db().execute({ sql, args: args as never })).rows);
};
const refusal = async (r: Response) => ({ status: r.status, error: String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "") });

test("a take: its maker, the board's owner or an admin change it; anyone else is refused in plain words and nothing changes", async () => {
  const ws = workspace("work-takes");
  const api = await setup(ws);
  const board = await seed(ws, api.mappedId);
  const title = async (id: string) => String((await read(ws, "SELECT title FROM generations WHERE id=?", [id]))[0].title);
  const { NOT_YOURS } = await import("../../lib/workAccess");

  /* A stranger (a member who made none of it): every kind of change on the maker's take is refused, and the take is untouched. */
  api.as("stranger");
  for (const body of [{ title: "Mine now" }, { reviewState: "approved" }, { reviewState: "picked" }, { projectId: "spare" }, { trashed: true }, { shotId: "s-maker" }, { useAs: "first" }]) {
    const r = await refusal(await api.jobPatch("t-maker", body));
    expect(r, JSON.stringify(body)).toEqual({ status: 403, error: NOT_YOURS.take });
  }
  expect(await refusal(await api.jobDelete("t-maker"))).toEqual({ status: 403, error: NOT_YOURS.take });
  expect(await refusal(await api.jobPatch("t-mate", { title: "x" }))).toEqual({ status: 403, error: NOT_YOURS.take });
  const row = (await read(ws, "SELECT title, project_id, review_state, deleted, shot_id FROM generations WHERE id='t-maker'"))[0];
  expect([row.title, row.project_id, row.review_state, Number(row.deleted), row.shot_id]).toEqual(["Maker take", board, "", 0, null]);

  /* The person who made a take keeps it fully editable: rename, review, trash and restore. */
  api.as("teammate");
  expect((await api.jobPatch("t-mate", { title: "Renamed by its maker" })).status).toBe(200);
  expect(await title("t-mate")).toBe("Renamed by its maker");
  expect((await api.jobPatch("t-mate", { reviewState: "approved" })).status).toBe(200);
  expect((await api.jobPatch("t-mate", { trashed: true })).status).toBe(200);
  expect((await api.jobPatch("t-mate", { trashed: false })).status).toBe(200);
  /* ... and cannot touch the maker's. */
  expect((await api.jobPatch("t-maker", { title: "nope" })).status).toBe(403);

  /* The board's owner changes every take on their board, including a teammate's and one whose maker is not recorded, but not one on a project with no recorded owner. */
  api.as("maker");
  expect((await api.jobPatch("t-mate", { title: "Edited by the board's owner" })).status).toBe(200);
  expect((await api.jobPatch("t-unknown", { reviewState: "approved" })).status).toBe(200);
  expect((await api.jobPatch("t-plain", { title: "no" })).status).toBe(403);
  expect(await title("t-mate")).toBe("Edited by the board's owner");

  /* An admin and the workspace's owner change any of them; so does an admin's token, and a stranger's token is a stranger. */
  for (const who of ["admin", "owner", "adminToken"]) {
    api.as(who);
    expect((await api.jobPatch("t-plain", { title: `By ${who}` })).status, who).toBe(200);
    expect((await api.jobPatch("t-maker", { reviewState: "picked" })).status, who).toBe(200);
  }
  api.as("strangerToken");
  expect((await api.jobPatch("t-maker", { title: "token" })).status).toBe(403);
  expect((await api.jobDelete("t-mate")).status).toBe(403);

  /* A delete by the board's owner and by an admin goes through (it hides the take; nothing is erased). */
  api.as("maker");
  expect((await api.jobDelete("t-unknown")).status).toBe(200);
  api.as("admin");
  expect((await api.jobDelete("t-plain")).status).toBe(200);

  /* Another workspace's people: its database has none of these ids, so a change reaches nothing, whoever they are (an admin there included). */
  const other = workspace("work-takes-elsewhere");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await runInTenant(other, ready);
  for (const who of ["admin", "stranger", "maker"]) {
    api.as(who, other);
    await api.jobPatch("t-maker", { title: "elsewhere" });
    await api.jobDelete("t-maker");
  }
  expect(await read(other, "SELECT id FROM generations")).toEqual([]);
  expect(await title("t-maker")).toBe("Maker take");
  expect(Number((await read(ws, "SELECT deleted FROM generations WHERE id='t-maker'"))[0].deleted)).toBe(0);
});

test("a shot: its maker, the board's owner or an admin change, move, reorder or delete it; anyone else is refused and nothing changes", async () => {
  const ws = workspace("work-shots");
  const api = await setup(ws);
  const board = await seed(ws, api.mappedId);
  const { NOT_YOURS } = await import("../../lib/workAccess");
  const shot = async (id: string) => (await read(ws, "SELECT title, project_id, position FROM shots WHERE id=?", [id]))[0];

  api.as("stranger");
  for (const body of [{ title: "Mine now" }, { projectId: "spare" }, { status: "approved" }, { position: 9 }, { code: "999" }]) {
    expect(await refusal(await api.shotPatch("s-maker", body)), JSON.stringify(body)).toEqual({ status: 403, error: NOT_YOURS.shot });
  }
  expect(await refusal(await api.shotDelete("s-maker"))).toEqual({ status: 403, error: NOT_YOURS.shot });
  expect(await refusal(await api.reorder(board, ["s-mate", "s-maker"]))).toEqual({ status: 403, error: NOT_YOURS.shot });
  expect(Object.values(await shot("s-maker"))).toEqual(["Own", board, 0]);

  /* The maker of a shot keeps it fully editable, but not another's on the same board. */
  api.as("teammate");
  expect((await api.shotPatch("s-mate", { title: "Renamed by its maker" })).status).toBe(200);
  expect((await api.shotPatch("s-maker", { title: "no" })).status).toBe(403);
  expect(await refusal(await api.reorder(board, ["s-mate", "s-maker"]))).toMatchObject({ status: 403 });

  /* The board's owner changes, moves and reorders every shot on it; a shot on a project with no recorded owner is its maker's or an admin's. */
  api.as("maker");
  expect((await api.shotPatch("s-mate", { title: "By the board's owner" })).status).toBe(200);
  expect((await api.reorder(board, ["s-mate", "s-maker"])).status).toBe(200);
  expect((await shot("s-mate")).position).toBe(0);
  expect((await api.shotPatch("s-plain", { title: "no" })).status).toBe(403);

  for (const who of ["admin", "owner", "adminToken"]) {
    api.as(who);
    expect((await api.shotPatch("s-plain", { title: `By ${who}` })).status, who).toBe(200);
  }
  api.as("strangerToken");
  expect((await api.shotDelete("s-mate")).status).toBe(403);

  api.as("maker");
  expect((await api.shotPatch("s-mate", { projectId: boardTwo(api.mappedId, ws) })).status).toBe(200);
  expect((await api.shotDelete("s-maker")).status).toBe(200);
  expect(await read(ws, "SELECT id FROM shots WHERE id='s-maker'")).toEqual([]);
  api.as("admin");
  expect((await api.shotDelete("s-plain")).status).toBe(200);
  /* An id nobody has is answered as it always was, whoever asks. */
  api.as("stranger");
  expect((await api.shotPatch("no-such-shot", { title: "x" })).status).toBe(404);
  expect((await api.shotDelete("no-such-shot")).status).toBe(200);

  /* Another workspace's people reach nothing here. */
  const other = workspace("work-shots-elsewhere");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await runInTenant(other, ready);
  api.as("admin", other);
  expect((await api.shotPatch("s-mate", { title: "elsewhere" })).status).toBe(404);
  expect((await shot("s-mate")).title).toBe("By the board's owner");
});

test("a project: its owner or an admin renames or deletes it; anyone else is refused, and a project with no recorded owner is an admin's", async () => {
  const ws = workspace("work-projects");
  const api = await setup(ws);
  const board = await seed(ws, api.mappedId);
  const { NOT_YOURS } = await import("../../lib/workAccess");
  const name = async (id: string) => String((await read(ws, "SELECT name FROM projects WHERE id=?", [id]))[0]?.name);

  api.as("stranger");
  expect(await refusal(await api.projectPatch(board, { name: "Mine now" }))).toEqual({ status: 403, error: NOT_YOURS.project });
  expect(await refusal(await api.projectDelete(board))).toEqual({ status: 403, error: NOT_YOURS.project });
  api.as("teammate");
  expect((await api.projectPatch(board, { name: "x" })).status).toBe(403);
  expect((await api.projectDelete(board)).status).toBe(403);
  api.as("strangerToken");
  expect((await api.projectDelete(board)).status).toBe(403);
  expect(await name(board)).toBe("Board");
  expect((await read(ws, "SELECT id FROM shots WHERE project_id=?", [board])).length).toBe(2);

  /* A project made with no board of anyone's behind it records no creator: only an admin. */
  api.as("maker");
  expect((await api.projectPatch("plain", { name: "x" })).status).toBe(403);
  expect((await api.projectDelete("plain")).status).toBe(403);
  for (const who of ["admin", "owner", "adminToken"]) {
    api.as(who);
    expect((await api.projectPatch("plain", { name: `By ${who}` })).status, who).toBe(200);
  }
  expect(await name("plain")).toBe("By adminToken");

  /* The owner of the board renames and deletes it; its takes fall back to unfiled (nothing is erased). */
  api.as("maker");
  expect((await api.projectPatch(board, { name: "Renamed by its owner" })).status).toBe(200);
  expect(await name(board)).toBe("Renamed by its owner");
  expect((await api.projectDelete(board)).status).toBe(200);
  expect(await read(ws, "SELECT id FROM projects WHERE id=?", [board])).toEqual([]);
  api.as("admin");
  expect((await api.projectDelete("spare")).status).toBe(200);
  /* An id nobody has is answered as it always was. */
  api.as("stranger");
  expect((await api.projectDelete("no-such-project")).status).toBe(404);

  /* Another workspace's people reach nothing here. */
  const other = workspace("work-projects-elsewhere");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await runInTenant(other, ready);
  api.as("admin", other);
  expect((await api.projectDelete("plain")).status).toBe(404);
  expect(await name("plain")).toBe("By adminToken");
});

test("a draft that names a project as its production does not make its owner that project's maker", async () => {
  const ws = workspace("work-linked");
  const api = await setup(ws);
  const board = await seed(ws, api.mappedId);
  const { projectMaker, NOT_YOURS } = await import("../../lib/workAccess");
  const { runInTenant } = await import("../../lib/tenant");
  /* The teammate's own draft carries productionProjectId = the maker's board (seeded), as an opened link does: the maker is still the maker. */
  expect(await runInTenant(ws, () => projectMaker(board))).toBe(PEOPLE.maker.id);
  api.as("teammate");
  expect(await refusal(await api.projectPatch(board, { name: "Mine now" }))).toEqual({ status: 403, error: NOT_YOURS.project });
  expect(await refusal(await api.projectDelete(board))).toEqual({ status: 403, error: NOT_YOURS.project });
  expect((await api.shotPatch("s-maker", { title: "no" })).status).toBe(403);
  api.as("maker");
  expect((await api.projectPatch(board, { name: "Still the maker's" })).status).toBe(200);
});

test("a production: the owner of the board it belongs to or an admin renames it or changes its status; the cap stays an admin's", async () => {
  const ws = workspace("work-productions");
  const api = await setup(ws);
  await seed(ws, api.mappedId);
  const { NOT_YOURS } = await import("../../lib/workAccess");
  const name = async (id: string) => String((await read(ws, "SELECT name FROM productions WHERE id=?", [id]))[0]?.name);

  api.as("stranger");
  expect(await refusal(await api.productionPatch("prod-board", { name: "Mine now" }))).toEqual({ status: 403, error: NOT_YOURS.production });
  expect((await api.productionPatch("prod-board", { client: "x" })).status).toBe(403);
  expect((await api.productionPatch("prod-board", { status: "delivered" })).status).toBe(403);
  api.as("teammate");
  expect((await api.productionPatch("prod-board", { name: "Teammate" })).status).toBe(403);
  api.as("strangerToken");
  expect((await api.productionPatch("prod-board", { name: "Token" })).status).toBe(403);
  expect(await name("prod-board")).toBe("Board production");

  api.as("maker");
  expect((await api.productionPatch("prod-board", { name: "Renamed by the board's owner", client: "A client", status: "delivered" })).status).toBe(200);
  expect(await name("prod-board")).toBe("Renamed by the board's owner");
  /* A cap is an admin's, and a person's, as before: the board's owner is refused it. */
  const cap = await refusal(await api.productionPatch("prod-board", { capCredits: 10 }));
  expect(cap.status).toBe(403);
  expect(cap.error).toBe("An admin sets a production's cap.");
  /* A production with no project of anyone's behind it is an admin's. */
  expect((await api.productionPatch("prod-plain", { name: "x" })).status).toBe(403);
  for (const who of ["admin", "owner"]) {
    api.as(who);
    expect((await api.productionPatch("prod-plain", { name: `By ${who}` })).status, who).toBe(200);
  }
  api.as("adminToken");
  expect((await api.productionPatch("prod-board", { status: "active" })).status).toBe(200);
  /* An id nobody has is answered as it always was. */
  api.as("stranger");
  expect((await api.productionPatch("no-such-production", { name: "x" })).status).toBe(404);
});

test("a move is asked at both ends: a take or a shot goes into a project or against a shot only if the person may change that too", async () => {
  const ws = workspace("work-moves");
  const api = await setup(ws);
  const board = await seed(ws, api.mappedId);
  const board2 = boardTwo(api.mappedId, ws);
  const { NOT_YOURS } = await import("../../lib/workAccess");
  const where = async (table: string, id: string) => String((await read(ws, `SELECT project_id FROM ${table} WHERE id=?`, [id]))[0].project_id);
  const filed = async (id: string) => (await read(ws, "SELECT shot_id FROM generations WHERE id=?", [id]))[0].shot_id;

  /* The teammate made t-mate and s-mate (on the maker's board). Their own work moves only into what they may change. */
  api.as("teammate");
  expect(await refusal(await api.jobPatch("t-mate", { projectId: board2 }))).toEqual({ status: 403, error: NOT_YOURS.moveToProject });
  expect(await refusal(await api.jobPatch("t-mate", { projectId: "plain" }))).toEqual({ status: 403, error: NOT_YOURS.moveToProject });
  expect(await refusal(await api.jobPatch("t-mate", { shotId: "s-maker" }))).toEqual({ status: 403, error: NOT_YOURS.moveToShot });
  expect(await refusal(await api.shotPatch("s-mate", { projectId: board2 }))).toEqual({ status: 403, error: NOT_YOURS.moveToProject });
  expect(await where("generations", "t-mate")).toBe(board);
  expect(await filed("t-mate")).toBeNull();
  expect(await where("shots", "s-mate")).toBe(board);
  /* Their own shot is a target they may use; unfiling and an unknown target are answered as before (nothing is written to an unknown shot). */
  expect((await api.jobPatch("t-mate", { shotId: "s-mate" })).status).toBe(200);
  expect(await filed("t-mate")).toBe("s-mate");
  expect((await api.jobPatch("t-mate", { shotId: "" })).status).toBe(200);
  expect((await api.jobPatch("t-mate", { shotId: "no-such-shot" })).status).toBe(404);
  expect((await api.shotPatch("s-mate", { projectId: "no-such-project" })).status).toBe(404);
  expect((await api.jobPatch("t-mate", { projectId: "" })).status).toBe(200);
  expect(await where("generations", "t-mate")).toBe("null");

  /* A token is the person who made it. */
  api.as("strangerToken");
  expect((await api.jobPatch("t-mate", { projectId: board })).status).toBe(403);

  /* The board's owner moves their board's work between boards they own; into one they don't, no. */
  api.as("maker");
  expect((await api.jobPatch("t-maker", { projectId: board2 })).status).toBe(200);
  expect(await where("generations", "t-maker")).toBe(board2);
  expect(await refusal(await api.jobPatch("t-maker", { projectId: "plain" }))).toEqual({ status: 403, error: NOT_YOURS.moveToProject });
  expect(await refusal(await api.shotPatch("s-maker", { projectId: "spare" }))).toEqual({ status: 403, error: NOT_YOURS.moveToProject });
  expect((await api.shotPatch("s-maker", { projectId: board2 })).status).toBe(200);
  expect(await where("shots", "s-maker")).toBe(board2);

  /* An admin and the workspace's owner move work anywhere. */
  for (const who of ["admin", "owner", "adminToken"]) {
    api.as(who);
    expect((await api.jobPatch("t-plain", { projectId: board })).status, who).toBe(200);
    expect((await api.jobPatch("t-plain", { projectId: "plain" })).status, who).toBe(200);
    expect((await api.jobPatch("t-plain", { shotId: "s-maker" })).status, who).toBe(200);
    expect((await api.shotPatch("s-plain", { projectId: board })).status, who).toBe(200);
    expect((await api.shotPatch("s-plain", { projectId: "plain" })).status, who).toBe(200);
  }
});

test("sending a project's shot list across is its owner's or an admin's", async () => {
  const ws = workspace("work-sync");
  const api = await setup(ws);
  const board = await seed(ws, api.mappedId);
  const { NOT_YOURS } = await import("../../lib/workAccess");
  api.as("stranger");
  expect(await refusal(await api.sync(board))).toEqual({ status: 403, error: NOT_YOURS.project });
  api.as("teammate");
  expect((await api.sync(board)).status).toBe(403);
  api.as("maker");
  expect((await api.sync(board)).status).toBe(200);
  expect((await api.sync("plain")).status).toBe(403);
  api.as("admin");
  expect((await api.sync("plain")).status).toBe(200);
  /* A project nobody has is answered as it always was. */
  api.as("stranger");
  expect((await api.sync("no-such-project")).status).toBe(200);
});

test("a production holding boards: one person's is theirs (or an admin's); two people's, or none, is an admin's alone", async () => {
  const ws = workspace("work-production-boards");
  const api = await setup(ws);
  await seed(ws, api.mappedId);
  const { NOT_YOURS } = await import("../../lib/workAccess");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const name = async (id: string) => String((await read(ws, "SELECT name FROM productions WHERE id=?", [id]))[0]?.name);

  /* prod-board holds the maker's one board (and nothing of anyone else's): the maker or an admin. */
  api.as("maker");
  expect((await api.productionPatch("prod-board", { name: "By its only maker" })).status).toBe(200);
  api.as("teammate");
  expect(await refusal(await api.productionPatch("prod-board", { name: "no" }))).toEqual({ status: 403, error: NOT_YOURS.production });
  api.as("admin");
  expect((await api.productionPatch("prod-board", { status: "delivered" })).status).toBe(200);

  /* A project with no recorded maker beside it does not count as anyone's board: still the one maker's. */
  await runInTenant(ws, () => db().execute("INSERT INTO projects(id,name,created_at,production_id) VALUES('no-maker-here','No maker',0,'prod-board')"));
  api.as("maker");
  expect((await api.productionPatch("prod-board", { client: "Still theirs" })).status).toBe(200);

  /* Two people's boards: the teammate makes a board of their own in it (a draft whose id works out to the project's id). Now only an admin. */
  const second = api.mappedId("prj_wb_", ws.id, PEOPLE.teammate.id, "draft-t2");
  await runInTenant(ws, async () => {
    await db().batch([
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${PEOPLE.teammate.id}:draft-t2`, PEOPLE.teammate.id, "draft-t2", "Teammate board", JSON.stringify({ id: "draft-t2", name: "Teammate board", productionProjectId: second })] },
      { sql: "INSERT INTO projects(id,name,created_at,production_id) VALUES(?,?,0,'prod-board')", args: [second, "Teammate board"] },
    ], "write");
  });
  for (const who of ["maker", "teammate", "stranger", "strangerToken"]) {
    api.as(who);
    expect(await refusal(await api.productionPatch("prod-board", { name: `By ${who}` })), who).toEqual({ status: 403, error: NOT_YOURS.production });
  }
  expect(await name("prod-board")).toBe("By its only maker");
  for (const who of ["admin", "owner", "adminToken"]) {
    api.as(who);
    expect((await api.productionPatch("prod-board", { name: `By ${who}`, status: "active" })).status, who).toBe(200);
  }

  /* No board at all (a production with only a project that has no maker, or with no project): an admin's alone. */
  api.as("maker");
  expect((await api.productionPatch("prod-plain", { name: "no" })).status).toBe(403);
  await runInTenant(ws, () => db().execute("INSERT INTO productions(id,name,created_at) VALUES('prod-empty','Empty',0)"));
  expect((await api.productionPatch("prod-empty", { name: "no" })).status).toBe(403);
  api.as("admin");
  expect((await api.productionPatch("prod-empty", { name: "By an admin" })).status).toBe(200);
});
