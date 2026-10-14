import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The default sharing of a new board (board sharing, PR 9): stamped by the server at the board's first save, from the workspace's plan. Business: "shared · can
 * edit". Every other plan, the legacy Studio, Agency and Production included, and no plan: private. A client cannot choose it, a later save keeps what is stored,
 * a later change of plan changes no board, and what the server itself makes (a starter, a copy of the sample) stays private.
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

const workspace = (id: string, planId?: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true, ...(planId ? { planId } : {}) }) as unknown as TenantWorkspace;
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

async function fixture(name: string, options: { sample?: boolean; plan?: string } = {}) {
  const ws = workspace(`ba-${name}-${run}`, options.plan);
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



const stateOf = (b: Record<string, unknown>) => (b.teamShared ? (b.teamEdit ? "edit" : "view") : "none");

async function newBoard(f: Awaited<ReturnType<typeof fixture>>, id: string, extra: Record<string, unknown> = {}) {
  const { newProject } = await import("../../lib/workbench/studio");
  const res = await f.as(who("u_owner"), () => f.put({ ...newProject(id), id, name: id, ...extra }, 0));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  const row = (await f.as(who("u_owner"), async () => (await f.database.db().execute({ sql: "SELECT body FROM workbench_projects WHERE key=?", args: [`u_owner:${id}`] })).rows[0]));
  return stateOf(JSON.parse(String(row.body)));
}

test("a Business workspace's new board starts shared, can edit; the plan decides, not the client", async () => {
  const f = await fixture("business", { plan: "business250" });
  expect(await newBoard(f, "b-new")).toBe("edit");
  // The client cannot choose: a board that says private, or says nothing, starts as the plan says; one that says "edit" in a private workspace does not (below).
  expect(await newBoard(f, "b-says-private", { teamShared: false, teamEdit: false })).toBe("edit");
  // Only the first save stamps: a later save keeps what is stored, whatever it says.
  const { newProject } = await import("../../lib/workbench/studio");
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "b-new", mode: "none" }));
  const later = await f.as(who("u_owner"), () => f.put({ ...newProject("b-new"), id: "b-new", name: "later", teamShared: true, teamEdit: true }, 1));
  expect(later.status).toBe(200);
  const row = await f.as(who("u_owner"), async () => (await f.database.db().execute({ sql: "SELECT body FROM workbench_projects WHERE key='u_owner:b-new'", args: [] })).rows[0]);
  expect(stateOf(JSON.parse(String(row.body)))).toBe("none");
  // A teammate may edit the new board straight away: the explicit grant and the maker's active membership are the ordinary ones.
  const { mayReachProject } = await import("../../lib/draftProject");
  const { mappedId } = await import("../../lib/workbench/records");
  const board = mappedId("prj_wb_", f.ws.id, "u_owner", "b-says-private");
  expect(await f.as(who("u_mate"), () => mayReachProject({ id: "u_mate" }, board, "write"))).toBe(true);
});

test("every other plan starts private: the individual plans, the legacy Studio, Agency, Production and Invite, and no plan", async () => {
  // The rule itself, for every plan the platform knows.
  const { runInTenant } = await import("../../lib/tenant");
  const { DEFAULT_PLANS } = await import("../../lib/plans");
  const { defaultSharing } = await import("../../lib/workbench/board-default");
  const seen: Record<string, boolean> = {};
  for (const plan of DEFAULT_PLANS) {
    seen[plan.id] = await runInTenant(workspace(`ba-rule-${plan.id}-${run}`, plan.id), async () => (await defaultSharing()).teamShared, asUser(who("u_owner")));
  }
  expect(Object.keys(seen).filter((id) => seen[id]).sort()).toEqual(DEFAULT_PLANS.filter((p) => p.group === "business").map((p) => p.id).sort());
  expect(seen).toMatchObject({ invite: false, studio: false, agency: false, production: false, explore: false, create: false, master: false, business100: true, business250: true, business500: true });
  expect(await runInTenant(workspace(`ba-rule-none-${run}`), async () => (await defaultSharing()).teamShared, asUser(who("u_owner")))).toBe(false);
  // And through a first save, whatever the client says.
  for (const plan of ["explore", "create", "master", "studio", "agency", "production", undefined]) {
    const f = await fixture(`plan-${plan ?? "none"}`, { plan });
    expect(await newBoard(f, "p-new", { teamShared: true, teamEdit: true }), `plan ${plan}`).toBe("none");
  }
});

test("a later change of plan changes no board, and a new board takes the new plan's default", async () => {
  const f = await fixture("switch", { plan: "business100" });
  expect(await newBoard(f, "first")).toBe("edit");
  const { runInTenant } = await import("../../lib/tenant");
  const privateWs = { ...f.ws, planId: "studio" } as unknown as TenantWorkspace;
  await runInTenant(privateWs, async () => {
    const { newProject } = await import("../../lib/workbench/studio");
    const { workbenchReady } = await import("../../lib/workbench/records");
    await workbenchReady();
    const route = loadRoute<Route>("app/api/workbench/projects/route.ts", () => who("u_owner"));
    const res = await route.PUT(new Request("https://particl.test/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: { ...newProject("second"), id: "second" }, revision: 0 }) }), undefined as never);
    expect(res.status).toBe(200);
    const rows = (await f.database.db().execute("SELECT project_id, body FROM workbench_projects ORDER BY project_id")).rows;
    expect(Object.fromEntries(rows.map((r) => [String(r.project_id), stateOf(JSON.parse(String(r.body)))]))).toMatchObject({ first: "edit", second: "none" });
  }, asUser(who("u_owner")));
});

test("what the server makes itself stays private, even in a Business workspace: a starter and a copy of the sample", async () => {
  const f = await fixture("server-made", { plan: "business500" });
  const { newProject } = await import("../../lib/workbench/studio");
  // Written by the library the way the starter and the sample's copies are (no first-save default is asked of it).
  await f.as(who("u_owner"), () => f.records.saveDraft("u_owner", { ...newProject("starter"), id: "starter" } as never, 0));
  await f.as(who("u_owner"), () => f.records.saveDraft("u_owner", { ...newProject("sample-copy"), id: "sample-copy", teamShared: true, teamEdit: true } as never, 0));
  const rows = (await f.as(who("u_owner"), async () => (await f.database.db().execute("SELECT project_id, body FROM workbench_projects WHERE project_id IN ('starter','sample-copy')")).rows));
  expect(rows.map((r) => stateOf(JSON.parse(String(r.body))))).toEqual(["none", "none"]);
});

test("only a genuinely new board is stamped: a draft opened from a workspace production or a take link, and a personal copy, stay private", async () => {
  const f = await fixture("genuine", { plan: "business100" });
  const { mappedId } = await import("../../lib/workbench/records");
  const { runInTenant } = await import("../../lib/tenant");
  await f.as(who("u_owner"), async () => {
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_ordinary','Ordinary',0)", args: [] });
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prj_ordinary','Ordinary project',0,'prod_ordinary')", args: [] });
  });
  // Linked to a workspace production (opened from it, or from a take link): private, whatever the plan.
  expect(await newBoard(f, "opened", { productionProjectId: "prj_ordinary" })).toBe("none");
  // A personal copy: linked to the original board's own production (not to a production of its own).
  const original = mappedId("prj_wb_", f.ws.id, "u_owner", "d1");
  expect(await newBoard(f, "copy", { productionProjectId: original })).toBe("none");
  // A board with no production yet is new, and stamped.
  expect(await newBoard(f, "fresh")).toBe("edit");
  void runInTenant;
});
