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
 * member or an admin. The owner reaches their own. There is no exception for an admin any more (owner, 21 Oct 2026: "the admin approval rule is retired; every
 * member approves their own spend with their own tap on the quote"): until then an admin read and claimed another member's step over the workspace's per-shot cap.
 * A claim an admin made before then is settled or released by its claimant, and the step goes back to its own person.
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

test("a chat and its steps are their person's: lists leave others out, every door answers gone, the owner reaches theirs, and an admin is shown or handed none of a member's steps", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const tenant = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { listChats } = await import("../../lib/atomik");
  const { listThreads } = await import("../../lib/atomikThreads");
  const { savableRuns, draftFromRun, saveSkillFromRun } = await import("../../lib/atomikSkills");
  const { setSetting } = await import("../../lib/settings");
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  const cheap = billCredits(0.5, marginKeyOf("video", MODEL)), big = billCredits(40, marginKeyOf("video", MODEL));
  expect(big).toBeGreaterThan(Math.max(200, cheap + 1));
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)", args: [`grant_${ws.id}`, ws.id, 5000, 0] });
  let who = user("u_a");
  const R = <T,>(file: string) => loadRoute<T>(file, () => who);
  const chat = R<typeof import("../../app/api/atomik/[id]/route")>("app/api/atomik/[id]/route.ts");
  const threadsRoute = R<typeof import("../../app/api/atomik/threads/route")>("app/api/atomik/threads/route.ts");
  const stepRoute = R<typeof import("../../app/api/atomik/steps/[id]/route")>("app/api/atomik/steps/[id]/route.ts");
  const claim = R<typeof import("../../app/api/atomik/steps/[id]/claim/route")>("app/api/atomik/steps/[id]/claim/route.ts");
  const settle = R<typeof import("../../app/api/atomik/steps/[id]/settle/route")>("app/api/atomik/steps/[id]/settle/route.ts");
  const release = R<typeof import("../../app/api/atomik/steps/[id]/release/route")>("app/api/atomik/steps/[id]/release/route.ts");
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
    /* The retired rule as a workspace stored it (the rows stay; nothing reads them): a cap a shot between the cheap steps and the big one (synthetic dollars, made up for this test). */
    await setSetting("approvalRule", "cap", "u_owner");
    await setSetting("shotCapCredits", String(cheap + 1), "u_owner");
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
  for (const [label, actor] of [["an admin", admin], ["a member", other], ["the owner of the workspace", owner]] as const)
    expect(await claimed(actor, "st_ach_a"), `${label}: claim on another's step`).toEqual(unknownClaim);
  /* A token is refused as a person-only press, first (403), whether or not the step exists or is its person's; the step is left as it was. */
  for (const [label, actor] of [["a token of a member", other], ["a token of an admin", admin], ["a token of the step's own person", mate]] as const) {
    expect((await claimed(actor, "st_ach_a", true))[0], `${label}: claim`).toBe(403);
    expect((await claimed(actor, "st_nothing", true))[0], `${label}: claim on an unknown step`).toBe(403);
  }
  /* An admin's claim on another member's step is gone, under the stored cap or over it. */
  expect(await claimed(admin, "st_ach_b"), "an admin on a step under the stored cap").toEqual(unknownClaim);
  expect(await claimed(admin, "st_ach_big"), "an admin on a step over the stored cap").toEqual(unknownClaim);
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

  /* Whatever rule a workspace stored, another member's step is gone to an admin: no sheet, no claim, no change, and its chat stays gone. */
  for (const rule of ["anyone", "cap"]) {
    await tenant.runInTenant(ws, () => setSetting("approvalRule", rule, "u_owner"), { user: owner });
    expect(await asking(admin, () => stepRoute.GET(req("GET") as never, ctx("st_ach_big"))), `${rule}: no sheet of a step over the stored cap`).toEqual(GONE_STEP);
    expect(await asking(admin, () => stepRoute.GET(req("GET") as never, ctx("st_ach_b"))), `${rule}: nor of one under it`).toEqual(GONE_STEP);
    expect(await claimed(admin, "st_ach_big"), `${rule}: an admin cannot claim it`).toEqual(unknownClaim);
    expect(await asking(admin, () => stepRoute.PATCH(req("PATCH", { status: "rejected" }) as never, ctx("st_ach_big"))), `${rule}: nor change it`).toEqual(GONE_STEP);
    expect(await asking(admin, () => chat.GET(req("GET") as never, ctx("ach_big")))).toEqual(GONE_CHAT);
  }
  /* The step's own person reads it in full. */
  expect((await asking(other, () => stepRoute.GET(req("GET") as never, ctx("st_ach_big"))))[0]).toBe(200);

  /* A claim an admin made before 21 Oct 2026 (running, nothing sent): settled from the server's own record by its claimant or its person, never a stranger; released by
     its claimant only, back to its own person, who claims it again under their chat's own key. The admin cannot take it back. */
  await tenant.runInTenant(ws, () => db().execute({ sql: "UPDATE atomik_steps SET status='running', claimed_by='u_admin', attempt=1, request_key='atomik-step:st_ach_big' WHERE id='st_ach_big'", args: [] }), { user: owner });
  const status = () => tenant.runInTenant(ws, async () => (await db().execute({ sql: "SELECT status, gen_id FROM atomik_steps WHERE id='st_ach_big'", args: [] })).rows[0], { user: owner });
  /* Nobody but the step's person writes the step: not the admin who claimed it, whatever they send. */
  for (const body of [{ prompt: "Rewrite" }, { status: "done", genId: "gen_x" }, { status: "failed" }])
    expect(await asking(admin, () => stepRoute.PATCH(req("PATCH", body) as never, ctx("st_ach_big"))), JSON.stringify(body)).toEqual(GONE_STEP);
  expect(await asking(admin, () => settle.POST(req("POST", { status: "done", genId: "gen_x" }) as never, ctx("st_ach_big")))).toEqual([200, { status: "running" }]);
  expect(await asking(admin, () => settle.POST(req("POST") as never, ctx("st_ach_big")))).toEqual([200, { status: "running" }]);
  expect(await status(), "no render: still running, no take").toMatchObject({ status: "running", gen_id: null });
  expect(await asking(other, () => settle.POST(req("POST") as never, ctx("st_ach_big"))), "its person may settle it too").toEqual([200, { status: "running" }]);
  expect(await asking(owner, () => settle.POST(req("POST") as never, ctx("st_ach_big"))), "a stranger (the workspace owner) may not").toEqual(GONE_STEP);
  expect(await asking(owner, () => release.POST(req("POST") as never, ctx("st_ach_big")))).toEqual(GONE_STEP);
  expect(await asking(other, () => release.POST(req("POST") as never, ctx("st_ach_big"))), "its person is not the claimant").toEqual(GONE_STEP);
  expect(await asking(admin, () => release.POST(req("POST") as never, ctx("st_ach_big")))).toEqual([200, { released: true }]);
  expect(await status()).toMatchObject({ status: "proposed", gen_id: null });
  expect(await asking(admin, () => release.POST(req("POST") as never, ctx("st_ach_big"))), "a second release").toEqual(GONE_STEP);
  expect(await claimed(admin, "st_ach_big"), "back to its own person: the admin cannot claim it again").toEqual(unknownClaim);
  const own = await claimed(other, "st_ach_big");
  expect(own[0], "its own person claims it").toBe(200);
  expect((own[1] as { step: { requestKey: string } }).step.requestKey, "under its chat's own key, a new attempt").toBe("atomik-step:ach_big:st_ach_big:2");
  /* The chat stays gone to the admin throughout. */
  expect(await asking(admin, () => chat.GET(req("GET") as never, ctx("ach_big")))).toEqual(GONE_CHAT);
});
