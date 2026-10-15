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
    await expect(requireProduction(privateProject, undefined, "read")).rejects.toThrow(/not in this workspace/);
    await database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] });
    await expect(requireProduction(privateProject, undefined, "read")).resolves.toBeUndefined();
  }, person("u_mate"));
});

test("the marked sample production is everyone's to read; only its owner and the platform owner write it, everyone else is refused (owner, 13 Oct); an undone mark is not", async () => {
  const ws = workspace(`pc-f-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  const { requireProduction } = await import("../../lib/workbench/team-canvas");
  const { projectLister } = await import("../../lib/draftProject");
  const mark = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, projectId: privateProject, name: "Sample", draftOwner: "u_owner", draftId: "d1", markedBy: "u_owner", markedAt: 1, ...extra });
  await tenant.runInTenant(ws, async () => {
    await database.db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_owner',1)", args: [mark()] });
    await expect(requireProduction(privateProject, undefined, "read"), "read").resolves.toBeUndefined();
    await expect(requireProduction(privateProject, undefined, "write"), "another viewer's write").rejects.toThrow(/not in this workspace/);
    /* The sample's owner (the person it was marked from) writes it as their own board (the platform owner does too: tests/unit/sampleReadOnly.spec.ts). */
    await expect(requireProduction(privateProject, "u_owner", "write"), "its owner's write").resolves.toBeUndefined();
    expect((await projectLister({ id: "u_mate" }))(privateProject)).toBe(true);
    await database.db().execute({ sql: "UPDATE settings SET value=? WHERE key='sampleProduction'", args: [mark({ hiddenAt: 5 })] });
    await expect(requireProduction(privateProject, undefined, "read")).rejects.toThrow(/not in this workspace/);
    expect((await projectLister({ id: "u_mate" }))(privateProject)).toBe(false);
  }, person("u_mate"));
});

test("a shared board (teamShared, set the way the author sets it) is a teammate's to read only: the canvas route reads, every write stays the owner's; unshared, or never shared, it is not found", async () => {
  const ws = workspace(`pc-g-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  const { requireProduction } = await import("../../lib/workbench/team-canvas");
  let who = { id: "u_mate", role: "member" };
  const route = loadRoute<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts", () => who);
  const studio = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => who);
  const read = () => route.GET(new Request(`https://particl.test/api/workbench/team-canvas?productionId=${privateProject}`), undefined as never);
  const write = () => route.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId: privateProject, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }) }), undefined as never);
  const share = (shared: boolean) => studio.POST(new Request("https://particl.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "team-share", projectId: "d1", shared }) }), undefined as never);
  /* Never shared: not found, for the read and for the write. */
  await tenant.runInTenant(ws, async () => {
    expect((await read()).status).toBe(404);
    expect((await write()).status).toBe(404);
  }, person("u_mate"));
  /* The author shares it. */
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_owner", role: "member" };
    const shared = await share(true);
    expect(shared.status, JSON.stringify(await shared.clone().json())).toBe(200);
  }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    await expect(requireProduction(privateProject, undefined, "read")).resolves.toBeUndefined();
    await expect(requireProduction(privateProject, undefined, "write")).rejects.toThrow(/not in this workspace/);
    const got = await read();
    expect(got.status).toBe(200);
    expect((await got.json()).canvas.nodes.n1.title).toBe("Secret");
    expect((await write()).status, "a write is the owner's").toBe(404);
  }, person("u_mate"));
  /* The author stops sharing: not found again. */
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_owner", role: "member" };
    expect((await share(false)).status).toBe(200);
  }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    expect((await read()).status).toBe(404);
  }, person("u_mate"));
  void database;
});

test("the project's own page, its deletion and edit, opening it, linking a draft to it, its budget and its runs are the owner's alone", async () => {
  const ws = workspace(`pc-h-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  let who = { id: "u_mate", role: "member" };
  const one = loadRoute<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts", () => who);
  const studio = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => who);
  const budget = loadRoute<typeof import("../../app/api/workbench/budget/route")>("app/api/workbench/budget/route.ts", () => who);
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = (method: string, body: unknown) => new Request("https://particl.test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const { saveDraft } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  process.env.RIG_AGENT_ENABLED = "1";
  await tenant.runInTenant(ws, async () => {
    await rigAgentReady();
    await database.db().execute({ sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,lease_until,created_at,updated_at)
      VALUES(?,?,'d1','u_owner','req_pc','A secret goal about the board','ask',100,200,'auto','needs_you',0,1,1)`, args: [`rar_${"7".repeat(24)}`, privateProject] });
    await database.db().execute({ sql: `INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,prepared,state,quote_credits,band,admission,created_at,updated_at)
      VALUES(?,?,1,'render','Render the opening','take','[]','waiting',30,1,?,1,1)`, args: [`rar_${"7".repeat(24)}:1`, `rar_${"7".repeat(24)}`, JSON.stringify({ quote: { fingerprint: "a".repeat(64) } })] });
  }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    /* Its page, edit and deletion: as absent as an unknown id. */
    const unknown = await one.GET(new Request("https://particl.test/x"), ctx("prj_wb_doesnotexist0000000000"));
    expect(unknown.status).toBe(404);
    expect((await one.GET(new Request("https://particl.test/x"), ctx(privateProject))).status).toBe(404);
    expect((await one.PATCH(json("PATCH", { name: "Hijacked" }), ctx(privateProject))).status).toBe(404);
    expect((await one.DELETE(new Request("https://particl.test/x", { method: "DELETE" }), ctx(privateProject))).status).toBe(404);
    expect((await database.db().execute({ sql: "SELECT name FROM projects WHERE id=?", args: [privateProject] })).rows[0].name).toBe("Private board");
    /* Opening it (its name, description and shared context) answers as an unknown project. */
    const open = await studio.POST(json("POST", { action: "open", projectId: privateProject }), undefined as never);
    expect(open.status).toBe(404);
    /* A draft of the teammate's own cannot link to it (and so cannot save to its canvas). */
    const mine = { ...newProject("mine"), id: "mine", productionProjectId: privateProject };
    await expect(saveDraft("u_mate", mine, 0)).rejects.toThrow(/no longer exists in this workspace/);
    /* Its budget answers as an unknown production does. */
    const bUnknown = await budget.GET(new Request("https://particl.test/api/workbench/budget?productionId=prj_wb_doesnotexist0000000000"), undefined as never);
    const bPrivate = await budget.GET(new Request(`https://particl.test/api/workbench/budget?productionId=${privateProject}`), undefined as never);
    expect([bPrivate.status, await bPrivate.json()]).toEqual([bUnknown.status, await bUnknown.json()]);
    /* The approvals queue lists no run on it. */
    const queue = JSON.stringify(await readApprovals({ id: "u_mate", role: "member" }));
    expect(queue).not.toContain("secret goal");
  }, person("u_mate"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_owner", role: "member" };
    expect((await one.PATCH(json("PATCH", { name: "Renamed" }), ctx(privateProject))).status).toBe(200);
    expect((await budget.GET(new Request(`https://particl.test/api/workbench/budget?productionId=${privateProject}`), undefined as never)).status).not.toBe(404);
    expect((await studio.POST(json("POST", { action: "open", projectId: privateProject }), undefined as never)).status).toBe(200);
    expect(JSON.stringify(await readApprovals({ id: "u_owner", role: "member" }))).toContain("secret goal");
  }, person("u_owner"));
});

test("analytics, the credit-usage boards, the ideas list: a private board's spend stays in the totals, its name, id and shots do not show to anyone else", async () => {
  const ws = workspace(`pc-i-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  let who = { id: "u_mate", role: "member" };
  const analytics = loadRoute<typeof import("../../app/api/analytics/route")>("app/api/analytics/route.ts", () => who);
  const { creditsByBoard } = await import("../../lib/creditUsage");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    await db.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind,cost_usd) VALUES(?,?,?,?,?,'succeeded',?,?, 'image', 1)", args: [`gen_an_${run}`, privateProject, "m", "p", "{}", Date.now(), Date.now()] });
    await platformDb().execute({ sql: `INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,'u_owner',?,?)`,
      args: [`ev_an_${run}`, ws.id, privateProject, "image", "fal", "m", "succeeded", 1, 12, Date.now(), Date.now()] });
  }, person("u_owner"));
  const ask = async (user: string, query = "") => { who = { id: user, role: "member" }; return tenant.runInTenant(ws, async () => (await analytics.GET(new Request(`https://particl.test/api/analytics${query}`), undefined as never)).json(), person(user)); };
  const mate = await ask("u_mate");
  expect(JSON.stringify(mate.byProject)).not.toContain(privateProject);
  expect(JSON.stringify(mate.byProject)).not.toContain("Private board");
  expect(mate.byProject.some((p: { name: string }) => p.name === "A private board")).toBe(true);
  expect(mate.totals.generations, "its spend stays in the totals").toBeGreaterThan(0);
  const confirm = await ask("u_mate", `?projectId=${privateProject}`);
  const unknown = await ask("u_mate", "?projectId=prj_wb_doesnotexist0000000000");
  expect(confirm.totals).toEqual(unknown.totals);
  expect(confirm.byProject).toEqual(unknown.byProject);
  const owner = await ask("u_owner");
  expect(owner.byProject.map((p: { id: string | null }) => p.id)).toContain(privateProject);
  const boardsUsed = async (user: string) => tenant.runInTenant(ws, () => creditsByBoard({ from: 0, to: Date.now() + 1000 }), person(user));
  const forMate = await boardsUsed("u_mate");
  expect(JSON.stringify(forMate)).not.toContain(privateProject);
  expect(forMate.some((b) => b.name === "A private board" && b.credits === 12)).toBe(true);
  expect((await boardsUsed("u_owner")).some((b) => b.id === privateProject)).toBe(true);
});

test("Activity, the decided list and the project names of the control room: a private board's runs, titles, spend and decisions are its owner's alone", async () => {
  const ws = workspace(`pc-j-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  process.env.RIG_AGENT_ENABLED = "1";
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { readActivity } = await import("../../lib/control-room/activity.server");
  const { readApprovals, projectsOf } = await import("../../lib/control-room/approvals.server");
  const runId = `rar_${"8".repeat(24)}`;
  await tenant.runInTenant(ws, async () => {
    await rigAgentReady();
    const now = Date.now();
    await database.db().execute({ sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,lease_until,created_at,updated_at,approved_by,approved_at)
      VALUES(?,?,'d1','u_owner','req_pc2','A hidden goal for the private board','ask',100,200,'auto','needs_you',0,?,?,'u_owner',?)`, args: [runId, privateProject, now - 5000, now - 5000, now - 4000] });
    await database.db().execute({ sql: `INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,prepared,state,quote_credits,band,admission,created_at,updated_at)
      VALUES(?,?,1,'render','Render the hidden opening','take','[]','waiting',30,1,?,1,1)`, args: [`${runId}:1`, runId, JSON.stringify({ quote: { fingerprint: "b".repeat(64) } })] });
  }, person("u_owner"));
  const mate = { id: "u_mate", role: "member" }, owner = { id: "u_owner", role: "member" };
  await tenant.runInTenant(ws, async () => {
    const all = JSON.stringify(await readActivity(mate, null));
    expect(all).not.toContain("hidden goal");
    expect(all).not.toContain("hidden opening");
    expect(all).not.toContain(privateProject);
    expect(all).not.toContain("Private board");
    /* Asking for it by id answers as an unknown id does. */
    const asked = await readActivity(mate, privateProject);
    const unknown = await readActivity(mate, "prj_wb_doesnotexist0000000000");
    expect({ ...asked, productionId: null }).toEqual({ ...unknown, productionId: null });
    /* The decided list and the queue's project names. */
    const approvals = JSON.stringify(await readApprovals(mate));
    expect(approvals).not.toContain("hidden goal");
    expect(approvals).not.toContain(privateProject);
    expect((await projectsOf("u_mate", [privateProject])).get(privateProject)).toEqual({ productionId: null, draftId: null, name: null });
  }, person("u_mate"));
  await tenant.runInTenant(ws, async () => {
    expect(JSON.stringify(await readActivity(owner, null))).toContain("hidden goal");
    expect(JSON.stringify(await readActivity(owner, privateProject))).toContain("hidden opening");
    expect(JSON.stringify((await readApprovals(owner)).decided)).toContain("hidden goal");
    expect((await projectsOf("u_owner", [privateProject])).get(privateProject)?.name).toBe("Private board");
  }, person("u_owner"));
});

test("opening a teammate's shared board from the production gives a view-only open, with no draft of their own and no misleading save error; the id-only read lists no private board", async () => {
  const ws = workspace(`pc-k-${run}`);
  const { tenant, database, privateProject } = await boards(ws);
  let who = { id: "u_owner", role: "member" };
  const studio = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => who);
  const post = (body: unknown) => studio.POST(new Request("https://particl.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never);
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  /* The maker is an active member of this workspace (a board link only reads boards of active members). */
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts (id, email, name, password_hash, created_at) VALUES ('u_owner', ?, 'Owner Person', 'x', 0)", args: [`owner-${run}@example.test`] });
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'member',0,0)", args: [ws.id, "u_owner"] });
  await tenant.runInTenant(ws, async () => {
    await database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prj_wb_other0000000000000000','Someone else',0)", args: [] });
    expect((await post({ action: "team-share", projectId: "d1", shared: true })).status).toBe(200);
  }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    const opened = await post({ action: "open", projectId: privateProject });
    expect(opened.status).toBe(200);
    const body = await opened.json();
    expect(body.viewOnly).toBeTruthy();
    expect(body.project.productionProjectId).toBe(privateProject);
    expect((await database.db().execute({ sql: "SELECT COUNT(*) AS n FROM workbench_projects WHERE owner='u_mate'", args: [] })).rows[0].n, "no draft was made for the teammate").toBe(0);
    /* The board link (id alone) lists no private board's production. */
    const link = await studio.GET(new Request("https://particl.test/api/workbench/projects?id=d1"), undefined as never);
    const seen = await link.json();
    expect(seen.viewOnly).toBeTruthy();
    expect(JSON.stringify(seen.productions)).not.toContain("prj_wb_other0000000000000000");
  }, person("u_mate"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_owner", role: "member" };
    const mine = await post({ action: "open", projectId: privateProject });
    expect((await mine.json()).viewOnly, "the owner's own open is not view-only").toBeUndefined();
  }, person("u_owner"));
});

test("a link's reach question: an ordinary production opens, a private board of someone else's does not, a shared one opens on the author's own draft, and a private board's name is never in the answer", async () => {
  const ws = workspace(`pc-l-${run}`);
  const { tenant, privateProject } = await boards(ws);
  let who = { id: "u_owner", role: "member" };
  const studio = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => who);
  const reach = async (id: string) => (await studio.GET(new Request(`https://particl.test/api/workbench/projects?reach=${id}`), undefined as never)).json();
  const post = (body: unknown) => studio.POST(new Request("https://particl.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never);
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    expect((await reach("prod_shared")).reach).toEqual({ reachable: true, shared: null });
    const hidden = await reach(privateProject);
    expect(hidden.reach).toEqual({ reachable: false, shared: null });
    expect(JSON.stringify(hidden)).not.toContain("Private board");
    expect((await reach("prj_wb_doesnotexist0000000000")).reach, "the same as an unknown production").toEqual(hidden.reach);
  }, person("u_mate"));
  await tenant.runInTenant(ws, async () => { who = { id: "u_owner", role: "member" }; expect((await reach(privateProject)).reach.reachable).toBe(true); }, person("u_owner"));
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts (id, email, name, password_hash, created_at) VALUES ('u_owner', ?, 'Owner Person', 'x', 0)", args: [`owner-l-${run}@example.test`] });
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'member',0,0)", args: [ws.id, "u_owner"] });
  await tenant.runInTenant(ws, async () => { who = { id: "u_owner", role: "member" }; expect((await post({ action: "team-share", projectId: "d1", shared: true })).status).toBe(200); }, person("u_owner"));
  await tenant.runInTenant(ws, async () => {
    who = { id: "u_mate", role: "member" };
    const shared = (await reach(privateProject)).reach;
    expect(shared.reachable).toBe(true);
    expect(shared.shared.id).toBe("d1");
  }, person("u_mate"));
});
