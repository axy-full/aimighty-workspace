import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A chat and its steps file under a project its person may file into. A render request that names an Atomik step (`atomikStepId`, the path an admin used to approve a
 * member's step, owner 13 Oct) is refused for everyone since 21 Oct 2026 (owner: "the admin approval rule is retired; every member approves their own spend with their own
 * tap on the quote"): the same "That step is gone." whatever board it is on, with nothing held, reserved or metered. A chat made or patched with a project the person may not
 * file into stores none, with the same answer for a private board and an id that is none. Real temporary databases; the engine is mocked; nothing is sent or spent.
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
    for (const owner of ["u_member", "u_other", "u_sharer"]) {
      await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [boardOf(owner), `${owner}'s board`] });
      await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${owner}:d1`, owner, "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: boardOf(owner), ...(owner === "u_sharer" ? { teamShared: true } : {}) })] });
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
      ["ach_shared", "u_member", boardOf("u_sharer"), "st_shared", "u_member"],
    ];
    for (const [chat, by, project, step, claimed] of rows) {
      await db.execute({ sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES(?,?,'Chat','waiting',?,1,1)", args: [chat, project, by] });
      await db.execute({ sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,?,'assistant','A plan',1)", args: [`m_${chat}`, chat] });
      await db.execute({ sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,claimed_by,request_key,est_cost_usd,created_at,updated_at) VALUES(?,?,?,0,'video','A step','A tree in rain','grok-imagine-video',?,'running',?,?,1,1,1)", args: [step, chat, `m_${chat}`, JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 }), claimed, `atomik-step:${step}`] });
    }
  }, { user: user("u_member") });
  return { ws, tenant, database, boardOf, ghost, platformDb };
}

test("a render request naming a step is refused for a member and an admin alike, on any board, with one answer and nothing held, reserved or metered", async () => {
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
  const gone = { ok: false, status: 404, body: { error: "That step is gone." } };
  /* Someone else's private board, a board that is none, a teammate's shared board, the maker's own board, a shared production, and an admin's claim of a member's step. */
  expect(await ask(as("u_member"), "st_cross")).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), "st_admin_cross")).toEqual(gone);
  expect(await ask(as("u_member"), "st_ghost")).toEqual(gone);
  expect(await ask(as("u_member"), "st_shared")).toEqual(gone);
  expect(await ask(as("u_member"), "st_own")).toEqual(gone);
  expect(await ask(as("u_member"), "st_plain")).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), "st_apprv")).toEqual(gone);
  expect(await money(), "nothing was held, reserved or metered").toEqual(before);
});

function loadRoute<T>(file: string, who: () => { user: ReturnType<typeof user> }, extra: Record<string, unknown> = {}): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => ({ ...who() }), requireUser: async () => ({ ...who() }) },
    "next/server": { ...real("next/server"), after: () => undefined },
    ...extra,
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

test("a chat made or patched with a project its person may not even read stores none, the same for a private board and an id that is none; their own board, a teammate's shared board and a shared production are kept", async () => {
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
  expect(await made(f.boardOf("u_sharer")), "a teammate's shared board is readable, so the chat keeps it (filing into it is refused at admission)").toBe(f.boardOf("u_sharer"));
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
  expect(await patched("ach_plain", f.boardOf("u_sharer"))).toBe(f.boardOf("u_sharer"));
  expect(await patched("ach_plain", f.ghost)).toBeNull();
  expect(await patched("ach_plain", f.boardOf("u_member"))).toBe(f.boardOf("u_member"));
  expect(await patched("ach_plain", "")).toBeNull();
});

test("a turn reads a board its person may READ (their own, a teammate's shared board) for context, and spends, files steps and writes memory only under a board they may FILE into: a view-only shared board gives context and no spend; someone else's private board, an unknown id and an admin on a member's private board give neither", async () => {
  const f = await fixture("turn");
  let who = as("u_member");
  const seen: { context: unknown[]; memory: unknown[]; library: unknown[]; spend: unknown[]; viewOnly: unknown[] } = { context: [], memory: [], library: [], spend: [], viewOnly: [] };
  const atomik = await import("../../lib/atomik"), memory = await import("../../lib/atomikMemory"), library = await import("../../lib/atomikLibrary");
  const turn = loadRoute<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts", () => who, {
    "@/lib/atomik": { ...atomik, projectContext: async (project: string | null) => { seen.context.push(project); return ""; }, runTurn: async (_id: string, opts: { projectId: string | null; viewOnly?: boolean }) => { seen.spend.push(opts.projectId); seen.viewOnly.push(opts.viewOnly); } },
    "@/lib/atomikMemory": { ...memory, plannerMemoryText: async (opts: { projectId: string | null }) => { seen.memory.push(opts.projectId); return ""; } },
    "@/lib/atomikLibrary": { ...library, plannerInputs: async (_person: string, project: string | null) => { seen.library.push(project); return await library.plannerInputs(_person, project); } },
  });
  const projectOf = (chat: string) => f.tenant.runInTenant(f.ws, async () => (await f.database.db().execute({ sql: "SELECT project_id FROM atomik_chats WHERE id=?", args: [chat] })).rows[0]?.project_id ?? null, { user: who.user });
  const say = async (chat: string) => {
    for (const key of Object.keys(seen) as (keyof typeof seen)[]) seen[key].length = 0;
    const res = await f.tenant.runInTenant(f.ws, () => turn.POST(new Request("https://particl.test/api/atomik/x", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `turn-${chat}-${run}` }, body: JSON.stringify({ text: "Plan it", maxCredits: 10000 }) }) as never, { params: Promise.resolve({ id: chat }) }), { user: who.user });
    expect(res.status, await res.clone().text()).toBe(200);
    return { context: seen.context[0] ?? null, memory: seen.memory[0] ?? null, library: seen.library[0] ?? null, spend: seen.spend[0] ?? null, viewOnly: seen.viewOnly[0] === true, stored: await projectOf(chat) };
  };
  const own = f.boardOf("u_member"), shared = f.boardOf("u_sharer");
  /* Their own board: context, and spend, filing and memory under it. */
  expect(await say("ach_own")).toEqual({ context: own, memory: own, library: own, spend: own, viewOnly: false, stored: own });
  /* A shared production that is not a private board: the same. */
  expect(await say("ach_plain")).toEqual({ context: "proj_plain", memory: "proj_plain", library: "proj_plain", spend: "proj_plain", viewOnly: false, stored: "proj_plain" });
  /* A teammate's shared, view-only board: context and memory READ it; nothing is spent, proposed for or written under it; the chat keeps it. */
  expect(await say("ach_shared")).toEqual({ context: shared, memory: shared, library: null, spend: null, viewOnly: true, stored: shared });
  /* Someone else's private board, and an id that is none: neither, and the chat's project is cleared. */
  expect(await say("ach_cross")).toEqual({ context: null, memory: null, library: null, spend: null, viewOnly: false, stored: null });
  expect(await say("ach_ghost")).toEqual({ context: null, memory: null, library: null, spend: null, viewOnly: false, stored: null });
  /* An admin's existing chat on a member's private board: neither here (an admin's audited read is a separate path). */
  who = as("u_admin", "admin");
  expect(await say("ach_admin_cross")).toEqual({ context: null, memory: null, library: null, spend: null, viewOnly: false, stored: null });
});

test("on a view-only shared board the planner is told and proposes no render steps, and says why in one plain line; the board's context is still read; on the person's own board renders are proposed as before", async () => {
  const f = await fixture("viewonly");
  const who = as("u_member");
  const contexts: string[] = [];
  const atomik = await import("../../lib/atomik");
  const turn = loadRoute<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts", () => who, {
    "@/lib/atomik": { ...atomik, runTurn: (chatId: string, opts: { context?: string }) => { contexts.push(opts.context ?? ""); return atomik.runTurn(chatId, opts as never); } },
  });
  const rowsOf = (sql: string, args: string[]) => f.tenant.runInTenant(f.ws, async () => (await f.database.db().execute({ sql, args })).rows, { user: who.user });
  const say = async (chat: string) => {
    contexts.length = 0;
    const res = await f.tenant.runInTenant(f.ws, () => turn.POST(new Request("https://particl.test/api/atomik/x", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `viewonly-${chat}-${run}` }, body: JSON.stringify({ text: "A tree in the rain, one video", maxCredits: 10000 }) }) as never, { params: Promise.resolve({ id: chat }) }), { user: who.user });
    expect(res.status, await res.clone().text()).toBe(200);
    const reply = (await rowsOf("SELECT id, text FROM atomik_messages WHERE chat_id=? AND role='assistant' AND id <> ? ORDER BY created_at DESC LIMIT 1", [chat, `m_${chat}`]))[0];
    const steps = await rowsOf("SELECT id FROM atomik_steps WHERE chat_id=? AND message_id=?", [chat, String(reply.id)]);
    return { text: String(reply.text), steps: steps.length, context: contexts[0] ?? "" };
  };
  const { VIEW_ONLY_LINE } = atomik;
  const mine = await say("ach_own");
  expect(mine.steps, "renders are proposed on their own board").toBeGreaterThan(0);
  expect(mine.text).not.toContain(VIEW_ONLY_LINE);
  expect(mine.context).not.toContain("view-only");
  const looked = await say("ach_shared");
  expect(looked.steps, "no render step on a view-only board").toBe(0);
  expect(looked.text).toContain(VIEW_ONLY_LINE);
  expect(VIEW_ONLY_LINE).not.toMatch(/gemini|google|claude|gpt|seedance|kling|nano/i);
  /* The planner was told, and the board's own context is still in what it read. */
  expect(looked.context).toContain("view-only");
});
