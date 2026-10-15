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
  /* A teammate and a teammate's token: the ordinary production only; nothing of the private board, not its title, its text or its id. */
  for (const actor of [as("u_mate"), as("u_mate", "member", true)]) {
    const all_ = await seen(actor);
    expect(all(all_), actor.user.id).toContain(`shot_open_${run}`);
    expect(JSON.stringify(all_), actor.user.id).not.toMatch(/Secret|prj_wb_/);
    /* A list of the private board itself is exactly as empty as an unknown project's. */
    expect(await seen(actor, `?projectId=${privateProject}`), actor.user.id).toEqual(await seen(actor, "?projectId=prj_wb_doesnotexist0000000000"));
  }
  /* An admin of this workspace (owner, 13 Oct: any board in the workspace is theirs to open): the list of every shot is the same as a teammate's, the list of the board itself is the board's. */
  const admin = await seen(as("u_admin", "admin"));
  expect(all(admin), "an admin's list of every shot").toContain(`shot_open_${run}`);
  expect(JSON.stringify(admin), "an admin's list of every shot is not widened").not.toMatch(/Secret|prj_wb_/);
  expect(JSON.stringify(await seen(as("u_admin", "admin"), `?projectId=${privateProject}`)), "an admin opens the board's own list").toContain("Secret title");
  /* Shared by its author: a teammate looks at it. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  expect(JSON.stringify(await seen(as("u_mate"), `?projectId=${privateProject}`))).toContain("Secret title");
  expect(all(await seen(as("u_admin", "admin")))).toContain(`shot_priv_${run}`);
  /* Another workspace sees none of it. */
  const other = workspace(`ps-a2-${run}`);
  await tenant.runInTenant(other, async () => { await database.ready(); }, { user: user("u_owner") });
  who = as("u_owner");
  expect(JSON.stringify(await tenant.runInTenant(other, () => list(), { user: user("u_owner") }))).not.toMatch(/Secret|prj_wb_|shot_priv/);
  /* An admin of another workspace sees none of it either, by the list of every shot or by the board's id. */
  who = as("u_admin", "admin");
  expect(JSON.stringify(await tenant.runInTenant(other, () => list(), { user: user("u_admin", "admin") }))).not.toMatch(/Secret|prj_wb_|shot_priv/);
  expect(JSON.stringify(await tenant.runInTenant(other, () => list(`?projectId=${privateProject}`), { user: user("u_admin", "admin") }))).not.toMatch(/Secret|prj_wb_|shot_priv/);
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
  for (const actor of [as("u_mate"), as("u_mate", "member", true)]) {
    expect(await make(actor, privateProject), `${actor.user.id} on a private board`).toEqual(unknown);
  }
  /* An admin of this workspace writes into any board in it (owner, 13 Oct). */
  expect((await make(as("u_admin", "admin"), privateProject))[0], "an admin on a member's private board").toBe(200);
  /* Shared, it is view-only for everyone but its owner (and an admin). */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  for (const actor of [as("u_mate"), as("u_mate", "member", true)]) expect(await make(actor, privateProject), `${actor.user.id} on a shared board`).toEqual(unknown);
  expect((await make(as("u_admin", "admin"), privateProject))[0], "an admin on a shared board").toBe(200);
  expect((await make(as("u_owner"), privateProject))[0]).toBe(200);
  /* Another workspace: the same id is no project there, for its members and for its admins alike. */
  expect(await make(as("u_owner"), privateProject, workspace(`ps-b2-${run}`))).toEqual(unknown);
  expect(await make(as("u_admin", "admin"), privateProject, workspace(`ps-b3-${run}`))).toEqual(unknown);
  const writers = await tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT created_by FROM shots WHERE project_id=? AND title='New'", args: [privateProject] })).rows.map((r) => r.created_by), { user: user("u_owner") });
  expect([...writers].sort(), "only the owner's two shots (before and after sharing) and the admin's two were written").toEqual(["u_admin", "u_admin", "u_owner", "u_owner"]);
});

test("a render or a quote is filed only into a project its writer may write: no hold, quote or spend for anyone else, answered as an unknown project (or shot)", async () => {
  const ws = workspace(`ps-c-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  /* The reservation table is created by the first render that reserves; make sure it exists, so a count that fails is an error and not a zero. */
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
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

test("client links, the treatment, the scene drafter and the cast: a private board's are its owner's; a shared board's are to look at; anyone else is answered as for an unknown project, and nothing is sent or spent", async () => {
  const ws = workspace(`ps-d-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  /* The reservation table is created by the first render that reserves; make sure it exists, so a count that fails is an error and not a zero. */
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  let who = as("u_owner");
  const reviewLinks = loadRoute<typeof import("../../app/api/review-links/route")>("app/api/review-links/route.ts", () => who);
  const treatment = loadRoute<typeof import("../../app/api/atomik/treatment/route")>("app/api/atomik/treatment/route.ts", () => who);
  const scene = loadRoute<typeof import("../../app/api/atomik/treatment/scene/route")>("app/api/atomik/treatment/scene/route.ts", () => who);
  const drafter = loadRoute<typeof import("../../app/api/atomik/shots/draft/route")>("app/api/atomik/shots/draft/route.ts", () => who);
  const cast = loadRoute<typeof import("../../app/api/cast/route")>("app/api/cast/route.ts", () => who);
  const json = (method: string, body: unknown) => new Request("https://particl.test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const url = (path: string) => new Request(`https://particl.test${path}`);
  const answer = async (res: Response) => [res.status, await res.json().catch(() => null)] as const;
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    await db.execute({ sql: "INSERT INTO treatments(id,project_id,title,logline,setup,scenes,notes,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)", args: [`tr_${run}`, privateProject, "Secret treatment", "Secret logline", "{}", JSON.stringify([{ n: 1, title: "Scene", secs: 5, prose: "Secret prose" }]), "[]", "u_owner"] }).catch(() => undefined);
    await db.execute({ sql: "INSERT INTO cast_members(id,project_id,name,created_at) VALUES(?,?,?,1)", args: [`cast_${run}`, privateProject, "SecretCast"] });
    await db.execute({ sql: "INSERT INTO cast_members(id,project_id,name,created_at) VALUES(?,?,?,1)", args: [`cast_o_${run}`, "prod_open", "OpenCast"] });
  }, { user: user("u_owner") });
  const count = async (sql: string, args: unknown[] = []) => Number((await platformDb().execute({ sql, args: args as never[] })).rows[0].n);
  const moneyRows = async () => (await count("SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", [ws.id])) + (await count("SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", [ws.id]));
  const asking = async (actor: ReturnType<typeof as>, fn: () => Promise<Response>) => { who = actor; return tenant.runInTenant(ws, async () => { try { return answer(await fn()); } catch (e) { return Promise.resolve(["threw", String((e as Error).message)] as const); } }, { user: actor.user, token: actor.token as never }); };
  const unknownId = "prj_wb_doesnotexist0000000000";
  const before = await tenant.runInTenant(ws, moneyRows, { user: user("u_owner") });
  const readers = [as("u_mate"), as("u_mate", "member", true)];
  for (const id of [privateProject]) {
    /* The treatment (read) and the cast list: as for an unknown project. */
    const unknownTreatment = await asking(as("u_mate"), () => treatment.GET(url(`/api/atomik/treatment?projectId=${unknownId}`), undefined as never));
    const unknownCast = await asking(as("u_mate"), () => cast.GET(url(`/api/cast?projectId=${unknownId}`), undefined as never));
    for (const actor of readers) {
      expect(await asking(actor, () => treatment.GET(url(`/api/atomik/treatment?projectId=${id}`), undefined as never)), `${actor.user.id}: treatment`).toEqual(unknownTreatment);
      expect(await asking(actor, () => cast.GET(url(`/api/cast?projectId=${id}`), undefined as never)), `${actor.user.id}: cast`).toEqual(unknownCast);
      expect(JSON.stringify(await asking(actor, () => cast.GET(url("/api/cast"), undefined as never))), `${actor.user.id}: every cast`).not.toContain("SecretCast");
      expect(JSON.stringify(await asking(actor, () => reviewLinks.GET(url(`/api/review-links?projectId=${id}`), undefined as never)))).toBe(JSON.stringify(await asking(actor, () => reviewLinks.GET(url(`/api/review-links?projectId=${unknownId}`), undefined as never))));
    }
    const owner = await asking(as("u_owner"), () => treatment.GET(url(`/api/atomik/treatment?projectId=${id}`), undefined as never));
    expect(JSON.stringify(owner), "the owner reads their own treatment").toContain("Secret logline");
    expect(JSON.stringify(await asking(as("u_owner"), () => cast.GET(url(`/api/cast?projectId=${id}`), undefined as never)))).toContain("SecretCast");
    /* Writes and spends: the treatment, the cast, a client link, the scene drafter and the scene rewrite. */
    for (const actor of readers) {
      expect(await asking(actor, () => treatment.PUT(json("PUT", { projectId: id, title: "Hijack", scenes: [], notes: [] }), undefined as never)), `${actor.user.id}: treatment PUT`).toEqual(
        await asking(actor, () => treatment.PUT(json("PUT", { projectId: unknownId, title: "Hijack", scenes: [], notes: [] }), undefined as never)));
      expect(await asking(actor, () => cast.POST(json("POST", { projectId: id, name: "Hijack" }), undefined as never)), `${actor.user.id}: cast POST`).toEqual(
        await asking(actor, () => cast.POST(json("POST", { projectId: unknownId, name: "Hijack" }), undefined as never)));
      /* A private board's client link is its owner's alone (owner, 14 Oct, 22:50): a member, or a member's token, is answered as for a production that is not saved (and none is made). */
      expect(await asking(actor, () => reviewLinks.POST(json("POST", { projectId: id }), undefined as never)), `${actor.user.id}: a client link`).toEqual(
        await asking(actor, () => reviewLinks.POST(json("POST", { projectId: unknownId }), undefined as never)));
      for (const [route, body] of [[drafter, { projectId: id, scene: 1 }], [scene, { projectId: id, n: 1 }]] as const) {
        const refused = await asking(actor, () => route.POST(json("POST", body), undefined as never));
        const unknown = await asking(actor, () => route.POST(json("POST", { ...body, projectId: unknownId }), undefined as never));
        expect(refused, `${actor.user.id}: ${route === drafter ? "drafter" : "scene"}`).toEqual(unknown);
      }
    }
  }
  expect(await tenant.runInTenant(ws, moneyRows, { user: user("u_owner") }), "nothing was reserved or metered").toBe(before);
  const madeLinks = await asking(as("u_owner"), () => reviewLinks.GET(url(`/api/review-links?projectId=${privateProject}`), undefined as never));
  expect((madeLinks[1] as { links: unknown[] }).links, "no client link was made by a member").toHaveLength(0);
  /* An unreachable board and an unknown id are refused outright, before any insert: the same explicit 404, and nothing under the sentinel id. */
  for (const actor of readers) {
    for (const target of [privateProject, unknownId]) {
      expect(await asking(actor, () => treatment.PUT(json("PUT", { projectId: target, title: "Hijack", scenes: [], notes: [] }), undefined as never)), `${actor.user.id}: treatment PUT ${target}`).toEqual([404, { error: "No such project." }]);
      expect(await asking(actor, () => cast.POST(json("POST", { projectId: target, name: "Hijack" }), undefined as never)), `${actor.user.id}: cast POST ${target}`).toEqual([404, { error: "No such project." }]);
    }
  }
  const sentinel = await tenant.runInTenant(ws, async () => {
    const rows = async (sql: string) => (await database.db().execute({ sql, args: ["\u0000unknown", unknownId] })).rows.length;
    return [await rows("SELECT 1 FROM treatments WHERE project_id IN (?,?)"), await rows("SELECT 1 FROM cast_members WHERE project_id IN (?,?)"), await rows("SELECT 1 FROM projects WHERE id IN (?,?)")];
  }, { user: user("u_owner") });
  expect(sentinel, "nothing was written under the sentinel or the unknown id").toEqual([0, 0, 0]);
  const titles = await tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT title FROM treatments WHERE project_id=?", args: [privateProject] })).rows.map((r) => r.title), { user: user("u_owner") });
  expect(titles).not.toContain("Hijack");
  /* An admin of this workspace reaches the board (owner, 13 Oct): reads, writes and makes a client link. Paid generation there is NOT theirs (owner, 14 Oct: an admin cannot start work that spends on a member's private board): the drafter and the scene rewrite still answer as for an unknown project, and nothing is metered or reserved. */
  const admin = as("u_admin", "admin");
  expect(JSON.stringify(await asking(admin, () => treatment.GET(url(`/api/atomik/treatment?projectId=${privateProject}`), undefined as never))), "an admin reads the treatment").toContain("Secret logline");
  expect(JSON.stringify(await asking(admin, () => cast.GET(url(`/api/cast?projectId=${privateProject}`), undefined as never))), "an admin reads the cast").toContain("SecretCast");
  expect((await asking(admin, () => reviewLinks.GET(url(`/api/review-links?projectId=${privateProject}`), undefined as never)))[0], "an admin reads the client links").toBe(200);
  for (const [route, body, label] of [[drafter, { projectId: privateProject, scene: 1 }, "drafter"], [scene, { projectId: privateProject, n: 1 }, "scene"]] as const) {
    const reached = await asking(admin, () => route.POST(json("POST", body), undefined as never));
    const unknown = await asking(admin, () => route.POST(json("POST", { ...body, projectId: unknownId }), undefined as never));
    expect(reached, `an admin: ${label} is refused as an unknown project is`).toEqual(unknown);
  }
  expect(await tenant.runInTenant(ws, moneyRows, { user: user("u_owner") }), "an admin's paid text on the board reserved and metered nothing").toBe(before);
  expect((await asking(admin, () => treatment.PUT(json("PUT", { projectId: privateProject, title: "Admin edit", logline: "Secret logline", scenes: [], notes: [], expectedUpdatedAt: 1 }), undefined as never)))[0], "an admin writes the treatment").toBe(200);
  expect((await asking(admin, () => cast.POST(json("POST", { projectId: privateProject, name: "AdminCast" }), undefined as never)))[0], "an admin adds cast").toBe(200);
  /* A client link on a private board is its OWNER's alone (owner, 14 Oct): an admin is answered as for a production that is not saved, and no link is made. */
  expect(await asking(admin, () => reviewLinks.POST(json("POST", { projectId: privateProject }), undefined as never)), "an admin makes no client link on a member's board").toEqual(await asking(admin, () => reviewLinks.POST(json("POST", { projectId: unknownId }), undefined as never)));
  /* The same admin in ANOTHER workspace finds no such board for any of it. */
  const elsewhere = workspace(`ps-d2-${run}`);
  await tenant.runInTenant(elsewhere, async () => { await database.ready(); }, { user: user("u_admin", "admin") });
  who = admin;
  for (const [label, call] of [
    ["treatment", () => treatment.GET(url(`/api/atomik/treatment?projectId=${privateProject}`), undefined as never)],
    ["client link", () => reviewLinks.POST(json("POST", { projectId: privateProject }), undefined as never)],
    ["cast write", () => cast.POST(json("POST", { projectId: privateProject, name: "Hijack" }), undefined as never)],
  ] as const) {
    const refused = await tenant.runInTenant(elsewhere, async () => { try { return answer(await call()); } catch (e) { return ["threw", String((e as Error).message)] as const; } }, { user: user("u_admin", "admin") });
    expect(JSON.stringify(refused), `another workspace's admin: ${label}`).not.toMatch(/Secret|AdminCast|"url"/);
    expect([404, 200]).toContain(refused[0]);
  }
  /* Shared: view-only, so reads open to a teammate and every write still does not. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  expect(JSON.stringify(await asking(as("u_mate"), () => cast.GET(url(`/api/cast?projectId=${privateProject}`), undefined as never)))).toContain("SecretCast");
  expect(JSON.stringify(await asking(as("u_mate"), () => treatment.GET(url(`/api/atomik/treatment?projectId=${privateProject}`), undefined as never)))).toContain("Secret logline");
  expect((await asking(as("u_mate"), () => cast.POST(json("POST", { projectId: privateProject, name: "Hijack" }), undefined as never)))[0]).not.toBe(200);
  /* A shared board is not private: it keeps today's rule (owner, 14 Oct, 22:50), an admin makes its client link and a member does not; the same-answer rule is for a private board and is asserted above. */
  expect((await asking(as("u_admin", "admin"), () => reviewLinks.POST(json("POST", { projectId: privateProject }), undefined as never)))[0], "an admin makes a shared board's client link").toBe(201);
  expect((await asking(as("u_mate"), () => reviewLinks.POST(json("POST", { projectId: privateProject }), undefined as never)))[0], "a member does not").toBe(403);
  /* The owner (an admin of the workspace who owns the board) makes it. */
  expect((await asking({ ...as("u_owner"), user: { ...as("u_owner").user, role: "admin" } }, () => reviewLinks.POST(json("POST", { projectId: privateProject }), undefined as never)))[0], "the owner makes their board's client link").toBe(201);
});

test("a render admitted with a claim on a private board writes no hold, claim row or reservation, and answers as for an unknown project", async () => {
  const ws = workspace(`ps-e-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  const { executeGenerationAdmission } = await import("../../lib/generationAdmission");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  /* The reservation table is created by the first render that reserves; make sure it exists, so a count that fails is an error and not a zero. */
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_pse_${run}`, ws.id, 5000, "Test", Date.now()] });
  const counts = async () => tenant.runInTenant(ws, async () => ({
    generations: Number((await database.db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n),
    meter: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
    reservations: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
    held: Number((await database.db().execute("SELECT COUNT(*) AS n FROM generations WHERE status='held'")).rows[0].n),
  }), { user: user("u_owner") });
  const body = (projectId: string) => ({ model: "grok-imagine-video", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, projectId, maxCredits: 5000 });
  let key = 0;
  const admit = async (actor: ReturnType<typeof as>, projectId: string) =>
    tenant.runInTenant(ws, async () => {
      await database.ready();
      const r = await executeGenerationAdmission(body(projectId), actor as never, { defer: async () => {}, requestClaim: { userId: actor.user.id, key: `claim-${run}-${++key}` } as never });
      return [r.status, r.body] as const;
    }, { user: actor.user, token: actor.token as never });
  const unknown = await admit(as("u_mate"), "prj_wb_doesnotexist0000000000");
  expect(unknown).toEqual([404, { error: "No such project." }]);
  const before = await counts();
  for (const actor of [as("u_mate"), as("u_admin", "admin"), as("u_mate", "member", true)]) expect(await admit(actor, privateProject), actor.user.id).toEqual(unknown);
  expect(await counts(), "no take, hold, meter row or reservation was written").toEqual(before);
});

test("the routes that gate who may change work ask reach first: a private board's shot, take, project list and production answer exactly as an unknown id does, for a teammate, an admin and a token; where it can be reached the work rules still refuse", async () => {
  const ws = workspace(`ps-f-${run}`);
  const { tenant, database, privateProject } = await fixture(ws);
  let who = as("u_owner");
  const shotRoute = loadRoute<typeof import("../../app/api/shots/[id]/route")>("app/api/shots/[id]/route.ts", () => who);
  const reorder = loadRoute<typeof import("../../app/api/shots/reorder/route")>("app/api/shots/reorder/route.ts", () => who);
  const sync = loadRoute<typeof import("../../app/api/shots/sync/route")>("app/api/shots/sync/route.ts", () => who);
  const jobs = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => who);
  const productions = loadRoute<typeof import("../../app/api/productions/[id]/route")>("app/api/productions/[id]/route.ts", () => who);
  const unknownProject = "prj_wb_doesnotexist0000000000", unknownShot = "shot_doesnotexist", unknownTake = "gen_doesnotexist", unknownProduction = "prod_doesnotexist";
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    await db.execute({ sql: "INSERT INTO productions(id,name,created_at) VALUES('prod_priv','Private production',0),('prod_plain','Plain production',0)", args: [] });
    await db.execute({ sql: "UPDATE projects SET production_id='prod_priv' WHERE id=?", args: [privateProject] });
    await db.execute({ sql: "UPDATE projects SET production_id='prod_plain' WHERE id='prod_open'", args: [] });
    await db.execute({ sql: "UPDATE shots SET created_by='u_mate' WHERE id=?", args: [`shot_priv_${run}`] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,setup,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)", args: [`shot_mine_${run}`, "prod_open", "SH020", "Mine", "", "{}", "u_mate"] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,setup,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)", args: [`shot_theirs_${run}`, "prod_open", "SH030", "Theirs", "", "{}", "u_owner"] });
    for (const [id, project, by] of [[`gen_priv_${run}`, privateProject, "u_mate"], [`gen_mine_${run}`, "prod_open", "u_mate"], [`gen_theirs_${run}`, "prod_open", "u_owner"]])
      await db.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url) VALUES(?,'m','p','{}','succeeded',1,1,'image','A take',0,?,?,?)", args: [id, by, project, `/api/media/${id}`] });
  }, { user: user("u_owner") });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const req = (method: string, body?: unknown) => new Request("https://particl.test/x", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  /* Timestamps differ by run; the rest of an answer is compared whole. */
  const answer = async (res: Response) => { const body = await res.json().catch(() => null) as Record<string, unknown> | null; if (body) delete body.at; return [res.status, body] as const; };
  const asking = (actor: ReturnType<typeof as>, fn: () => Promise<Response>) => { who = actor; return tenant.runInTenant(ws, async () => { try { return answer(await fn()); } catch (e) { return ["threw", String((e as Error).message)] as const; } }, { user: actor.user, token: actor.token as never }); };
  const rows = (sql: string, args: unknown[] = []) => tenant.runInTenant(ws, async () => (await database.db().execute({ sql, args: args as never })).rows, { user: user("u_owner") });
  const people = [as("u_mate"), as("u_mate", "member", true)];
  const priv = { shot: `shot_priv_${run}`, take: `gen_priv_${run}` }, mine = { shot: `shot_mine_${run}`, take: `gen_mine_${run}` }, theirs = { shot: `shot_theirs_${run}`, take: `gen_theirs_${run}` };

  for (const actor of people) {
    const sees = (label: string, a: () => Promise<readonly [unknown, unknown]>, b: () => Promise<readonly [unknown, unknown]>) =>
      a().then(async (got) => expect(got, `${actor.user.id}${actor.token ? " token" : ""}: ${label}`).toEqual(await b()));
    const unknown404 = await asking(actor, () => shotRoute.PATCH(req("PATCH", { title: "x" }), ctx(unknownShot)));
    expect(unknown404, "an unknown shot").toEqual([404, { error: "No such shot." }]);
    /* The shot itself: change, move, delete. */
    await sees("shot PATCH", () => asking(actor, () => shotRoute.PATCH(req("PATCH", { title: "Hijack" }), ctx(priv.shot))), () => asking(actor, () => shotRoute.PATCH(req("PATCH", { title: "Hijack" }), ctx(unknownShot))));
    await sees("shot DELETE", () => asking(actor, () => shotRoute.DELETE(req("DELETE"), ctx(priv.shot))), () => asking(actor, () => shotRoute.DELETE(req("DELETE"), ctx(unknownShot))));
    /* Moving the actor's own shot INTO a private board, or into a project that is not there. */
    await sees("shot moved into the board", () => asking(actor, () => shotRoute.PATCH(req("PATCH", { projectId: privateProject }), ctx(mine.shot))), () => asking(actor, () => shotRoute.PATCH(req("PATCH", { projectId: unknownProject }), ctx(mine.shot))));
    expect(await asking(actor, () => shotRoute.PATCH(req("PATCH", { projectId: privateProject }), ctx(mine.shot)))).toEqual([404, { error: "No such project." }]);
    /* The order of a board's shots, and sending its list. */
    await sees("reorder", () => asking(actor, () => reorder.POST(req("POST", { projectId: privateProject, ids: [priv.shot] }), ctx(""))), () => asking(actor, () => reorder.POST(req("POST", { projectId: unknownProject, ids: [priv.shot] }), ctx(""))));
    await sees("sync", () => asking(actor, () => sync.POST(req("POST", { projectId: privateProject }), ctx(""))), () => asking(actor, () => sync.POST(req("POST", { projectId: unknownProject }), ctx(""))));
    /* The take: change, trash, delete, review, and moving one of the actor's own into a board or against a shot of one. */
    for (const body of [{ title: "Hijack" }, { reviewState: "approved" }, { trashed: true }, { projectId: null }, { useAs: "first" }])
      await sees(`take PATCH ${JSON.stringify(body)}`, () => asking(actor, () => jobs.PATCH(req("PATCH", body), ctx(priv.take))), () => asking(actor, () => jobs.PATCH(req("PATCH", body), ctx(unknownTake))));
    await sees("take DELETE", () => asking(actor, () => jobs.DELETE(req("DELETE"), ctx(priv.take))), () => asking(actor, () => jobs.DELETE(req("DELETE"), ctx(unknownTake))));
    await sees("take moved into the board", () => asking(actor, () => jobs.PATCH(req("PATCH", { projectId: privateProject }), ctx(mine.take))), () => asking(actor, () => jobs.PATCH(req("PATCH", { projectId: unknownProject }), ctx(mine.take))));
    expect(await asking(actor, () => jobs.PATCH(req("PATCH", { projectId: privateProject }), ctx(mine.take)))).toEqual([404, { error: "No such project." }]);
    await sees("take filed against the board's shot", () => asking(actor, () => jobs.PATCH(req("PATCH", { shotId: priv.shot }), ctx(mine.take))), () => asking(actor, () => jobs.PATCH(req("PATCH", { shotId: unknownShot }), ctx(mine.take))));
    /* A title sent with a shot that is not there, or one in a private board: the same answer, and the title did not land. */
    const titleOf = async () => String((await rows("SELECT title FROM generations WHERE id=?", [mine.take]))[0].title);
    const before = await titleOf();
    const unknownShotAnswer = await asking(actor, () => jobs.PATCH(req("PATCH", { title: `Sneak ${actor.user.id}`, shotId: unknownShot }), ctx(mine.take)));
    expect(unknownShotAnswer).toEqual([404, { error: "That shot is gone." }]);
    expect(await titleOf(), "the title did not land with an unknown shot").toBe(before);
    expect(await asking(actor, () => jobs.PATCH(req("PATCH", { title: `Sneak ${actor.user.id}`, shotId: priv.shot }), ctx(mine.take)))).toEqual(unknownShotAnswer);
    expect(await titleOf(), "the title did not land with a private shot").toBe(before);
    /* The production over a private board. */
    await sees("production PATCH", () => asking(actor, () => productions.PATCH(req("PATCH", { name: "Hijack" }), ctx("prod_priv"))), () => asking(actor, () => productions.PATCH(req("PATCH", { name: "Hijack" }), ctx(unknownProduction))));
    expect(await asking(actor, () => productions.PATCH(req("PATCH", { name: "Hijack" }), ctx("prod_priv")))).toEqual([404, { error: "No such production." }]);
  }
  /* Nothing was written: the private shot, take and production are as they were, and nothing landed in the board. */
  expect((await rows("SELECT title FROM shots WHERE id=?", [priv.shot]))[0].title).toBe("Secret title");
  expect(await rows("SELECT id FROM shots WHERE id=?", [priv.shot])).toHaveLength(1);
  expect(await rows("SELECT id FROM generations WHERE id=? AND deleted=0 AND title='A take'", [priv.take])).toHaveLength(1);
  expect((await rows("SELECT name FROM productions WHERE id='prod_priv'"))[0].name).toBe("Private production");
  expect(await rows("SELECT id FROM shots WHERE project_id=? AND id<>?", [privateProject, priv.shot])).toHaveLength(0);
  expect(await rows("SELECT id FROM generations WHERE project_id=? AND id<>?", [privateProject, priv.take])).toHaveLength(0);
  expect((await rows("SELECT project_id FROM shots WHERE id=?", [mine.shot]))[0].project_id, "the moved shot stayed").toBe("prod_open");

  /* The owner still does all of it on their own board. */
  expect((await asking(as("u_owner"), () => shotRoute.PATCH(req("PATCH", { title: "Renamed" }), ctx(priv.shot))))[0]).toBe(200);
  expect((await asking(as("u_owner"), () => productions.PATCH(req("PATCH", { name: "Renamed" }), ctx("prod_priv"))))[0]).toBe(200);
  /* Where the board CAN be reached, the work rules still refuse someone else's work in their own words (lib/workAccess.ts). */
  const refused = await asking(as("u_mate"), () => shotRoute.PATCH(req("PATCH", { title: "Hijack" }), ctx(theirs.shot)));
  expect(refused[0]).toBe(403);
  expect(JSON.stringify(refused[1])).toContain("someone else's work");
  expect((await asking(as("u_mate"), () => jobs.PATCH(req("PATCH", { title: "Hijack" }), ctx(theirs.take))))[0]).toBe(403);
  expect((await asking(as("u_mate"), () => jobs.PATCH(req("PATCH", { title: "Mine" }), ctx(mine.take))))[0], "their own take, in a project they can reach").toBe(200);
  expect((await asking(as("u_mate"), () => productions.PATCH(req("PATCH", { name: "Hijack" }), ctx("prod_plain"))))[0], "a production of no one's board is an admin's").toBe(403);
  expect((await asking(as("u_admin", "admin"), () => productions.PATCH(req("PATCH", { name: "Renamed" }), ctx("prod_plain"))))[0]).toBe(200);
  /* An admin of this workspace reaches the board (owner, 13 Oct: any board in the workspace is theirs to open): change, move, review, trash, production. */
  const admin = as("u_admin", "admin");
  const adminDone = async (label: string, call: () => Promise<Response>) => expect((await asking(admin, call))[0], `u_admin: ${label}`).toBe(200);
  await adminDone("shot PATCH", () => shotRoute.PATCH(req("PATCH", { title: "Admin retitle" }), ctx(priv.shot)));
  await adminDone("shot moved into the board", () => shotRoute.PATCH(req("PATCH", { projectId: privateProject }), ctx(mine.shot)));
  await adminDone("reorder", () => reorder.POST(req("POST", { projectId: privateProject, ids: [priv.shot] }), ctx("")));
  await adminDone("sync", () => sync.POST(req("POST", { projectId: privateProject }), ctx("")));
  await adminDone("take PATCH approve", () => jobs.PATCH(req("PATCH", { reviewState: "approved" }), ctx(priv.take)));
  await adminDone("take PATCH trash", () => jobs.PATCH(req("PATCH", { trashed: true }), ctx(priv.take)));
  await adminDone("take moved into the board", () => jobs.PATCH(req("PATCH", { projectId: privateProject }), ctx(mine.take)));
  await adminDone("production PATCH", () => productions.PATCH(req("PATCH", { name: "Admin rename" }), ctx("prod_priv")));
  expect((await rows("SELECT title FROM shots WHERE id=?", [priv.shot]))[0].title, "the admin's change landed").toBe("Admin retitle");
  /* Another workspace's admin finds none of it: the same ids are no shot, take or production there. */
  const elsewhere = workspace(`ps-f2-${run}`);
  await tenant.runInTenant(elsewhere, async () => { await database.ready(); }, { user: user("u_admin", "admin") });
  who = admin;
  const askingElsewhere = (fn: () => Promise<Response>) => tenant.runInTenant(elsewhere, async () => { try { return answer(await fn()); } catch (e) { return ["threw", String((e as Error).message)] as const; } }, { user: admin.user });
  expect(await askingElsewhere(() => shotRoute.PATCH(req("PATCH", { title: "Hijack" }), ctx(priv.shot))), "another workspace's admin: shot PATCH").toEqual([404, { error: "No such shot." }]);
  expect(await askingElsewhere(() => productions.PATCH(req("PATCH", { name: "Hijack" }), ctx("prod_priv"))), "another workspace's admin: production PATCH").toEqual([404, { error: "No such production." }]);
  expect((await rows("SELECT title FROM shots WHERE id=?", [priv.shot]))[0].title).toBe("Admin retitle");
  /* Shared, the board is to look at: not to change by a teammate; an admin still may. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE owner='u_owner'", args: [] }), { user: user("u_owner") });
  expect(await asking(as("u_mate"), () => shotRoute.PATCH(req("PATCH", { title: "Hijack" }), ctx(priv.shot))), "a member on a shared board").toEqual([404, { error: "No such shot." }]);
  await adminDone("shot PATCH on a shared board", () => shotRoute.PATCH(req("PATCH", { title: "Admin again" }), ctx(priv.shot)));
});
