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
  await runInTenant(ws, async () => {
    await ready();
    const { workbenchReady } = await import("../../lib/workbench/records");
    await workbenchReady();
    await db().batch([
      /* The maker's board: a draft of theirs, whose own project (an id made from the workspace, the owner and the draft) it is. */
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${PEOPLE.maker.id}:${ids.draft}`, PEOPLE.maker.id, ids.draft, "Board", JSON.stringify({ id: ids.draft, name: "Board", productionProjectId: board })] },
      { sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0),('plain','Plain',0),('spare','Spare',0)", args: [board, "Board"] },
      { sql: "INSERT INTO shots(id,project_id,code,title,status,position,created_by,created_at,updated_at) VALUES('s-maker',?,'010','Own','open',0,?,0,0),('s-mate',?,'020','Mate','open',1,?,0,0),('s-plain','plain','030','Plain','open',0,?,0,0)", args: [board, PEOPLE.maker.id, board, PEOPLE.teammate.id, PEOPLE.teammate.id] },
      { sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url) VALUES
        ('t-maker','m','p','{}','succeeded',1,1,'image','Maker take',0,?,?,'/api/media/t-maker'),('t-mate','m','p','{}','succeeded',1,1,'image','Mate take',0,?,?,'/api/media/t-mate'),
        ('t-plain','m','p','{}','succeeded',1,1,'image','Plain take',0,?,'plain','/api/media/t-plain'),('t-unknown','m','p','{}','succeeded',1,1,'image','Unknown take',0,'',?,'/api/media/t-unknown')`,
        args: [PEOPLE.maker.id, board, PEOPLE.teammate.id, board, PEOPLE.teammate.id, board] },
    ], "write");
  });
  return board;
}
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
  expect((await api.shotPatch("s-mate", { projectId: "spare" })).status).toBe(200);
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
