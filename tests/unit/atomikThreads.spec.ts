import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * Atomik threads (lib/atomikThreads.ts): several conversations per project.
 *
 * A thread is an Atomik chat, so nothing moves: a project's conversation from
 * before threads is its thread 1, its steps keep the keys they were approved
 * under, and every link that named it still does. Threads are listed newest
 * activity first, numbered by when each was started, titled by their first ask
 * until someone names them. Each step approval renders under a key naming its
 * thread, so two threads never share one and fencing one never touches the
 * other. Archive hides a thread and keeps all of it; an archived thread plans
 * and approves nothing until it is restored. Memory is the project's, read
 * alike by every thread. Real tenant databases; nothing is rendered or billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-threads-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = "dreamina-seedance-2-5-260628";

function workspace(): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false } as TenantWorkspace;
}
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn);
}
async function sql(statement: string, args: (string | number | null)[] = []) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  return db().execute({ sql: statement, args });
}
const person = (id: string, name: string) => sql(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,'!',0)`, [id, `${id}@example.test`, name]);
const production = (id: string) => sql(`INSERT INTO projects (id, name, created_at) VALUES (?,?,0)`, [id, `Production ${id}`]);
async function chat(f: { id: string; project?: string | null; by?: string; title?: string; status?: string; created: number; updated?: number; deleted?: number }) {
  await sql(`INSERT INTO atomik_chats (id, project_id, title, model, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted)
             VALUES (?,?,?,'auto','ask',?,0,?,?,?,?)`,
  [f.id, f.project === undefined ? "p1" : f.project, f.title ?? "New chat", f.status ?? "waiting", f.by ?? "u_ana", f.created, f.updated ?? f.created, f.deleted ?? 0]);
}
const message = (id: string, chatId: string, role: "user" | "assistant", text: string, at: number) =>
  sql(`INSERT INTO atomik_messages (id, chat_id, role, text, activity, created_at) VALUES (?,?,?,?,'[]',?)`, [id, chatId, role, text, at]);
async function step(f: { id: string; chat: string; status?: string; model?: string; attempt?: number; claimedBy?: string | null; requestKey?: string | null; updatedAt?: number }) {
  const at = f.updatedAt ?? Date.now();
  await sql(`INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, est_cost_usd, created_at, updated_at, attempt, claimed_by, request_key)
             VALUES (?,?,'m',0,'video',?,'A slow push-in on a bottle.',?,'{}','[]',?,NULL,?,?,?,?,?)`,
  [f.id, f.chat, f.id, f.model ?? SEEDANCE, f.status ?? "proposed", at, at, f.attempt ?? 0, f.claimedBy ?? null, f.requestKey ?? null]);
}
async function counts(chatId: string) {
  const one = async (table: string) => Number((await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE chat_id = ?`, [chatId])).rows[0].n);
  return { messages: await one("atomik_messages"), steps: await one("atomik_steps") };
}
const chatRow = async (id: string) => (await sql(`SELECT title, updated_at, deleted, archived_at, archived_by FROM atomik_chats WHERE id = ?`, [id])).rows[0];

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
/** A route, compiled against the real library, run as `user` inside `ws`. */
async function route<T>(file: string, ws: TenantWorkspace, user: TenantUser, overrides: Record<string, unknown> = {}): Promise<T> {
  const auth = await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  return loadRouteModule<T>(file, {
    "@/lib/auth": { ...auth,
      withTenant: (fn: Handler) => (req: Request, ctx: { params: Promise<Record<string, string>> }) => runInTenant(ws, () => fn(req, ctx), { user, workspaces: [{ id: ws.id, slug: ws.slug, name: ws.name, role: "member" }] }),
      requireUser: async () => ({ user }), requireRender: async () => ({ user }) },
    ...overrides,
  });
}
const member = (id: string, name: string) => ({ id, email: `${id}@example.test`, name, role: "member", owner: false, disabled: false, lastSeen: null, createdAt: 0 }) as TenantUser;
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ── The list ────────────────────────────────────────────────────────── */

test("a project's threads: newest activity first, numbered by when each was started, titled by their first ask until named, with who started each and where it stands", async () => {
  const { listThreads } = await import("../../lib/atomikThreads");
  await inTenant(workspace(), async () => {
    await person("u_ana", "Ana"); await person("u_ben", "Ben");
    await chat({ id: "c_ask", created: 1000, updated: 5000 });
    await message("m1", "c_ask", "user", "A bottle spot for the spring launch, thirty seconds, cold open on the harbour", 1000);
    await message("m2", "c_ask", "user", "And a cutdown.", 1100);
    await step({ id: "s_ask", chat: "c_ask" });
    await chat({ id: "c_named", title: "Harbour teaser", status: "running", by: "u_ben", created: 2000, updated: 9000 });
    await message("m3", "c_named", "user", "A teaser.", 2000);
    await chat({ id: "c_new", created: 3000 });
    await chat({ id: "c_run", created: 4000, updated: 7000 });
    await message("m4", "c_run", "user", "Render the wide.", 4000);
    await step({ id: "s_run", chat: "c_run", status: "running" });
    await step({ id: "s_ran", chat: "c_run", status: "done" });
    await chat({ id: "c_done", created: 4500, updated: 6000 });
    await message("m5", "c_done", "user", "One still.", 4500);
    await step({ id: "s_done", chat: "c_done", status: "done" });
    await chat({ id: "c_fail", status: "failed", created: 4600, updated: 4700 });
    await message("m6", "c_fail", "user", "Plan it.", 4600);
    /* A step planned on the connected account never waits for anyone: it moves no thread's state. */
    await chat({ id: "c_acct", created: 4800, updated: 4900 });
    await message("m7", "c_acct", "user", "The old plan.", 4800);
    await step({ id: "s_acct", chat: "c_acct", model: "connected:kling3_0" });
    /* Another project's, an unfiled one, and one hidden by the older soft delete. */
    await chat({ id: "c_other", project: "p2", created: 1, updated: 99_000 });
    await chat({ id: "c_unfiled", project: null, created: 2, updated: 98_000 });
    await chat({ id: "c_deleted", deleted: 1, created: 500, updated: 99_500 });

    const threads = await listThreads("p1", "u_ana");
    expect(threads.map((t) => [t.id, t.number, t.state])).toEqual([
      ["c_named", 2, "planning"], ["c_run", 4, "running"], ["c_done", 5, "done"], ["c_ask", 1, "approval"],
      ["c_acct", 7, "done"], ["c_fail", 6, "stopped"], ["c_new", 3, "new"],
    ]);
    const by = Object.fromEntries(threads.map((t) => [t.id, t]));
    /* Untitled, a thread is called by its first ask (sixty characters at most, the cut marked), and New thread before anyone asks. */
    expect(by.c_ask.title).toBe("A bottle spot for the spring launch, thirty seconds, cold o…");
    expect(by.c_ask.title).toHaveLength(60);
    expect(by.c_named.title).toBe("Harbour teaser");
    expect(by.c_new.title).toBe("New thread");
    expect(by.c_ask).toMatchObject({ projectId: "p1", startedByYou: true, startedByName: "Ana", startedAt: 1000, lastActivityAt: 5000, archivedAt: null });
    expect(by.c_named).toMatchObject({ startedByYou: false, startedByName: "Ben" });
    expect((await listThreads("p2", "u_ana")).map((t) => [t.id, t.number])).toEqual([["c_other", 1]]);
    expect((await listThreads(null, "u_ana")).map((t) => t.id)).toEqual(["c_unfiled"]);
    expect(await listThreads("p1", "u_ana", { archived: true })).toEqual([]);
  });
});

test("starting a thread is starting a chat; its first ask names it until a person does, and a name is not activity", async () => {
  const { createChat, addUserMessage } = await import("../../lib/atomik");
  const { listThreads, renameThread, ThreadError } = await import("../../lib/atomikThreads");
  await inTenant(workspace(), async () => {
    const id = await createChat({ userId: "u_ana", projectId: "p1", model: "auto", agentMode: "ask" });
    expect(await listThreads("p1", "u_ana")).toEqual([expect.objectContaining({ id, number: 1, title: "New thread", state: "new", startedByYou: true })]);
    await addUserMessage(id, "A thirty second teaser for the harbour launch");
    let [thread] = await listThreads("p1", "u_ana");
    expect(thread.title).toBe("A thirty second teaser for the harbour launch");
    const moved = thread.lastActivityAt;
    await renameThread(id, "  Harbour\n teaser\t ");
    [thread] = await listThreads("p1", "u_ana");
    expect(thread.title).toBe("Harbour teaser");
    expect(thread.lastActivityAt).toBe(moved);
    await renameThread(id, "x".repeat(200));
    expect((await chatRow(id)).title).toBe("x".repeat(80));
    await expect(renameThread(id, " \n ")).rejects.toMatchObject({ status: 400, message: "Give the thread a name." });
    await expect(renameThread(id, 42)).rejects.toBeInstanceOf(ThreadError);
    await expect(renameThread("ach_gone", "A name")).rejects.toMatchObject({ status: 404 });
    /* A second thread of the project is its own conversation, numbered after the first. */
    const second = await createChat({ userId: "u_ben", projectId: "p1", model: "auto", agentMode: "ask" });
    expect((await listThreads("p1", "u_ana")).find((t) => t.id === second)).toMatchObject({ number: 2, startedByYou: false });
  });
});

test("a project's conversation from before threads is its thread 1, as it was: listed, picked, its messages and steps intact, its approvals under the keys they had", async () => {
  const ws = workspace();
  /* The tables as they were before threads: no archive columns, no stored render key. */
  const before = createClient({ url: ws.dbUrl });
  await before.batch([
    `CREATE TABLE atomik_chats (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT 'New chat', model TEXT NOT NULL DEFAULT 'auto',
       agent_mode TEXT NOT NULL DEFAULT 'ask', status TEXT NOT NULL DEFAULT 'idle', text_cost_usd REAL NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, effort TEXT)`,
    `CREATE TABLE atomik_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', activity TEXT NOT NULL DEFAULT '[]',
       ask TEXT, worked_ms INTEGER, cost_usd REAL NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, attachments TEXT, effort TEXT)`,
    `CREATE TABLE atomik_steps (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
       kind TEXT NOT NULL DEFAULT 'video', title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}',
       status TEXT NOT NULL DEFAULT 'proposed', gen_id TEXT, est_cost_usd REAL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
       refs TEXT, claimed_by TEXT, attempt INTEGER NOT NULL DEFAULT 0)`,
    { sql: `INSERT INTO atomik_chats (id, project_id, title, status, created_by, created_at, updated_at) VALUES ('c_old','p_old','Bottle spot','waiting','u_ana',1000,2000)`, args: [] },
    { sql: `INSERT INTO atomik_messages (id, chat_id, role, text, created_at) VALUES ('m_ask','c_old','user','A bottle spot for the launch.',1000), ('m_plan','c_old','assistant','Two shots.',1001)`, args: [] },
    { sql: `INSERT INTO atomik_steps (id, chat_id, message_id, position, title, model, status, gen_id, created_at, updated_at, attempt, claimed_by)
            VALUES ('s_done','c_old','m_plan',0,'Wide',?, 'done','gen_done',1001,1500,1,'u_ana'),
                   ('s_taken','c_old','m_plan',1,'Close',?, 'running',NULL,1001,?,1,'u_ana'),
                   ('s_next','c_old','m_plan',2,'Pack shot',?, 'proposed',NULL,1001,1001,0,NULL)`, args: [SEEDANCE, SEEDANCE, Date.now(), SEEDANCE] },
  ], "write");
  before.close();

  const { listThreads } = await import("../../lib/atomikThreads");
  const { listChats, getChat, claimStep } = await import("../../lib/atomik");
  await inTenant(ws, async () => {
    const was = await counts("c_old");
    expect(await listThreads("p_old", "u_ana")).toEqual([expect.objectContaining({
      id: "c_old", projectId: "p_old", number: 1, title: "Bottle spot", state: "approval", startedByYou: true, lastActivityAt: 2000, archivedAt: null,
    })]);
    /* The index still lists it for its production, waiting on its approval, so Atomik opens on it as it always did. */
    expect((await listChats()).find((c) => c.id === "c_old")).toMatchObject({ projectId: "p_old", needsApproval: true, archivedAt: null });
    const loaded = (await getChat("c_old"))!;
    expect(loaded.messages.map((m) => m.text)).toEqual(["A bottle spot for the launch.", "Two shots."]);
    expect(loaded.steps.map((s) => [s.id, s.status])).toEqual([["s_done", "done"], ["s_taken", "running"], ["s_next", "proposed"]]);
    /* An approval taken before threads rendered, and is settled and fenced, under the step's own key. */
    expect(loaded.steps.find((s) => s.id === "s_taken")!.requestKey).toBe("atomik-step:s_taken");
    /* The next approval names the thread. */
    expect((await claimStep("s_next", "u_ana"))!.requestKey).toBe("atomik-step:c_old:s_next");
    expect(await counts("c_old")).toEqual(was);
    expect(await chatRow("c_old")).toMatchObject({ title: "Bottle spot", updated_at: 2000, deleted: 0, archived_at: null, archived_by: null });
  });
});

/* ── Claims and keys ─────────────────────────────────────────────────── */

test("two threads of one project claim their steps under keys of their own: fencing one never touches the other, and an approval taken before threads keeps its key", async () => {
  const { claimStep, getStep, reconcileRunningSteps, STRANDED_CLAIM_MS } = await import("../../lib/atomik");
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  await inTenant(workspace(), async () => {
    await chat({ id: "tA", created: 1, by: "u_ana" });
    await chat({ id: "tB", created: 2, by: "u_ben" });
    await step({ id: "sA", chat: "tA" });
    await step({ id: "sB", chat: "tB" });
    const a = (await claimStep("sA", "u_ana"))!, b = (await claimStep("sB", "u_ben"))!;
    expect([a.requestKey, b.requestKey]).toEqual(["atomik-step:tA:sA", "atomik-step:tB:sB"]);

    /* tA's render never reached the server: two minutes on, reading tA's plan fences its key and proposes the step again. tB is not touched. */
    const later = Date.now() + STRANDED_CLAIM_MS + 1000;
    expect(await reconcileRunningSteps("tA", later)).toBe(1);
    expect(await getStep("sA")).toMatchObject({ status: "proposed" });
    expect(await getStep("sB")).toMatchObject({ status: "running" });
    let ran = 0;
    const body = { prompt: "A slow push-in on a bottle.", model: SEEDANCE, projectId: "p1", maxCredits: 14 };
    const admit = (key: string, user: string) => withGenerationRequest(
      new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
      user, async () => { ran++; return Response.json({ id: `gen_${ran}`, status: "queued" }, { status: 202 }); }, { atomicBinding: true });
    /* tA's delayed render admits nothing; tB's render, under its own key, is admitted once. */
    expect((await admit(a.requestKey!, "u_ana")).status).toBe(409);
    expect((await admit(b.requestKey!, "u_ben")).status).toBe(202);
    expect(ran).toBe(1);
    /* Approving tA's step again takes the next key of its own, still naming the thread. */
    expect((await claimStep("sA", "u_ana"))!.requestKey).toBe("atomik-step:tA:sA:2");

    /* An approval taken before threads (or by a deployment that wrote no key) keeps the step's own key… */
    await step({ id: "sOld", chat: "tA", status: "running", attempt: 1, claimedBy: "u_ana" });
    expect((await getStep("sOld"))!.requestKey).toBe("atomik-step:sOld");
    /* …and a stored key from an earlier approval is not this one's: the key the render went under is. */
    await step({ id: "sMixed", chat: "tA", status: "running", attempt: 2, claimedBy: "u_ana", requestKey: "atomik-step:tA:sMixed" });
    expect((await getStep("sMixed"))!.requestKey).toBe("atomik-step:sMixed:2");
  });
});

/* ── Archive and restore ─────────────────────────────────────────────── */

test("archive hides a thread and keeps every row of it; the archived list says who; restore brings it back in its place", async () => {
  const { listThreads, archiveThread, restoreThread, threadArchived } = await import("../../lib/atomikThreads");
  const { listChats, getChat } = await import("../../lib/atomik");
  await inTenant(workspace(), async () => {
    await person("u_ana", "Ana"); await person("u_ben", "Ben");
    await chat({ id: "tA", created: 1, updated: 5000 });
    await message("mA", "tA", "user", "A harbour at dawn.", 1);
    await step({ id: "sA", chat: "tA", status: "done" });
    await chat({ id: "tB", created: 2, updated: 6000 });
    const was = await counts("tA");

    await archiveThread("tA", "u_ben");
    expect((await listThreads("p1", "u_ana")).map((t) => t.id)).toEqual(["tB"]);
    const shelf = await listThreads("p1", "u_ana", { archived: true });
    expect(shelf).toEqual([expect.objectContaining({ id: "tA", number: 1, title: "A harbour at dawn.", archivedByYou: false, archivedByName: "Ben", lastActivityAt: 5000 })]);
    expect(shelf[0].archivedAt).toEqual(expect.any(Number));
    expect((await listThreads("p1", "u_ben", { archived: true }))[0].archivedByYou).toBe(true);
    /* Hidden from the index too, so Atomik never opens on it by itself; read directly, it says it is archived. */
    expect((await listChats()).map((c) => c.id)).not.toContain("tA");
    expect((await getChat("tA"))!.chat).toMatchObject({ archivedBy: "u_ben", archivedAt: expect.any(Number) });
    expect(await threadArchived("tA")).toBe(true);
    expect(await threadArchived("tB")).toBe(false);
    /* Archiving again changes nothing; a thread that is not there says so. */
    await archiveThread("tA", "u_ana");
    expect((await listThreads("p1", "u_ana", { archived: true }))[0].archivedByName).toBe("Ben");
    await expect(archiveThread("ach_gone", "u_ana")).rejects.toMatchObject({ status: 404, message: "That thread is gone." });
    /* Nothing is deleted, and archiving is not activity. */
    expect(await counts("tA")).toEqual(was);
    expect(await chatRow("tA")).toMatchObject({ deleted: 0, updated_at: 5000 });

    await restoreThread("tA");
    expect((await listThreads("p1", "u_ana")).map((t) => [t.id, t.number])).toEqual([["tB", 2], ["tA", 1]]);
    expect(await chatRow("tA")).toMatchObject({ archived_at: null, archived_by: null, updated_at: 5000, deleted: 0 });
    expect(await listThreads("p1", "u_ana", { archived: true })).toEqual([]);
    await restoreThread("tA");
    await expect(restoreThread("ach_gone")).rejects.toMatchObject({ status: 404 });
  });
});

test("an archived thread plans nothing and approves nothing, and says why; restored, its step is claimed under a key naming it", async () => {
  const { ARCHIVED_NOTE } = await import("../../lib/atomikThreadsText");
  const { archiveThread, restoreThread } = await import("../../lib/atomikThreads");
  const atomik = await import("../../lib/atomik");
  const ws = workspace(), ana = member("u_ana", "Ana");
  await inTenant(ws, async () => {
    await chat({ id: "tA", created: 1, updated: 5000 });
    await message("mA", "tA", "user", "A harbour at dawn.", 1);
    await step({ id: "sA", chat: "tA" });
    await archiveThread("tA", "u_ana");
  });
  const turns: { quoteOnly: boolean }[] = [];
  const chatRoute = await route<{ POST: Handler }>("app/api/atomik/[id]/route.ts", ws, ana, {
    "@/lib/atomik": { ...atomik, projectContext: async () => "",
      runTurn: async (_id: string, opts: { quoteOnly?: boolean }) => { turns.push({ quoteOnly: !!opts.quoteOnly }); return { model: "test/model", effort: "auto", estimateCredits: 2 }; } },
    "@/lib/rules": { effectiveRules: async () => [] },
    "@/lib/platformLayer": { writerRulesByScope: () => "" },
    "@/lib/generationRequests": { withGenerationRequest: async (_req: Request, _user: string, run: () => Promise<Response>) => run(), SpendReservationError: class extends Error {} },
  });
  const ask = (body: Record<string, unknown>) => chatRoute.POST(new Request("https://studio.test/api/atomik/tA", json("POST", body)), { params: Promise.resolve({ id: "tA" }) });
  const turn = await ask({ text: "And a cutdown.", model: "auto", effort: "auto", maxCredits: 2 });
  expect(turn.status).toBe(409);
  expect(await turn.json()).toMatchObject({ error: ARCHIVED_NOTE });
  /* A quote is free, and still answers. */
  expect((await ask({ text: "And a cutdown.", quoteOnly: true })).status).toBe(200);
  expect(turns).toEqual([{ quoteOnly: true }]);

  const claimRoute = await route<{ POST: Handler }>("app/api/atomik/steps/[id]/claim/route.ts", ws, ana);
  const claim = () => claimRoute.POST(new Request("https://studio.test/api/atomik/steps/sA/claim", { method: "POST" }), { params: Promise.resolve({ id: "sA" }) });
  const refused = await claim();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: ARCHIVED_NOTE, step: { id: "sA", status: "proposed" } });
  await inTenant(ws, async () => {
    expect(await counts("tA")).toEqual({ messages: 1, steps: 1 });
    expect((await sql(`SELECT status, attempt, claimed_by, request_key FROM atomik_steps WHERE id = 'sA'`)).rows[0]).toMatchObject({ status: "proposed", attempt: 0, claimed_by: null, request_key: null });
    await restoreThread("tA");
  });
  const taken = await claim();
  expect(taken.status).toBe(200);
  expect(await taken.json()).toMatchObject({ step: { id: "sA", status: "running", requestKey: "atomik-step:tA:sA" } });
});

test("PATCH names, archives and restores a thread, and none of it is activity; GET lists a project's threads, or its archived ones", async () => {
  const ws = workspace(), ana = member("u_ana", "Ana");
  await inTenant(ws, async () => {
    await person("u_ana", "Ana");
    await chat({ id: "tA", created: 1, updated: 5000 });
    await chat({ id: "tB", created: 2, updated: 6000 });
  });
  const chatRoute = await route<{ PATCH: Handler }>("app/api/atomik/[id]/route.ts", ws, ana);
  const patch = async (id: string, body: unknown) => {
    const res = await chatRoute.PATCH(new Request(`https://studio.test/api/atomik/${id}`, json("PATCH", body)), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
  };
  expect(await patch("tA", { archived: true })).toMatchObject({ status: 200, body: { chat: { id: "tA", archivedBy: "u_ana", archivedAt: expect.any(Number) } } });
  expect(await patch("tA", { title: "  " })).toEqual({ status: 400, body: { error: "Give the thread a name." } });
  expect(await patch("tA", { title: "Harbour teaser" })).toMatchObject({ status: 200, body: { chat: { title: "Harbour teaser" } } });
  expect(await patch("ach_gone", { archived: true })).toEqual({ status: 404, body: { error: "That thread is gone." } });

  const threadsRoute = await route<{ GET: Handler }>("app/api/atomik/threads/route.ts", ws, ana);
  const list = async (query: string) => {
    const res = await threadsRoute.GET(new Request(`https://studio.test/api/atomik/threads${query}`), { params: Promise.resolve({}) });
    return { status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() };
  };
  const active = await list("?projectId=p1");
  expect(active.cache).toBe("no-store");
  expect(active.body.threads.map((t: { id: string }) => t.id)).toEqual(["tB"]);
  expect((await list("?projectId=p1&archived=1")).body.threads).toEqual([expect.objectContaining({ id: "tA", title: "Harbour teaser", archivedByYou: true, archivedByName: "Ana" })]);
  expect((await list("")).body.threads).toEqual([]);
  expect((await list(`?projectId=${"p".repeat(121)}`)).status).toBe(400);

  expect(await patch("tA", { archived: false })).toMatchObject({ status: 200, body: { chat: { archivedAt: null, archivedBy: null } } });
  expect((await list("?projectId=p1")).body.threads.map((t: { id: string }) => t.id)).toEqual(["tB", "tA"]);
  await inTenant(ws, async () => {
    expect(await chatRow("tA")).toMatchObject({ updated_at: 5000, deleted: 0, title: "Harbour teaser" });
  });
});

/* ── Shared across threads ───────────────────────────────────────────── */

test("Memory is the project's: two threads of it plan with the same kept memory", async () => {
  const memory = await import("../../lib/atomikMemory");
  const atomik = await import("../../lib/atomik");
  const ws = workspace(), ana = member("u_ana", "Ana");
  await inTenant(ws, async () => {
    await production("p1"); await production("p2");
    await memory.addMemory({ kind: "audience", text: "Night riders.", projectId: "p1" }, "u_ana");
    await memory.addMemory({ kind: "note", text: "Another production's rule.", projectId: "p2" }, "u_ana");
    await chat({ id: "tA", created: 1 });
    await chat({ id: "tB", created: 2 });
  });
  const seen: Record<string, string | undefined> = {};
  const chatRoute = await route<{ POST: Handler }>("app/api/atomik/[id]/route.ts", ws, ana, {
    "@/lib/atomik": { ...atomik, projectContext: async () => "",
      runTurn: async (id: string, opts: { memory?: string }) => { seen[id] = opts.memory; return { model: "test/model", effort: "auto", estimateCredits: 2 }; } },
    "@/lib/rules": { effectiveRules: async () => [] },
    "@/lib/platformLayer": { writerRulesByScope: () => "" },
  });
  for (const id of ["tA", "tB"]) {
    const res = await chatRoute.POST(new Request(`https://studio.test/api/atomik/${id}`, json("POST", { text: "A night ride at the harbour", quoteOnly: true })), { params: Promise.resolve({ id }) });
    expect(res.status, id).toBe(200);
  }
  expect(seen.tA).toContain("Night riders.");
  expect(seen.tA).not.toContain("Another production's rule.");
  expect(seen.tB).toBe(seen.tA);
});

/* ── The rules the browser reads ─────────────────────────────────────── */

test("a thread's title, its state, when it last moved and the chat a saved turn names, as the browser reads them", async () => {
  const { cleanThreadTitle, threadTitle, threadState, lastActivity, startedBy, chatOfRequest } = await import("../../lib/atomikThreadsText");
  expect(cleanThreadTitle("  Harbour\u0000 teaser\n")).toBe("Harbour teaser");
  expect(cleanThreadTitle(" \t ")).toBeNull();
  expect(cleanThreadTitle(7)).toBeNull();
  expect(threadTitle("New chat", null)).toBe("New thread");
  expect(threadTitle("New chat", "Plan it")).toBe("Plan it");
  expect(threadTitle("Named", "Plan it")).toBe("Named");
  expect(threadState({ status: "running", needsApproval: true, rendering: true, messages: 3 })).toBe("planning");
  expect(threadState({ status: "waiting", needsApproval: true, rendering: true, messages: 3 })).toBe("approval");
  expect(threadState({ status: "waiting", needsApproval: false, rendering: true, messages: 3 })).toBe("running");
  expect(threadState({ status: "failed", needsApproval: false, rendering: false, messages: 3 })).toBe("stopped");
  expect(threadState({ status: "idle", needsApproval: false, rendering: false, messages: 0 })).toBe("new");
  expect(threadState({ status: "waiting", needsApproval: false, rendering: false, messages: 2 })).toBe("done");
  const now = Date.UTC(2026, 8, 30, 12);
  expect([lastActivity(now - 5_000, now), lastActivity(now - 5 * 60_000, now), lastActivity(now - 3 * 3_600_000, now)]).toEqual(["just now", "5 min ago", "3 h ago"]);
  expect(lastActivity(Date.UTC(2026, 8, 20, 12), now)).toBe("Sep 20");
  expect([startedBy({ startedByYou: true, startedByName: "Ana" }), startedBy({ startedByYou: false, startedByName: "Ben" }), startedBy({ startedByYou: false, startedByName: null })])
    .toEqual(["you", "Ben", "a teammate"]);
  expect(chatOfRequest("/api/atomik/ach_123")).toBe("ach_123");
  expect(chatOfRequest("/api/atomik/ach%20x")).toBe("ach x");
  expect(chatOfRequest("/api/atomik/steps/s1/claim")).toBeNull();
  expect(chatOfRequest("/api/generate")).toBeNull();
});
