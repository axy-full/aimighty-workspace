import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Shots and renders and a private board (lib/draftProject.ts › mayReachProject): the list of every shot leaves out a private board's, a shot is written
 * only into a project its writer may write, and a render or a quote is filed only into one too. Owner-only for a private board; a teammate (an admin
 * included: the rule asks who owns it, never the role) only once it is shared, and then to look at. Whoever may not is answered exactly as for an
 * unknown project. Real temporary databases; sign-in is a fake; the render is mocked and nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-private-shots-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
const as = (id: string, role: "admin" | "member" = "member", token = false) => ({ user: user(id, role), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null } } : {}) });

function loadRoute<T>(file: string, who: () => { user: ReturnType<typeof user>; token?: unknown }): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ ...who() }), requireRender: async () => ({ ...who() }), requireSession: async () => ({ ...who() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const privateProject = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [privateProject, "Private board"] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_open','Ordinary production',0)", args: [] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: privateProject })] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,setup,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", args: [`shot_priv_${run}`, privateProject, "SH010", "Secret title", "Secret node text", "{}"] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,setup,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", args: [`shot_open_${run}`, "prod_open", "SH010", "Open title", "", "{}"] });
  });
  return { tenant, database, privateProject };
}

const shotIds = (body: { shots: { id: string }[] }) => body.shots.map((s) => s.id);

test("GET /api/shots: the list of every shot, and of one board, leaves out a private board's; shared, it is to look at", async () => {
  const ws = workspace(`ps-a-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  let who = as("u_owner");
  const route = loadRoute<typeof import("../../app/api/shots/route")>("app/api/shots/route.ts", () => who);
  const list = async (query = "") => (await route.GET(new Request(`https://particl.test/api/shots${query}`), undefined as never)).json();
  const seen = async (actor: ReturnType<typeof as>, query = "") => { who = actor; return tenant.runInTenant(ws, () => list(query), { user: actor.user, token: actor.token as never }); };
  const all = (b: { shots: { id: string }[] }) => JSON.stringify(shotIds(b));
  /* The owner sees their own, and the ordinary production's. */
  const owner = await seen(as("u_owner"));
  expect(all(owner)).toContain(`shot_priv_${run}`);
  expect(all(owner)).toContain(`shot_open_${run}`);
  expect(JSON.stringify(await seen(as("u_owner"), `?projectId=${privateProject}`))).toContain("Secret title");
  /* A teammate, an admin, a teammate's token: the ordinary production only; nothing of the private board, not its title, its text or its id. */
  for (const actor of [as("u_mate"), as("u_admin", "admin"), as("u_mate", "member", true)]) {
    const all_ = await seen(actor);
    expect(all(all_), actor.user.id).toContain(`shot_open_${run}`);
    expect(JSON.stringify(all_), actor.user.id).not.toMatch(/Secret|prj_wb_/);
    /* A list of the private board itself is exactly as empty as an unknown project's. */
    expect(await seen(actor, `?projectId=${privateProject}`), actor.user.id).toEqual(await seen(actor, "?projectId=prj_wb_doesnotexist0000000000"));
  }
  /* Shared by its author: a teammate looks at it. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  expect(JSON.stringify(await seen(as("u_mate"), `?projectId=${privateProject}`))).toContain("Secret title");
  expect(all(await seen(as("u_admin", "admin")))).toContain(`shot_priv_${run}`);
  /* Another workspace sees none of it. */
  const other = workspace(`ps-a2-${run}`);
  await tenant.runInTenant(other, async () => { await database.ready(); }, { user: user("u_owner") });
  who = as("u_owner");
  expect(JSON.stringify(await tenant.runInTenant(other, () => list(), { user: user("u_owner") }))).not.toMatch(/Secret|prj_wb_|shot_priv/);
});

test("POST /api/shots: written only into a project its writer may write; anyone else's answer is the unknown project's", async () => {
  const ws = workspace(`ps-b-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  let who = as("u_owner");
  const route = loadRoute<typeof import("../../app/api/shots/route")>("app/api/shots/route.ts", () => who);
  let n = 0;
  const make = async (actor: ReturnType<typeof as>, projectId: string, within: TenantWorkspace = ws) => {
    who = actor;
    return tenant.runInTenant(within, async () => {
      const res = await route.POST(new Request("https://particl.test/api/shots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, code: `SH${100 + ++n}`, title: "New" }) }), undefined as never);
      return [res.status, await res.json()] as const;
    }, { user: actor.user, token: actor.token as never });
  };
  const unknown = await make(as("u_mate"), "prj_wb_doesnotexist0000000000");
  expect(unknown[0]).toBe(404);
  expect((await make(as("u_owner"), privateProject))[0], "the owner writes their own board").toBe(200);
  expect((await make(as("u_mate"), "prod_open"))[0], "an ordinary production is the workspace's").toBe(200);
  for (const actor of [as("u_mate"), as("u_admin", "admin"), as("u_mate", "member", true)]) {
    expect(await make(actor, privateProject), `${actor.user.id} on a private board`).toEqual(unknown);
  }
  /* Shared, it is view-only for everyone but its owner. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  for (const actor of [as("u_mate"), as("u_admin", "admin"), as("u_mate", "member", true)]) expect(await make(actor, privateProject), `${actor.user.id} on a shared board`).toEqual(unknown);
  expect((await make(as("u_owner"), privateProject))[0]).toBe(200);
  /* Another workspace: the same id is no project there. */
  expect(await make(as("u_owner"), privateProject, workspace(`ps-b2-${run}`))).toEqual(unknown);
  const writers = await tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT created_by FROM shots WHERE project_id=? AND title='New'", args: [privateProject] })).rows.map((r) => r.created_by), { user: user("u_owner") });
  expect(writers, "only the owner's two shots (before and after sharing) were written").toEqual(["u_owner", "u_owner"]);
});

test("a render or a quote is filed only into a project its writer may write: no hold, quote or spend for anyone else, answered as an unknown project (or shot)", async () => {
  const ws = workspace(`ps-c-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_ps_${run}`, ws.id, 5000, "Test", Date.now()] });
  const body = (extra: Record<string, unknown>) => ({ model: "grok-imagine-video", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, ...extra });
  const ask = async (actor: ReturnType<typeof as>, extra: Record<string, unknown>) =>
    tenant.runInTenant(ws, async () => { await database.ready(); const r = await prepareGeneration(body(extra), actor as never); return r.ok ? ["ok", r.value.quote.estimatedCredits] as const : [r.status, r.body] as const; }, { user: actor.user, token: actor.token as never });
  const unknownProject = await ask(as("u_mate"), { projectId: "prj_wb_doesnotexist0000000000" });
  expect(unknownProject).toEqual([404, { error: "No such project." }]);
  expect((await ask(as("u_owner"), { projectId: privateProject }))[0], "the owner is quoted on their own board").toBe("ok");
  expect((await ask(as("u_mate"), { projectId: "prod_open" }))[0], "an ordinary production is the workspace's").toBe("ok");
  const writers = [as("u_mate"), as("u_admin", "admin"), as("u_mate", "member", true)];
  for (const actor of writers) expect(await ask(actor, { projectId: privateProject }), `${actor.user.id}: private board`).toEqual(unknownProject);
  /* Through a shot of the private board: as absent as an unknown shot. */
  const unknownShot = await ask(as("u_mate"), { shotId: "shot_doesnotexist" });
  expect(unknownShot).toEqual([404, { error: "No such shot." }]);
  for (const actor of writers) expect(await ask(actor, { shotId: `shot_priv_${run}` }), `${actor.user.id}: private board's shot`).toEqual(unknownShot);
  expect((await ask(as("u_owner"), { shotId: `shot_priv_${run}` }))[0]).toBe("ok");
  /* Shared: view-only, so still refused to everyone but its owner. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  for (const actor of writers) {
    expect(await ask(actor, { projectId: privateProject }), `${actor.user.id}: shared board`).toEqual(unknownProject);
    expect(await ask(actor, { shotId: `shot_priv_${run}` }), `${actor.user.id}: shared board's shot`).toEqual(unknownShot);
  }
  expect((await ask(as("u_owner"), { projectId: privateProject }))[0]).toBe("ok");
  /* Another workspace: no such project there. */
  const other = workspace(`ps-c2-${run}`);
  const elsewhere = await tenant.runInTenant(other, async () => { await database.ready(); const r = await prepareGeneration(body({ projectId: privateProject }), as("u_owner") as never); return r.ok ? ["ok"] as const : [r.status, r.body] as const; }, { user: user("u_owner") });
  expect(elsewhere).toEqual(unknownProject);
});
