import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A private board's team canvas and listing are its owner's alone (lib/draftProject.ts, lib/workbench/team-canvas.ts › requireProduction). A draft's own
 * production project (`prj_wb_…`) is a hash of the workspace, the owner and the draft; whoever is not the owner is answered exactly as for a production
 * that does not exist. Background work and Atomik runs (no person) still work. Real temporary databases; sign-in is a fake.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-private-canvas-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false }) as TenantWorkspace;
const person = (id: string) => ({ user: { id, email: "", name: id, role: "member" as const, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });

function loadRoute<T>(file: string, viewer: () => { id: string; role: string }): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer() }), requireSession: async () => ({ user: viewer() }), requireRender: async () => ({ user: viewer() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
    "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => null },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

async function boards(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
  let privateProject = "";
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady(); await teamCanvasReady();
    const db = database.db();
    privateProject = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
    await db.execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_group','Group',0)", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_private','Private board',0)", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES(?,?,0,'prod_private')", args: [privateProject, "Private board"] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prod_shared','Shared production',0,'prod_group')", args: [] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: privateProject })] });
    await db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,1,'u_owner',1)", args: [privateProject, JSON.stringify({ nodes: { n1: { id: "n1", title: "Secret" } } })] });
  });
  return { tenant, database, draft, privateProject };
}

test("a teammate cannot reach a private board's canvas, and is answered as for a production that does not exist; the owner, background work and Atomik runs can", async () => {
  const ws = workspace(`pc-a-${run}`);
  const { tenant, privateProject } = await boards(ws);
  const { requireProduction, TeamCanvasError } = await import("../../lib/workbench/team-canvas");
  const message = async (productionId: string, user: ReturnType<typeof person> | null, actor?: string | null) =>
    tenant.runInTenant(ws, async () => requireProduction(productionId, actor).then(() => "ok", (e: Error) => `${e instanceof TeamCanvasError ? (e as { status: number }).status : "?"} ${e.message}`), user ?? undefined);
  const unknown = await message("prj_wb_doesnotexist0000000000", person("u_mate"));
  expect(unknown).toMatch(/^404 /);
  expect(await message(privateProject, person("u_mate")), "a teammate").toBe(unknown);
  expect(await message(privateProject, person("u_mate"), "u_mate"), "named explicitly").toBe(unknown);
  expect(await message(privateProject, person("u_owner")), "the owner").toBe("ok");
  expect(await message(privateProject, null), "background work (nobody signed in)").toBe("ok");
  expect(await message(privateProject, person("agent:run_1")), "an Atomik run").toBe("ok");
  expect(await message(privateProject, person("u_mate"), "agent:run_1"), "an Atomik run named as the actor").toBe("ok");
  expect(await message("prod_shared", person("u_mate")), "an ordinary production is the workspace's").toBe("ok");
  /* An admin is not the owner either. */
  expect(await tenant.runInTenant(ws, () => requireProduction(privateProject).then(() => "ok", () => "refused"), { user: { ...person("u_admin").user, role: "admin" } })).toBe("refused");
});

test("the routes that serve the canvas: a teammate reads and writes nothing; the owner still does; the Rig's state and ops follow", async () => {
  const ws = workspace(`pc-b-${run}`);
  const { tenant, privateProject } = await boards(ws);
  let who = { id: "u_mate", role: "member" };
  const route = loadRoute<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts", () => who);
  const get = (query: string) => route.GET(new Request(`https://particl.test/api/workbench/team-canvas?${query}`), undefined as never);
  const patch = (body: unknown) => route.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never);
  const { rigAgentState } = await import("../../lib/workbench/rig-agent");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { importBoardBatch } = await import("../../lib/workbench/board-import");
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    const unknownRead = await get("productionId=prj_wb_doesnotexist0000000000");
    for (const query of [`productionId=${privateProject}`, `productionId=${privateProject}&head=1`, `productionId=${privateProject}&history=1`, `productionId=${privateProject}&agent=1`]) {
      const res = await get(query);
      expect(res.status, query).toBe(unknownRead.status);
      expect(await res.json(), query).toEqual(await unknownRead.clone().json());
    }
    expect((await patch({ productionId: privateProject, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null })).status).toBe(404);
    expect((await patch({ productionId: "prj_wb_doesnotexist0000000000", upsertNodes: [], removeNodes: [], upsertAssets: [], order: null })).status).toBe(404);
    await expect(rigAgentState(privateProject, "u_mate")).rejects.toThrow(/not in this workspace/);
    await expect(applyCanvasOps(privateProject, { opId: "op_1234567890", author: "u_mate", ops: [{ kind: "remove", nodeIds: ["n1"] }] } as never)).rejects.toThrow(/not in this workspace/);
    await expect(importBoardBatch(privateProject, "brd_x", "u_mate")).rejects.toThrow(/not in this workspace/);
  }, person("u_mate"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_owner", role: "member" };
    const mine = await get(`productionId=${privateProject}`);
    expect(mine.status).toBe(200);
    expect((await mine.json()).canvas.nodes.n1.title).toBe("Secret");
    expect((await get(`productionId=${privateProject}&head=1`)).status).toBe(200);
    expect(await rigAgentState(privateProject, "u_owner")).toMatchObject({ run: null });
    /* Atomik's run on the owner's board, in the run's own identity. */
    expect(await rigAgentState(privateProject, "agent:run_1")).toMatchObject({ run: null });
  }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    expect(await rigAgentState(privateProject, "u_owner")).toMatchObject({ run: null });
  }, person("agent:run_1"));
});

test("project lists show a private board to its owner only: /api/projects, the productions board, the Studio's list, a project's own page", async () => {
  const ws = workspace(`pc-c-${run}`);
  const { tenant, privateProject } = await boards(ws);
  let who = { id: "u_mate", role: "member" };
  const projects = loadRoute<typeof import("../../app/api/projects/route")>("app/api/projects/route.ts", () => who);
  const one = loadRoute<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts", () => who);
  const studio = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => who);
  const { listProductions } = await import("../../lib/productions");
  const ids = async (res: Response, key = "projects") => ((await res.json())[key] as { id: string }[]).map((p) => p.id);
  const listed = async (user: string) => {
    who = { id: user, role: "member" };
    return tenant.runInTenant(ws, async () => ({
      projects: await ids(await projects.GET(new Request("https://particl.test/api/projects"), undefined as never)),
      productions: (await listProductions()).flatMap((p) => p.projects.map((q) => q.id)),
      productionRows: (await listProductions()).map((p) => p.id),
      studio: await ids(await studio.GET(new Request("https://particl.test/api/workbench/projects"), undefined as never), "productions"),
      page: (await one.GET(new Request("https://particl.test/x"), { params: Promise.resolve({ id: privateProject }) })).status,
    }), person(user));
  };
  const owner = await listed("u_owner");
  expect(owner.projects).toContain(privateProject);
  expect(owner.productions).toContain(privateProject);
  expect(owner.studio).toContain(privateProject);
  expect(owner.page).toBe(200);
  const mate = await listed("u_mate");
  expect(mate.projects).not.toContain(privateProject);
  expect(mate.projects).toContain("prod_shared");
  expect(mate.productions).not.toContain(privateProject);
  expect(mate.studio).not.toContain(privateProject);
  /* The board's own production (named for the board) is not listed to a teammate either, while the owner and an ordinary production's group still are. */
  expect(mate.productionRows).not.toContain("prod_private");
  expect(mate.productionRows).toContain("prod_group");
  expect(owner.productionRows).toContain("prod_private");
  expect(mate.page).toBe(404);
  /* The memo is shared by every viewer: the owner after the teammate still sees it. */
  expect((await listed("u_owner")).projects).toContain(privateProject);
});

test("another workspace gets nothing; a board the author has shared (teamShared) opens to teammates, the one place that clause lives", async () => {
  const ws = workspace(`pc-d-${run}`), other = workspace(`pc-e-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  const { requireProduction } = await import("../../lib/workbench/team-canvas");
  await tenant.runInTenant(other, async () => {
    await database.ready();
    await expect(requireProduction(privateProject)).rejects.toThrow(/not in this workspace/);
  }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    await expect(requireProduction(privateProject)).rejects.toThrow(/not in this workspace/);
    await database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] });
    await expect(requireProduction(privateProject)).resolves.toBeUndefined();
  }, person("u_mate"));
});
