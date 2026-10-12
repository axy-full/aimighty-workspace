import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Atomik chats are their person's (lib/atomikAccess.ts; owner, 12 Oct): the chat and thread lists leave out another person's (and so their waiting flags and
 * numbers), and a chat's read, rename, delete and turn, and a step's read and edit, answer "That chat is gone." / "That step is gone." (404) to anyone else, a
 * member or an admin. The owner reaches their own. The one exception is an admin, for another member's step that needs an admin's tap: its id, title and price only.
 * Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-chat-access-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const T = Date.now().toString(36);
const now = Date.now();
const MODEL = "dreamina-seedance-2-0-260128";
const ws = ((id: string): TenantWorkspace => ({
  id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 4, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
}))(`ws_chatacc${T}`);
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: id === "u_owner", disabled: false, lastSeen: null, createdAt: 0 });
type Who = ReturnType<typeof user>;

let asToken = false;
function loadRoute<T>(file: string, who: () => Who): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: who() }), requireRender: async () => ({ user: who(), ...(asToken ? { token: { id: "tok", name: "t", scope: "render" } } : {}) }), requireSession: async () => ({ user: who() }) },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

test("a chat and its steps are their person's: lists leave others out, every door answers gone, the owner reaches theirs, an admin sees an over-the-line step as a title and a price", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const tenant = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { listChats } = await import("../../lib/atomik");
  const { listThreads } = await import("../../lib/atomikThreads");
  const { savableRuns, draftFromRun, saveSkillFromRun } = await import("../../lib/atomikSkills");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)", args: [`grant_${ws.id}`, ws.id, 5000, 0] });
  let who = user("u_a");
  const R = <T,>(file: string) => loadRoute<T>(file, () => who);
  const chat = R<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts");
  const threadsRoute = R<typeof import("../../app/api/atomik/threads/route")>("app/api/atomik/threads/route.ts");
  const stepRoute = R<typeof import("../../app/api/atomik/steps/[id]/route")>("app/api/atomik/steps/[id]/route.ts");
  const claim = R<typeof import("../../app/api/atomik/steps/[id]/claim/route")>("app/api/atomik/steps/[id]/claim/route.ts");
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const req = (method: string, body?: unknown) => new Request("https://particl.test/x", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  await tenant.runInTenant(ws, async () => {
    await ready();
    const u = (id: string, role: string) => `INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('${id}','${id}@example.invalid','${id}','x','${role}',0)`;
    const mk = (id: string, by: string, usd: number) => [
      { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES(?,'prod_a',?,'waiting',?,?,?)", args: [id, `${id} chat`, by, now - 50_000, now - 40_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,?,'user',?,?)", args: [`mu_${id}`, id, `ask ${id}`, now - 50_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,?,'assistant','A plan',?)", args: [`ma_${id}`, id, now - 45_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,status,est_cost_usd,created_at,updated_at) VALUES(?,?,?,0,'video',?,?,?,'proposed',?,?,?)", args: [`st_${id}`, id, `ma_${id}`, `Step of ${id}`, `prompt ${id}`, MODEL, usd, now - 45_000, now - 45_000] },
    ];
    await db().batch([u("u_owner", "admin"), u("u_admin", "admin"), u("u_a", "member"), u("u_b", "member"),
      { sql: "INSERT INTO projects(id,name,created_at) VALUES('prod_a','P',0)", args: [] },
      ...mk("ach_a", "u_a", 0.5), ...mk("ach_b", "u_b", 0.5), ...mk("ach_big", "u_b", 40)] as never, "write");
  }, { user: user("u_owner", "admin") });
  const answer = async (res: Response) => [res.status, await res.json().catch(() => null)] as const;
  const asking = (actor: Who, fn: () => Promise<Response>) => { who = actor; return tenant.runInTenant(ws, async () => answer(await fn()), { user: actor }); };
  const GONE_CHAT = [404, { error: "That chat is gone." }], GONE_STEP = [404, { error: "That step is gone." }];
  const mate = user("u_a"), other = user("u_b"), admin = user("u_admin", "admin"), owner = user("u_owner", "admin");

  /* Lists: only the viewer's own, so no other's title, number or waiting flag is there. */
  await tenant.runInTenant(ws, async () => {
    expect((await listChats("u_a")).map((c) => c.id)).toEqual(["ach_a"]);
    expect((await listChats("u_admin")).map((c) => c.id), "an admin has none of their own").toEqual([]);
    expect((await listThreads("prod_a", "u_a")).map((t) => t.id)).toEqual(["ach_a"]);
    expect((await listThreads("prod_a", "u_b")).map((t) => [t.id, t.number]).sort()).toEqual([["ach_b", 1], ["ach_big", 2]]);
    expect(await listThreads("prod_a", "u_admin")).toEqual([]);
    expect((await savableRuns("prod_a", "u_a")).map((r) => r.chatId)).toEqual(["ach_a"]);
    expect(await savableRuns("prod_a", "u_admin")).toEqual([]);
  }, { user: owner });
  const threads = await asking(admin, () => threadsRoute.GET(new Request("https://particl.test/api/atomik/threads?projectId=prod_a"), undefined as never));
  expect(threads).toEqual([200, { threads: [] }]);

  /* A chat: read, rename, delete, a turn (even a quote) and, for the skills, a draft and a save. */
  for (const actor of [other, admin, owner]) {
    const label = actor.id;
    expect(await asking(actor, () => chat.GET(req("GET") as never, ctx("ach_a"))), `${label}: read`).toEqual(GONE_CHAT);
    expect(await asking(actor, () => chat.PATCH(req("PATCH", { title: "Hijack" }) as never, ctx("ach_a"))), `${label}: rename`).toEqual(await asking(actor, () => chat.PATCH(req("PATCH", { title: "Hijack" }) as never, ctx("ach_nothing"))));
    expect((await asking(actor, () => chat.PATCH(req("PATCH", { title: "Hijack" }) as never, ctx("ach_a"))))[0]).toBe(404);
    expect(await asking(actor, () => chat.DELETE(req("DELETE") as never, ctx("ach_a"))), `${label}: delete (as an unknown chat is deleted)`).toEqual(await asking(actor, () => chat.DELETE(req("DELETE") as never, ctx("ach_nothing"))));
    expect(await asking(actor, () => chat.POST(req("POST", { text: "Say more", quoteOnly: true }) as never, ctx("ach_a"))), `${label}: a turn`).toEqual(GONE_CHAT);
    expect(await asking(actor, () => chat.POST(req("POST", { text: "Say more" }) as never, ctx("ach_a"))), `${label}: a paid turn`).toEqual(GONE_CHAT);
    await tenant.runInTenant(ws, async () => {
      await expect(draftFromRun("ach_a", actor.id), `${label}: a skill draft`).rejects.toMatchObject({ status: 404 });
      await expect(saveSkillFromRun({ chatId: "ach_a", name: "X", slug: "x" }, actor.id), `${label}: a skill save`).rejects.toMatchObject({ status: 404 });
    }, { user: actor });
    /* A step: read and edit. */
    expect(await asking(actor, () => stepRoute.PATCH(req("PATCH", { status: "rejected" }) as never, ctx("st_ach_a"))), `${label}: a step's edit`).toEqual(GONE_STEP);
  }
  const unknownChat = await asking(admin, () => chat.GET(req("GET") as never, ctx("ach_nothing")));
  expect(unknownChat).toEqual(GONE_CHAT);
  expect(await asking(admin, () => stepRoute.GET(req("GET") as never, ctx("st_nothing")))).toEqual(GONE_STEP);
  /* Nothing of theirs changed. */
  const rows = await tenant.runInTenant(ws, async () => ({
    title: (await db().execute({ sql: "SELECT title, deleted FROM atomik_chats WHERE id='ach_a'", args: [] })).rows[0],
    status: (await db().execute({ sql: "SELECT status FROM atomik_steps WHERE id='st_ach_a'", args: [] })).rows[0].status,
    messages: Number((await db().execute({ sql: "SELECT COUNT(*) AS n FROM atomik_messages WHERE chat_id='ach_a'", args: [] })).rows[0].n),
  }), { user: owner });
  expect(rows).toEqual({ title: { title: "ach_a chat", deleted: 0 }, status: "proposed", messages: 2 });

  /* Claiming a step approves its spend and hands back its prompt: only the step's person claims it. An admin, a member and a token on another's step, and a step that is not there, all
     get the same 404, and the step stays proposed. */
  const claimed = (actor: Who, step: string, token = false) => { asToken = token; return asking(actor, () => claim.POST(req("POST") as never, ctx(step))).finally(() => { asToken = false; }); };
  const unknownClaim = await claimed(admin, "st_nothing");
  expect(unknownClaim).toEqual(GONE_STEP);
  for (const [label, actor, token] of [["an admin", admin, false], ["a member", other, false], ["the owner of the workspace", owner, false], ["a token of a member", other, true], ["a token of an admin", admin, true]] as const)
    expect(await claimed(actor, "st_ach_a", token), `${label}: claim on another's step`).toEqual(unknownClaim);
  expect(await claimed(admin, "st_ach_big"), "an admin's claim on an over-the-line step waits for the owner").toEqual(unknownClaim);
  const states = await tenant.runInTenant(ws, async () => (await db().execute({ sql: "SELECT id, status, attempt, claimed_by FROM atomik_steps ORDER BY id", args: [] })).rows.map((r) => [r.id, r.status, r.attempt, r.claimed_by]), { user: owner });
  expect(states, "no step was touched").toEqual([["st_ach_a", "proposed", 0, null], ["st_ach_b", "proposed", 0, null], ["st_ach_big", "proposed", 0, null]]);
  /* An unknown id answers a model or effort change as another member's chat does (not a 200). */
  expect(await asking(admin, () => chat.PATCH(req("PATCH", { model: "auto" }) as never, ctx("ach_nothing")))).toEqual([404, { error: "That thread is gone." }]);
  expect(await asking(other, () => chat.PATCH(req("PATCH", { model: "auto" }) as never, ctx("ach_a")))).toEqual([404, { error: "That thread is gone." }]);

  /* The owner reaches theirs. */
  expect((await asking(mate, () => chat.GET(req("GET") as never, ctx("ach_a"))))[0]).toBe(200);
  expect((await asking(mate, () => stepRoute.GET(req("GET") as never, ctx("st_ach_a"))))[0]).toBe(200);
  const mine = await claimed(mate, "st_ach_a");
  expect(mine[0], "the step's own person still claims it").toBe(200);
  expect(mine[1]).toMatchObject({ step: { id: "st_ach_a", status: "running" } });
  expect((await asking(mate, () => chat.PATCH(req("PATCH", { title: "Renamed" }) as never, ctx("ach_a"))))[0]).toBe(200);

  /* An admin: another member's step under the line is gone; over it, only its id, title and price, and nothing to change. */
  expect(await asking(admin, () => stepRoute.GET(req("GET") as never, ctx("st_ach_b")))).toEqual(GONE_STEP);
  const sheet = await asking(admin, () => stepRoute.GET(req("GET") as never, ctx("st_ach_big")));
  expect(sheet[0]).toBe(200);
  expect(Object.keys(sheet[1] as object).sort()).toEqual(["credits", "id", "title"]);
  expect(sheet[1]).toMatchObject({ id: "st_ach_big", title: "Step of ach_big" });
  expect(JSON.stringify(sheet)).not.toMatch(/prompt|ask ach|A plan|chat/);
  expect(await asking(admin, () => stepRoute.PATCH(req("PATCH", { status: "rejected" }) as never, ctx("st_ach_big"))), "not theirs to change").toEqual(GONE_STEP);
  /* A member never gets the sheet, and the chat behind it stays gone to the admin. */
  expect(await asking(mate, () => stepRoute.GET(req("GET") as never, ctx("st_ach_big")))).toEqual(GONE_STEP);
  expect(await asking(admin, () => chat.GET(req("GET") as never, ctx("ach_big")))).toEqual(GONE_CHAT);
  /* The step's own person reads it in full. */
  expect((await asking(other, () => stepRoute.GET(req("GET") as never, ctx("st_ach_big"))))[0]).toBe(200);
});
