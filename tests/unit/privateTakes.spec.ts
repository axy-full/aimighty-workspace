import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { runTool } from "../../lib/mcp";

/**
 * The takes of a private board (lib/draftProject.ts): the list of takes, one take, the MCP tools list_renders and get_render, the project Library,
 * a take's file and the approved-takes package leave out a private board's takes for anyone who may not see it, and answer as for an unknown id.
 * Owner decision: the board's owner sees them; a teammate only once the board is shared (to look at) or if it is the marked sample; a workspace
 * admin (the owner included) of the SAME workspace sees them (the work belongs to the workspace); a token acts as its person; another workspace
 * sees nothing, ever. Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-private-takes-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member", owner = false) => ({ id, email: `${id}@example.test`, name: id, role, owner, disabled: false, lastSeen: null, createdAt: 0 });
type Actor = { user: ReturnType<typeof user>; token?: unknown };
const as = (id: string, role: "admin" | "member" = "member", token = false, owner = false): Actor => ({ user: user(id, role, owner), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null } } : {}) });

function loadRoute<T>(file: string, who: () => Actor): T {
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

/* Boards: a private one (the owner's), a shared one (the owner's, shared), the marked sample (another person's), an ordinary production, and unfiled work. */
const PRIV = "PRIV", SHARED = "SHARED", SAMPLE = "SAMPLE", OPEN = "OPEN", FREE = "FREE";
async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const board = (owner: string, id: string) => draft.mappedId("prj_wb_", ws.id, owner, id);
  const projects = { private: board("u_owner", "d1"), shared: board("u_owner", "d2"), sample: board("u_marker", "d3") };
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const [id, name] of [[projects.private, "Private board"], [projects.shared, "Shared board"], [projects.sample, "Sample board"], ["prod_open", "Ordinary production"]])
      await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, name] });
    const draftRow = (owner: string, id: string, extra: Record<string, unknown> = {}) => db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${owner}:${id}`, owner, id, id, JSON.stringify({ ...newProject(id), id, ...extra })] });
    await draftRow("u_owner", "d1", { productionProjectId: projects.private });
    await draftRow("u_owner", "d2", { productionProjectId: projects.shared, teamShared: true });
    await draftRow("u_marker", "d3", { productionProjectId: projects.sample });
    /* A teammate's and an admin's own drafts that link the owner's private board (as an opened link does): their Library reads that board's takes. */
    await draftRow("u_mate", "dm", { productionProjectId: projects.private });
    await draftRow("u_admin", "da", { productionProjectId: projects.private });
    await db.execute({ sql: "INSERT OR REPLACE INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_admin',0)", args: [JSON.stringify({ version: 1, projectId: projects.sample, name: "Sample board", draftOwner: "u_marker", draftId: "d3", markedBy: "u_admin", markedAt: 0 })] });
    /* Newest first: the hidden ones are the newest, so a page that merely dropped them afterwards would come back short. */
    const take = (id: string, prompt: string, projectId: string | null, at: number, extra = "") => db.execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url${extra ? ",review_state" : ""}) VALUES(?,?,?,?,?,?,?,'image',?,0,'u_owner',?,?${extra ? ",?" : ""})`,
      args: extra ? [id, "m", prompt, "{}", "succeeded", at, at, prompt, projectId, "/api/platform/previews/x", extra] : [id, "m", prompt, "{}", "succeeded", at, at, prompt, projectId, "/api/platform/previews/x"] });
    await take(`t_priv2_${run}`, `${PRIV}-two`, projects.private, 90);
    await take(`t_priv1_${run}`, `${PRIV}-one`, projects.private, 80, "approved");
    await take(`t_shared_${run}`, `${SHARED}-one`, projects.shared, 70);
    await take(`t_sample_${run}`, `${SAMPLE}-one`, projects.sample, 60);
    await take(`t_open_${run}`, `${OPEN}-one`, "prod_open", 50);
    await take(`t_free_${run}`, `${FREE}-one`, null, 40);
  }, { user: user("u_owner") });
  return { tenant, database, projects };
}

const prompts = (body: { generations: { prompt: string }[] }) => body.generations.map((g) => g.prompt);
const OWNER = as("u_owner"), MATE = as("u_mate"), MATE_TOKEN = as("u_mate", "member", true);
const ADMIN = as("u_admin", "admin"), ADMIN_TOKEN = as("u_admin", "admin", true), WS_OWNER = as("u_wsowner", "admin", false, true);
const SEES_PRIVATE = [OWNER, ADMIN, ADMIN_TOKEN, WS_OWNER];
const HIDDEN_FROM = [MATE, MATE_TOKEN];

test("GET /api/jobs: a private board's takes are its owner's and the workspace's admins'; shared and sample boards are for everyone; pages and cursors hold only what is seen", async () => {
  const ws = workspace(`pt-a-${run}`);
  const { tenant, projects } = await fixture(ws);
  let who: Actor = OWNER;
  const route = loadRoute<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", () => who);
  const list = async (actor: Actor, query = "?sync=0&limit=60", within: TenantWorkspace = ws) => {
    who = actor;
    return tenant.runInTenant(within, async () => (await route.GET(new Request(`https://particl.test/api/jobs${query}`), undefined as never)).json(), { user: actor.user, token: actor.token as never });
  };
  const everyone = [`${SHARED}-one`, `${SAMPLE}-one`, `${OPEN}-one`, `${FREE}-one`];
  for (const actor of SEES_PRIVATE) expect(prompts(await list(actor)), actor.user.id).toEqual([`${PRIV}-two`, `${PRIV}-one`, ...everyone]);
  for (const actor of HIDDEN_FROM) {
    const body = await list(actor);
    expect(prompts(body), actor.user.id).toEqual(everyone);
    expect(JSON.stringify(body), actor.user.id).not.toContain(PRIV);
    expect(JSON.stringify(body), actor.user.id).not.toContain("prj_wb_" + "x");
  }
  /* The list of the private board itself, and a search that would match its takes: as empty as an unknown board's, and as a search that finds nothing. */
  const unknown = await list(MATE, "?sync=0&projectId=prj_wb_doesnotexist0000000000");
  for (const actor of HIDDEN_FROM) {
    expect(await list(actor, `?sync=0&projectId=${projects.private}`), actor.user.id).toEqual(unknown);
    expect(prompts(await list(actor, `?sync=0&q=${PRIV}`)), actor.user.id).toEqual([]);
  }
  for (const actor of SEES_PRIVATE) expect(prompts(await list(actor, `?sync=0&projectId=${projects.private}`)), actor.user.id).toEqual([`${PRIV}-two`, `${PRIV}-one`]);
  /* Pages: the two newest takes are hidden, and a page of three still holds three the person may see, with a cursor that follows the last of them. */
  const page = await list(MATE, "?sync=0&limit=3");
  expect(prompts(page)).toEqual(everyone.slice(0, 3));
  expect(page.nextCursor).toBe(page.generations.at(-1).createdAt);
  const next = await list(MATE, `?sync=0&limit=3&before=${page.nextCursor}`);
  expect(prompts(next)).toEqual(everyone.slice(3));
  /* Stable pagination reports the same: no hidden row is read as "one more". */
  const stable = await list(MATE, "?sync=0&pagination=stable&limit=4");
  expect(prompts(stable)).toEqual(everyone);
  expect(stable.nextPageCursor).toBeNull();
  /* Another workspace's admin: none of it, whatever the ids. */
  const other = workspace(`pt-a2-${run}`);
  await tenant.runInTenant(other, async () => { (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  expect(await list(ADMIN, "?sync=0", other)).toMatchObject({ generations: [] });
  expect(await list(ADMIN, `?sync=0&projectId=${projects.private}`, other)).toMatchObject({ generations: [] });
});

test("GET /api/jobs/[id]: a hidden take is answered exactly as an unknown id", async () => {
  const ws = workspace(`pt-b-${run}`);
  const { tenant } = await fixture(ws);
  let who: Actor = OWNER;
  const route = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => who);
  const read = async (actor: Actor, id: string, within: TenantWorkspace = ws) => {
    who = actor;
    return tenant.runInTenant(within, async () => {
      const res = await route.GET(new Request(`https://particl.test/api/jobs/${id}?sync=0`), { params: Promise.resolve({ id }) });
      return [res.status, await res.json()] as const;
    }, { user: actor.user, token: actor.token as never });
  };
  const unknown = await read(MATE, "t_does_not_exist");
  expect(unknown[0]).toBe(404);
  for (const actor of SEES_PRIVATE) expect((await read(actor, `t_priv1_${run}`))[0], actor.user.id).toBe(200);
  for (const actor of HIDDEN_FROM) {
    expect(await read(actor, `t_priv1_${run}`), actor.user.id).toEqual(unknown);
    expect(await read(actor, `t_priv2_${run}`), actor.user.id).toEqual(unknown);
  }
  /* Shared and sample boards, the ordinary production and unfiled work: for everyone. */
  for (const actor of [...HIDDEN_FROM, ...SEES_PRIVATE]) for (const id of ["t_shared", "t_sample", "t_open", "t_free"]) expect((await read(actor, `${id}_${run}`))[0], `${actor.user.id} ${id}`).toBe(200);
  /* Another workspace: the same ids are no takes there. */
  const other = workspace(`pt-b2-${run}`);
  await tenant.runInTenant(other, async () => { await (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  expect(await read(ADMIN, `t_priv1_${run}`, other)).toEqual(unknown);
});

test("MCP list_renders and get_render: a hidden take is not listed and get_render says what it says for an unknown id; an admin's token, as its person, sees it", async () => {
  const ws = workspace(`pt-c-${run}`);
  const { tenant } = await fixture(ws);
  let who: Actor = OWNER;
  const jobs = loadRoute<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", () => who);
  const one = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => who);
  /* The caller the MCP bridge makes (lib/mcp.ts makeCaller), answered by the real routes for this token's person. */
  const caller = (actor: Actor, within: TenantWorkspace = ws) => async (pathname: string) => {
    who = actor;
    return tenant.runInTenant(within, async () => {
      const url = new URL(`https://particl.test${pathname}`);
      const id = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname)?.[1];
      const res = id ? await one.GET(new Request(url), { params: Promise.resolve({ id }) }) : url.pathname === "/api/projects" ? Response.json({ projects: [] }) : await jobs.GET(new Request(url), undefined as never);
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json.error ?? `${res.status} from ${pathname}`));
      return json;
    }, { user: actor.user, token: actor.token as never });
  };
  const tool = (actor: Actor, name: string, args: Record<string, string | number>, within?: TenantWorkspace) => runTool(name, args, caller(actor, within) as never, "https://particl.test");
  const message = async (actor: Actor, id: string, within?: TenantWorkspace) => { try { return await tool(actor, "get_render", { id }, within); } catch (error) { return `ERROR ${(error as Error).message}`; } };
  const unknown = await message(MATE_TOKEN, "t_does_not_exist");
  expect(unknown).toMatch(/^ERROR /);
  for (const actor of HIDDEN_FROM) {
    const text = await tool(actor, "list_renders", { limit: 60 });
    expect(text, actor.user.id).not.toContain(PRIV);
    expect(text, actor.user.id).toContain(`${SHARED}-one`);
    expect(text, actor.user.id).toContain(`${SAMPLE}-one`);
    expect(await message(actor, `t_priv1_${run}`), actor.user.id).toBe(unknown);
  }
  for (const actor of [ADMIN_TOKEN, OWNER]) {
    expect(await tool(actor, "list_renders", { limit: 60 }), actor.user.id).toContain(`${PRIV}-one`);
    expect(await message(actor, `t_priv1_${run}`), actor.user.id).toContain(`${PRIV}-one`);
  }
  /* Another workspace's admin: nothing. */
  const other = workspace(`pt-c2-${run}`);
  await tenant.runInTenant(other, async () => { await (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  expect(await tool(ADMIN_TOKEN, "list_renders", { limit: 60 }, other)).toBe("No renders match that.");
  expect(await message(ADMIN_TOKEN, `t_priv1_${run}`, other)).toBe(unknown);
});

test("the project Library, a take's file and the approved-takes package: the same rule", async () => {
  const ws = workspace(`pt-d-${run}`);
  const { tenant, projects } = await fixture(ws);
  const { listProjectLibrary } = await import("../../lib/workbench/project-library");
  /* The Library of a draft that links the private board: a teammate's draft lists none of its takes, an admin's draft lists them. */
  const library = (actor: Actor, draftOwner: string, draft: string, within: TenantWorkspace = ws) => tenant.runInTenant(within, async () => {
    const body = await listProjectLibrary(draftOwner, new URLSearchParams({ projectId: draft, source: "generations" }));
    return ((body as { generations: { prompt: string }[] }).generations).map((g) => g.prompt);
  }, { user: actor.user, token: actor.token as never });
  expect(await library(MATE, "u_mate", "dm")).toEqual([]);
  expect(await library(ADMIN, "u_admin", "da")).toEqual([`${PRIV}-two`, `${PRIV}-one`]);
  expect(await library(OWNER, "u_owner", "d1")).toEqual([`${PRIV}-two`, `${PRIV}-one`]);
  /* A take's file (a demo take redirects; the answer of a hidden take is the unknown id's). */
  let who: Actor = OWNER;
  const media = loadRoute<typeof import("../../app/api/media/[id]/route")>("app/api/media/[id]/route.ts", () => who);
  const file = async (actor: Actor, id: string) => { who = actor; return tenant.runInTenant(ws, async () => { const res = await media.GET(new Request(`https://particl.test/api/media/${id}`), { params: Promise.resolve({ id }) }); return [res.status, await res.text()] as const; }, { user: actor.user, token: actor.token as never }); };
  const unknown = await file(MATE, "t_does_not_exist");
  expect(unknown[0]).toBe(404);
  for (const actor of SEES_PRIVATE) expect((await file(actor, `t_priv1_${run}`))[0], actor.user.id).toBe(302);
  for (const actor of HIDDEN_FROM) expect(await file(actor, `t_priv1_${run}`), actor.user.id).toEqual(unknown);
  expect((await file(MATE, `t_shared_${run}`))[0]).toBe(302);
  /* The approved-takes package: counted for those who see the board, the answer for a production with nothing approved for those who do not. */
  const selects = loadRoute<typeof import("../../app/api/export/selects/route")>("app/api/export/selects/route.ts", () => who);
  const count = async (actor: Actor, projectId: string) => { who = actor; return tenant.runInTenant(ws, async () => { const res = await selects.GET(new Request(`https://particl.test/api/export/selects?projectId=${projectId}&format=count`), undefined as never); return [res.status, await res.json()] as const; }, { user: actor.user, token: actor.token as never }); };
  const none = await count(MATE, "prj_wb_doesnotexist0000000000");
  expect(none[0]).toBe(404);
  for (const actor of SEES_PRIVATE) expect(await count(actor, projects.private), actor.user.id).toEqual([200, { approved: 1 }]);
  for (const actor of HIDDEN_FROM) expect(await count(actor, projects.private), actor.user.id).toEqual(none);
});
