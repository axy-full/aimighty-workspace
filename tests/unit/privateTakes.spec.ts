import { test, expect } from "@playwright/test";
import { FAST_STILL_ENGINE } from "../helpers/runtimeIds";
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
const as = (id: string, role: "admin" | "member" = "member", token = false, owner = false): Actor => ({ user: user(id, role, owner), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null, capCredits: 100_000 } } : {}) });

function loadRoute<T>(file: string, who: () => Actor, extra: Record<string, unknown> = {}): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ ...who() }), requireRender: async () => ({ ...who() }), requireSession: async () => ({ ...who() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    ...extra,
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
    /* What a planner would read about each board: one named cast member in the private board. */
    await db.execute({ sql: "INSERT INTO cast_members(id,project_id,name,kind,description,created_by,created_at) VALUES(?,?,?,?,?,?,1)", args: [`cast_${run}`, projects.private, "SecretCast", "character", "Only the owner's board", "u_owner"] });
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


/* ── Usage, thumbnails, provenance, the strip's take, and Atomik's context ─────────────────────────────────────────── */

test("GET /api/usage: a private board's render stays in the spend and loses its words; the owner and admins read it; another workspace has none", async () => {
  const ws = workspace(`pt-e-${run}`);
  const { tenant, projects } = await fixture(ws);
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { creditUsage } = await import("../../lib/creditUsage");
  await platformReady(); await alignLedgerUnit();
  const meter = (id: string, projectId: string | null, credits: number, at: number) => platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,'image','google',?,'succeeded',0.01,?,1,'u_owner',?,?)", args: [id, ws.id, projectId, FAST_STILL_ENGINE, credits, at, at] });
  await meter(`t_priv1_${run}`, projects.private, 12, 80); await meter(`t_shared_${run}`, projects.shared, 5, 70); await meter(`t_open_${run}`, "prod_open", 3, 50);
  /* A take moved into the private board after its meter line was written: the line still names the ordinary production, the take is in the private board now. */
  await meter(`t_priv2_${run}`, "prod_open", 7, 90);
  const usage = (actor: Actor, within: TenantWorkspace = ws) => tenant.runInTenant(within, () => creditUsage({ id: actor.user.id, admin: actor.user.role === "admin" }), { user: actor.user, token: actor.token as never });
  const total = (body: { byModel: { credits: number }[] }) => body.byModel.reduce((n, m) => n + m.credits, 0);
  for (const actor of HIDDEN_FROM) {
    const body = await usage(actor);
    /* The money is whole: 12 + 7 + 5 + 3. The words are not: no id, title, prompt or settings of a hidden render, whichever project its meter line names. */
    expect(total(body), actor.user.id).toBe(27);
    for (const credits of [12, 7]) expect(body.recent.find((r: { credits: number }) => r.credits === credits)!, `${actor.user.id} ${credits}`).toMatchObject({ id: "", title: "A private board", prompt: "", params: {}, status: "succeeded" });
    expect(JSON.stringify(body), actor.user.id).not.toContain(`t_priv1_${run}`);
    expect(JSON.stringify(body), actor.user.id).not.toContain(`t_priv2_${run}`);
    expect(JSON.stringify(body), actor.user.id).not.toContain(PRIV);
    expect(body.recent.find((r: { credits: number }) => r.credits === 5), actor.user.id).toMatchObject({ id: `t_shared_${run}`, prompt: `${SHARED}-one` });
  }
  for (const actor of SEES_PRIVATE) {
    const recent = (await usage(actor)).recent;
    expect(recent.find((r: { credits: number }) => r.credits === 12)!, actor.user.id).toMatchObject({ id: `t_priv1_${run}`, prompt: `${PRIV}-one` });
    expect(recent.find((r: { credits: number }) => r.credits === 7)!, actor.user.id).toMatchObject({ id: `t_priv2_${run}`, prompt: `${PRIV}-two` });
  }
  /* Another workspace: its ledger has none of these. */
  const other = workspace(`pt-e2-${run}`);
  await tenant.runInTenant(other, async () => { await (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  expect((await usage(ADMIN, other)).recent).toEqual([]);
});

test("a thumbnail, a take's provenance and the strip's take: a hidden take is the unknown id's answer, and the shot's strip shows no take", async () => {
  const ws = workspace(`pt-f-${run}`);
  const { tenant, database, projects } = await fixture(ws);
  let who: Actor = OWNER;
  const preview = loadRoute<typeof import("../../app/api/workbench/preview/[kind]/[id]/route")>("app/api/workbench/preview/[kind]/[id]/route.ts", () => who);
  const provenance = loadRoute<typeof import("../../app/api/rig/provenance/[id]/route")>("app/api/rig/provenance/[id]/route.ts", () => who);
  const bindings = loadRoute<typeof import("../../app/api/rig/bindings/[id]/route")>("app/api/rig/bindings/[id]/route.ts", () => who);
  /* A real picture for the owner's take, and a shot of the private board that holds it. */
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    await db.execute({ sql: "UPDATE generations SET kind='image',bytes=10 WHERE id IN (?,?)", args: [`t_priv1_${run}`, `t_open_${run}`] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,setup,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", args: [`shot_p_${run}`, projects.private, "SH010", "Secret title", "", "{}"] });
    await db.execute({ sql: "UPDATE generations SET shot_id=? WHERE id=?", args: [`shot_p_${run}`, `t_priv1_${run}`] });
  }, { user: user("u_owner") });
  const as_ = <R>(actor: Actor, run_: () => Promise<R>) => { who = actor; return tenant.runInTenant(ws, run_, { user: actor.user, token: actor.token as never }); };
  const thumb = (actor: Actor, id: string) => as_(actor, async () => { const res = await preview.GET(new Request(`https://particl.test/x`), { params: Promise.resolve({ kind: "generation", id }) }); return [res.status, await res.text()] as const; });
  const prov = (actor: Actor, id: string) => as_(actor, async () => { const res = await provenance.GET(new Request("https://particl.test/x"), { params: Promise.resolve({ id }) }); return [res.status, await res.json()] as const; });
  const strip = (actor: Actor) => as_(actor, async () => (await (await bindings.GET(new Request("https://particl.test/x"), { params: Promise.resolve({ id: `shot_p_${run}` }) })).json()) as { take: { id: string } | null });
  const unknownProv = await prov(MATE, "t_does_not_exist");
  expect(unknownProv[0]).toBe(404);
  const unknownThumb = await thumb(MATE, "t_does_not_exist");
  for (const actor of SEES_PRIVATE) {
    expect((await prov(actor, `t_priv1_${run}`))[0], actor.user.id).toBe(200);
    expect((await strip(actor)).take, actor.user.id).toMatchObject({ id: `t_priv1_${run}` });
    /* The picture itself is read from storage (not in this test): the owner's answer is not the unknown id's "Not found". */
    expect((await thumb(actor, `t_priv1_${run}`))[1], actor.user.id).not.toBe("Not found");
  }
  for (const actor of HIDDEN_FROM) {
    expect(await prov(actor, `t_priv1_${run}`), actor.user.id).toEqual(unknownProv);
    expect(await thumb(actor, `t_priv1_${run}`), actor.user.id).toEqual(unknownThumb);
    expect((await strip(actor)).take, actor.user.id).toBeNull();
  }
  expect((await prov(MATE, `t_shared_${run}`))[0]).toBe(200);
  expect((await thumb(MATE, `t_open_${run}`))[1]).not.toBe("Not found");
  /* Another workspace's admin: the same ids are no takes there. */
  const other = workspace(`pt-f2-${run}`);
  await tenant.runInTenant(other, async () => { await (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  who = ADMIN;
  expect(await tenant.runInTenant(other, async () => { const res = await provenance.GET(new Request("https://particl.test/x"), { params: Promise.resolve({ id: `t_priv1_${run}` }) }); return [res.status, await res.json()] as const; }, { user: ADMIN.user })).toEqual(unknownProv);
});

test("Atomik: a project the caller may not read is no project for the model, before anything is read; its owner reads it; an admin, an admin token and the workspace owner get nothing, as for an unknown id; another workspace reads nothing", async () => {
  const ws = workspace(`pt-g-${run}`);
  const { tenant, projects } = await fixture(ws);
  const atomik = await import("../../lib/atomik");
  const { PaidTextError } = await import("../../lib/paidText");
  type Seen = { projectId: string | null | undefined; context: string | undefined; library: unknown };
  const seen: Seen[] = [];
  /* runTurn is the model: stand-in records what it was handed and stops. Everything before it (the cast, memory, library reads) is real. */
  const spy = { ...atomik, runTurn: async (_id: string | null, opts: { projectId?: string | null; context?: string; library?: unknown }) => { seen.push({ projectId: opts.projectId, context: opts.context, library: opts.library }); throw new PaidTextError("stop", 400); } };
  let who: Actor = OWNER;
  const start = loadRoute<typeof import("../../app/api/atomik/route")>("app/api/atomik/route.ts", () => who, { "@/lib/atomik": spy });
  const turn = loadRoute<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts", () => who, { "@/lib/atomik": spy });
  const ask = (actor: Actor, projectId: string, within: TenantWorkspace = ws) => {
    who = actor; seen.length = 0;
    const headers = { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${within.id}-${actor.user.id}` };
    return tenant.runInTenant(within, async () => {
      /* A quote on a named project, and a turn in a chat that names it. */
      await start.POST(new Request("https://particl.test/api/atomik", { method: "POST", headers, body: JSON.stringify({ quoteOnly: true, text: "plan it", projectId }) }) as never, undefined as never);
      const chat = await atomik.createChat({ userId: actor.user.id, projectId, model: "auto", agentMode: "ask" });
      await turn.POST(new Request(`https://particl.test/api/atomik/${chat}`, { method: "POST", headers, body: JSON.stringify({ quoteOnly: true, text: "plan it" }) }) as never, { params: Promise.resolve({ id: chat }) });
      return seen.map((s) => ({ ...s }));
    }, { user: actor.user, token: actor.token as never });
  };
  const unknown = await ask(MATE, "prj_wb_doesnotexist0000000000");
  expect(unknown).toHaveLength(2);
  for (const actor of HIDDEN_FROM) {
    const got = await ask(actor, projects.private);
    expect(got.map((s) => s.projectId), actor.user.id).toEqual([null, null]);
    expect(JSON.stringify(got), actor.user.id).not.toMatch(/SecretCast|PRIV-|Only the owner/);
    expect(got.map((s) => s.context), actor.user.id).toEqual(unknown.map((s) => s.context));
  }
  /* A teammate's shared board is view-only for them (owner, 14 Oct 23:35): it may feed the model's context, but it is no project to file or spend against, so the quote and the turn carry no project and the model is told to propose no renders. Its author files on it as always. */
  const viewOnly = await ask(MATE, projects.shared);
  expect(viewOnly.map((s) => s.projectId)).toEqual([null, null]);
  for (const s of viewOnly) expect(s.context).toContain("This board is view-only for you, so I won't set up renders on it.");
  const author = await ask(OWNER, projects.shared);
  expect(author.map((s) => s.projectId)).toEqual([projects.shared, projects.shared]);
  for (const s of author) expect(s.context ?? "").not.toContain("view-only");
  /* The sample: readable (view), as for anyone. */
  expect((await ask(MATE, projects.sample)).map((s) => s.projectId)).toEqual([projects.sample, projects.sample]);
  {
    const got = await ask(OWNER, projects.private);
    expect(got.map((s) => s.projectId), OWNER.user.id).toEqual([projects.private, projects.private]);
    expect(got[0].context, OWNER.user.id).toContain("SecretCast");
  }
  /* An admin has no elevation here (owner, 14 Oct 23:35): someone else's private board gives Atomik neither context nor a project to file or spend against, the same as an unknown id. The audited admin read is its own path (#715). */
  for (const actor of [ADMIN, ADMIN_TOKEN, WS_OWNER]) {
    const got = await ask(actor, projects.private);
    expect(got.map((s) => s.projectId), actor.user.id).toEqual([null, null]);
    expect(JSON.stringify(got), actor.user.id).not.toMatch(/SecretCast|PRIV-|Only the owner/);
    expect(got.map((s) => s.context), actor.user.id).toEqual(unknown.map((s) => s.context));
  }
  /* Another workspace: the id is no project there, and it reads no cast. */
  const other = workspace(`pt-g2-${run}`);
  await tenant.runInTenant(other, async () => { await (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  const there = await ask(ADMIN, projects.private, other);
  expect(JSON.stringify(there)).not.toContain("SecretCast");
});

test("a member's real turn on a private board's chat writes the placeholder nowhere: no meter line, reservation or memory carries it", async () => {
  const ws = workspace(`pt-h-${run}`);
  const { tenant, database, projects } = await fixture(ws);
  const atomik = await import("../../lib/atomik");
  const { platformDb } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  const { platformReady } = await import("../../lib/platform");
  await platformReady(); await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_pt_${run}`, ws.id, 5000, "Test", Date.now()] });
  /* A workspace with no sample production, so the turn is let spend (it is the mocked planner, nothing real). */
  await tenant.runInTenant(ws, () => database.db().execute("DELETE FROM settings WHERE key='sampleProduction'"), { user: user("u_owner") });
  const turn = loadRoute<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts", () => MATE);
  const headers = { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${ws.id}-${MATE.user.id}` };
  /* Atomik's thinking reads the checked-in catalogue (the slots are picked from it), never the gateway's live list; put back after the turn. */
  const priorCatalog = process.env.MODEL_CATALOG;
  process.env.MODEL_CATALOG = "static";
  const res = await tenant.runInTenant(ws, async () => {
    const chat = await atomik.createChat({ userId: MATE.user.id, projectId: projects.private, model: "auto", agentMode: "ask" });
    const out = await turn.POST(new Request(`https://particl.test/api/atomik/${chat}`, { method: "POST", headers, body: JSON.stringify({ text: "remember that the board is green", maxCredits: 50 }) }) as never, { params: Promise.resolve({ id: chat }) });
    return [out.status, await out.text()] as const;
  }, { user: MATE.user }).finally(() => { if (priorCatalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = priorCatalog; });
  expect(res[0], res[1].slice(0, 200)).toBe(200);
  /* The turn did spend and record (a planning line in the meter), against no project. */
  const lines = (await platformDb().execute({ sql: "SELECT project_id,kind FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows;
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((l) => l.project_id == null)).toBe(true);
  /* Every table a turn writes, in the workspace's own database and the platform's: none holds the placeholder id, nor the private board's. */
  const dump = async (client: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> }, tables: string[]) => {
    const out: Record<string, string> = {};
    for (const t of tables) { try { out[t] = JSON.stringify((await client.execute(`SELECT * FROM ${t}`)).rows); } catch { out[t] = ""; } }
    return out;
  };
  const platform = await dump(platformDb() as never, ["meter_events", "generation_reservations", "spend_reservations", "credit_grants"]);
  const tenantRows = await tenant.runInTenant(ws, () => dump(database.db() as never, ["atomik_chats", "atomik_messages", "atomik_steps", "memory_items", "workspace_memory", "generation_requests"]), { user: MATE.user });
  for (const [table, text] of Object.entries({ ...platform, ...tenantRows })) {
    expect(text, table).not.toContain("\\u0000unknown");
    if (table === "meter_events" || table === "generation_reservations" || table === "spend_reservations") expect(text, table).not.toContain(projects.private);
  }
});

test("Atomik chats on a private board are their person's (#688's rule): a member can neither read, list nor post into the owner's chat; to them it is an unknown chat; the owner can", async () => {
  const ws = workspace(`pt-i-${run}`);
  const { tenant, database, projects } = await fixture(ws);
  const atomik = await import("../../lib/atomik");
  /* A workspace with no sample production, so a turn would be let spend were it not refused first. */
  await tenant.runInTenant(ws, () => database.db().execute("DELETE FROM settings WHERE key='sampleProduction'"), { user: user("u_owner") });
  let who: Actor = OWNER;
  const list = loadRoute<typeof import("../../app/api/atomik/route")>("app/api/atomik/route.ts", () => who);
  const chatRoute = loadRoute<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts", () => who);
  const chat = await tenant.runInTenant(ws, () => atomik.createChat({ userId: "u_owner", projectId: projects.private, model: "auto", agentMode: "ask" }), { user: OWNER.user });
  const inWs = <R>(actor: Actor, fn: () => Promise<R>) => { who = actor; return tenant.runInTenant(ws, fn, { user: actor.user, token: actor.token as never }); };
  const headers = (actor: Actor) => ({ "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${ws.id}-${actor.user.id}` });
  const read = (actor: Actor, id: string) => inWs(actor, async () => { const res = await chatRoute.GET(new Request(`https://particl.test/api/atomik/${id}`) as never, { params: Promise.resolve({ id }) }); return [res.status, await res.json()] as const; });
  const post = (actor: Actor, id: string) => inWs(actor, async () => { const res = await chatRoute.POST(new Request(`https://particl.test/api/atomik/${id}`, { method: "POST", headers: headers(actor), body: JSON.stringify({ text: "plan it", maxCredits: 50 }) }) as never, { params: Promise.resolve({ id }) }); return [res.status, await res.json()] as const; });
  const chats = (actor: Actor) => inWs(actor, async () => (await (await list.GET(new Request("https://particl.test/api/atomik") as never, undefined as never)).json()) as { chats: { id: string }[] });
  const unknownRead = await read(MATE, "ach_does_not_exist"), unknownPost = await post(MATE, "ach_does_not_exist");
  expect(unknownRead[0]).toBe(404);
  /* The owner reads it, lists it and plans in it. */
  expect((await read(OWNER, chat))[0]).toBe(200);
  expect((await chats(OWNER)).chats.map((c) => c.id)).toContain(chat);
  /* Anyone else (a member, a member's token, an admin, an admin's token): gone, as an unknown chat is, and nothing is planned or spent. */
  for (const actor of [MATE, MATE_TOKEN, ADMIN, ADMIN_TOKEN, WS_OWNER]) {
    expect(await read(actor, chat), `${actor.user.id} read`).toEqual(unknownRead);
    expect(await post(actor, chat), `${actor.user.id} post`).toEqual(unknownPost);
    expect((await chats(actor)).chats.map((c) => c.id), `${actor.user.id} list`).not.toContain(chat);
  }
  const messages = await tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT COUNT(*) AS n FROM atomik_messages WHERE chat_id=?", args: [chat] })).rows[0].n, { user: OWNER.user });
  expect(Number(messages), "nobody posted into it").toBe(0);
});
