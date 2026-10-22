import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Until 21 Oct 2026 an admin could render another member's Atomik step, filed into that step's own project from a step the admin had claimed
 * (owner, 13 Oct; the request named only `atomikStepId`). That went with the admin approval rule (owner, 21 Oct 2026: "every member approves
 * their own spend with their own tap on the quote"): a render request naming a step is refused as a missing step, for anyone, before anything
 * is quoted, held, reserved or metered; a claim an admin made before then cannot render through it. Real temporary databases; the engine is
 * mocked; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-step-filing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
const as = (id: string, role: "admin" | "member" = "member", token = false) => ({ user: user(id, role), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null } } : {}) });

test("the render files into the step's own project, under its cap, for the admin who claimed it and for nobody else", async () => {
  const ws = workspace(`sf-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_sf_${run}`, ws.id, 5000, "Test", Date.now()] });
  const board = draft.mappedId("prj_wb_", ws.id, "u_member", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "The member's board"] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_member:d1", "u_member", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: board })] });
    await db.execute({ sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_s',?,'Chat','waiting','u_member',1,1)", args: [board] });
    await db.execute({ sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('ma','ach_s','assistant','A plan',1)", args: [] });
    for (const [id, status, claimedBy] of [["st_run", "running", "u_admin"], ["st_prop", "proposed", null], ["st_other", "running", "u_admin2"]] as const)
      await db.execute({ sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,claimed_by,request_key,est_cost_usd,created_at,updated_at) VALUES(?,?,?,0,'video','A step','A tree in rain','grok-imagine-video',?,?,?,?,1,1,1)", args: [id, "ach_s", "ma", JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 }), status, claimedBy, `atomik-step:${id}`] });
  }, { user: user("u_member") });
  const body = (extra: Record<string, unknown> = {}) => ({ model: "grok-imagine-video", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, ...extra });
  const ask = (actor: ReturnType<typeof as>, extra: Record<string, unknown>) =>
    tenant.runInTenant(ws, async () => { await database.ready(); const r = await prepareGeneration(body(extra), actor as never); return r.ok ? ({ ok: true, project: (r.value.request as { projectId?: string }).projectId, credits: r.value.quote.estimatedCredits }) : ({ ok: false, status: r.status, body: r.body }); }, { user: actor.user, token: actor.token as never });
  const money = () => tenant.runInTenant(ws, async () => ({
    held: Number((await database.db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n),
    meter: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
    reservations: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
  }), { user: user("u_member") });
  const before = await money();
  const gone = { ok: false, status: 404, body: { error: "That step is gone." } };
  /* The admin's own earlier claim (running, not sent), another admin's, an unclaimed step, an unknown one, a member, the step's own person: all gone. */
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_run" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_run", projectId: board })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_prop" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_other" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_nothing" })).toEqual(gone);
  expect(await ask(as("u_mate"), { atomikStepId: "st_run" })).toEqual(gone);
  expect(await ask(as("u_member"), { atomikStepId: "st_prop" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: { $ne: 1 } })).toEqual(gone);
  /* Without the step, the member's private board is still a missing project to the admin: an admin files nothing into it. */
  expect(await ask(as("u_admin", "admin"), { projectId: board })).toEqual({ ok: false, status: 404, body: { error: "No such project." } });
  expect(await money(), "nothing was held, reserved or metered").toEqual(before);
});

function loadRoute<T>(file: string, who: () => { user: ReturnType<typeof user>; token?: unknown }): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => ({ ...who() }), requireUser: async () => ({ ...who() }) },
    "next/server": { after: () => undefined },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

test("through the render route, a request naming a step is refused under any key, and nothing is written, reserved or metered", async () => {
  const ws = workspace(`sf2-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_sf2_${run}`, ws.id, 5000, "Test", Date.now()] });
  const board = draft.mappedId("prj_wb_", ws.id, "u_member", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "The member's board"] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_member:d1", "u_member", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: board })] });
    await db.execute({ sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_s',?,'Chat','waiting','u_member',1,1)", args: [board] });
    await db.execute({ sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('ma','ach_s','assistant','A plan',1)", args: [] });
    /* An admin's claim made before 21 Oct 2026, running and not sent. */
    await db.execute({ sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,claimed_by,request_key,est_cost_usd,created_at,updated_at) VALUES('st_run','ach_s','ma',0,'video','A step','A tree in rain','grok-imagine-video',?,'running','u_admin','atomik-step:st_run',1,1,1)", args: [JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 })] });
  }, { user: user("u_member") });
  const route = loadRoute<typeof import("../../app/api/generate/route")>("app/api/generate/route.ts", () => as("u_admin", "admin"));
  const rows = () => tenant.runInTenant(ws, async () => ({
    gens: (await database.db().execute("SELECT project_id, prompt, model, created_by FROM generations")).rows.map((r) => [r.project_id, r.prompt, r.model, r.created_by]),
    reservations: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
    meter: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
  }), { user: user("u_member") });
  const post = (key: string, extra: Record<string, unknown>) => tenant.runInTenant(ws, async () => {
    await database.ready();
    const res = await route.POST(new Request("https://particl.test/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ model: "grok-imagine-video", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, atomikStepId: "st_run", ...extra }) }), undefined as never);
    return [res.status, await res.json().catch(() => null)] as const;
  }, { user: user("u_admin", "admin") });
  const before = await rows();
  expect(before).toEqual({ gens: [], reservations: 0, meter: 0 });
  /* Under the claim's own key, at a quoted ceiling: refused, nothing written. */
  expect(await post("atomik-step:st_run", { maxCredits: 5000 })).toEqual([404, { error: "That step is gone." }]);
  expect(await rows()).toEqual(before);
  /* Another key, with a project named: the same. */
  expect(await post("some-other-key-0001", { projectId: board })).toEqual([404, { error: "That step is gone." }]);
  expect(await rows()).toEqual(before);
});
