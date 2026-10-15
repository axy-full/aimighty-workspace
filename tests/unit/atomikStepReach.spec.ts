import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A render filed from an Atomik step goes into its chat's project (lib/atomikAccess.ts claimedStepFiling), and the chat's maker names that project. It is checked as the maker's board
 * to file into, whoever approves (lib/generationAdmission.ts): a member or an admin cannot make a chat on someone else's private board and have its step renders filed and charged
 * there; an admin approving a member's own step still files into the member's own board (owner, 13 Oct); and a chat made or patched with a project the person may not file into stores
 * none, with the same answer for a private board and an id that is none. Real temporary databases; the engine is mocked; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-step-reach-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
const as = (id: string, role: "admin" | "member" = "member") => ({ user: user(id, role) });

async function fixture(name: string) {
  const ws = workspace(`${name}-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_${name}_${run}`, ws.id, 5000, "Test", Date.now()] });
  const boardOf = (owner: string) => draft.mappedId("prj_wb_", ws.id, owner, "d1");
  const ghost = draft.mappedId("prj_wb_", ws.id, "u_nobody", "d9");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const owner of ["u_member", "u_other"]) {
      await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [boardOf(owner), `${owner}'s board`] });
      await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${owner}:d1`, owner, "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: boardOf(owner) })] });
    }
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('proj_plain','A shared production',0)", args: [] });
    /* chat, creator, project, step, who claimed it */
    const rows: [string, string, string | null, string, string][] = [
      ["ach_own", "u_member", boardOf("u_member"), "st_own", "u_member"],
      ["ach_cross", "u_member", boardOf("u_other"), "st_cross", "u_member"],
      ["ach_admin_cross", "u_admin", boardOf("u_member"), "st_admin_cross", "u_admin"],
      ["ach_for_admin", "u_member", boardOf("u_member"), "st_apprv", "u_admin"],
      ["ach_plain", "u_member", "proj_plain", "st_plain", "u_member"],
      ["ach_ghost", "u_member", ghost, "st_ghost", "u_member"],
    ];
    for (const [chat, by, project, step, claimed] of rows) {
      await db.execute({ sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES(?,?,'Chat','waiting',?,1,1)", args: [chat, project, by] });
      await db.execute({ sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,?,'assistant','A plan',1)", args: [`m_${chat}`, chat] });
      await db.execute({ sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,claimed_by,request_key,est_cost_usd,created_at,updated_at) VALUES(?,?,?,0,'video','A step','A tree in rain','grok-imagine-video',?,'running',?,?,1,1,1)", args: [step, chat, `m_${chat}`, JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 }), claimed, `atomik-step:${step}`] });
    }
  }, { user: user("u_member") });
  return { ws, tenant, database, boardOf, ghost, platformDb };
}

test("a step's render is filed only where the chat's maker may file: someone else's private board is refused for a member and an admin alike, with nothing held, reserved or metered; their own board, and an admin approving a member's own step there, still work", async () => {
  const f = await fixture("reach");
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const body = (extra: Record<string, unknown>) => ({ model: "grok-imagine-video", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, ...extra });
  const ask = (actor: ReturnType<typeof as>, step: string) =>
    f.tenant.runInTenant(f.ws, async () => { await f.database.ready(); const r = await prepareGeneration(body({ atomikStepId: step }), actor as never); return r.ok ? ({ ok: true, project: (r.value.request as { projectId?: string }).projectId }) : ({ ok: false, status: r.status, body: r.body }); }, { user: actor.user });
  const money = () => f.tenant.runInTenant(f.ws, async () => ({
    held: Number((await f.database.db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n),
    meter: Number((await f.platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [f.ws.id] })).rows[0].n),
    reservations: Number((await f.platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [f.ws.id] })).rows[0].n),
  }), { user: user("u_member") });
  const before = await money();
  const refused = { ok: false, status: 404, body: { error: "No such project." } };
  /* A member's chat on someone else's private board, and an admin's chat on the member's: refused. */
  expect(await ask(as("u_member"), "st_cross")).toEqual(refused);
  expect(await ask(as("u_admin", "admin"), "st_admin_cross")).toEqual(refused);
  /* A board that is none (a private-board id nobody owns) is refused with the very same answer: nothing says whether it exists. */
  expect(await ask(as("u_member"), "st_ghost")).toEqual(refused);
  expect(await money(), "nothing was held, reserved or metered").toEqual(before);
  /* The maker's own board works; so does a shared production; so does an admin approving the member's own step on the member's own board (owner, 13 Oct). */
  expect(await ask(as("u_member"), "st_own")).toMatchObject({ ok: true, project: f.boardOf("u_member") });
  expect(await ask(as("u_member"), "st_plain")).toMatchObject({ ok: true, project: "proj_plain" });
  expect(await ask(as("u_admin", "admin"), "st_apprv")).toMatchObject({ ok: true, project: f.boardOf("u_member") });
});

function loadRoute<T>(file: string, who: () => { user: ReturnType<typeof user> }): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => ({ ...who() }), requireUser: async () => ({ ...who() }) },
    "next/server": { ...real("next/server"), after: () => undefined },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

test("a chat made or patched with a project its person may not file into stores none, the same for a private board and an id that is none; their own board and a shared production are kept", async () => {
  const f = await fixture("create");
  let who = as("u_member");
  const create = loadRoute<typeof import("../../app/api/atomik/route")>("app/api/atomik/route.ts", () => who);
  const patch = loadRoute<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts", () => who);
  const json = (value: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const projectOf = (chat: string) => f.tenant.runInTenant(f.ws, async () => (await f.database.db().execute({ sql: "SELECT project_id FROM atomik_chats WHERE id=?", args: [chat] })).rows[0]?.project_id ?? null, { user: who.user });
  const made = async (projectId: unknown) => {
    const res = await f.tenant.runInTenant(f.ws, () => create.POST(new Request("https://particl.test/api/atomik", json({ projectId })) as never, undefined as never), { user: who.user });
    expect(res.status).toBe(200);
    return projectOf(((await res.json()) as { id: string }).id);
  };
  /* Created. */
  expect(await made(f.boardOf("u_member"))).toBe(f.boardOf("u_member"));
  expect(await made("proj_plain")).toBe("proj_plain");
  expect(await made(f.boardOf("u_other"))).toBeNull();
  expect(await made(f.ghost)).toBeNull();
  expect(await made(7)).toBeNull();
  who = as("u_admin", "admin");
  expect(await made(f.boardOf("u_member")), "an admin does not reach a member's private board to file into it").toBeNull();
  /* Patched: a chat of the person's own. */
  who = as("u_member");
  const patched = async (chat: string, projectId: unknown) => {
    const res = await f.tenant.runInTenant(f.ws, () => patch.PATCH(new Request("https://particl.test/api/atomik/x", { ...json({ projectId }), method: "PATCH" }) as never, { params: Promise.resolve({ id: chat }) }), { user: who.user });
    expect(res.status).toBe(200);
    return projectOf(chat);
  };
  expect(await patched("ach_plain", f.boardOf("u_other"))).toBeNull();
  expect(await patched("ach_plain", "proj_plain")).toBe("proj_plain");
  expect(await patched("ach_plain", f.ghost)).toBeNull();
  expect(await patched("ach_plain", f.boardOf("u_member"))).toBe(f.boardOf("u_member"));
  expect(await patched("ach_plain", "")).toBeNull();
});
