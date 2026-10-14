import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The review of admin reach (board sharing PR 1), each point as a test:
 *  - an admin's read of a private board's TAKES (Atomik's context, the approved-takes export, a take) goes through the audited gate: one history line, and no line means no read;
 *  - no live-room token through the admin rule (an admin looks and edits through the saved board; rooms for admins wait for their screens);
 *  - paid text on a member's private board is refused to an admin;
 *  - a client link on a private board is its OWNER's alone, and the owner reads every link on their board ("Client link created by <name>") and withdraws it;
 *  - a token (API or MCP, read-only or not) acts as a plain member whatever its creator's role;
 *  - "Viewed by" names the platform owner as "Particl support" in a client workspace.
 * Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-admin-review-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.LIVEBLOCKS_SECRET_KEY = "sk_test_stub_secret";
const run = Math.random().toString(36).slice(2, 8);
const ROOT_EMAIL = `root-${run}@example.test`;
let envBefore: string | undefined;
test.beforeEach(async () => { envBefore = process.env.SUPER_ADMIN_EMAIL; process.env.SUPER_ADMIN_EMAIL = ROOT_EMAIL; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });
test.afterEach(async () => { if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });

type Who = { id: string; role: "admin" | "member"; name: string; email: string; token?: boolean };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: id === "u_root" ? "Rhea Rootname" : `Name ${id}`, email: id === "u_root" ? ROOT_EMAIL : `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 }, ...(w.token ? { token: { id: "tok_1", name: "agent", scope: "read" as const, capUsd: null } } : {}) });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function loadRoute<T>(file: string, viewer: () => Who, extra: Record<string, unknown> = {}): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const session = async () => ({ user: asUser(viewer()).user, ...(viewer().token ? { token: asUser(viewer()).token } : {}) });
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: session, requireSession: session, requireRender: session },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
    ...extra,
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((n: string) => (Object.hasOwn(fakes, n) ? fakes[n] : n.startsWith("@/") ? real(path.join(root, n.slice(2))) : real(n)), mod, mod.exports);
  return mod.exports as T;
}

async function fixture(name: string) {
  const ws = { id: `arr-${name}-${run}`, name, slug: name, legacy: false, dbUrl: `file:${path.join(dir, `arr-${name}-${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true } as TenantWorkspace;
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const platform = await import("../../lib/platform");
  const draft = await import("../../lib/draftProject");
  await platform.platformReady();
  for (const [id, role] of [["u_owner", "admin"], ["u_admin", "admin"], ["u_mate", "member"], ["u_root", "admin"]] as const) {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, who(id).email, who(id).name, "x"] });
    await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, role] });
  }
  let current = who("u_owner", "admin");
  const as = <T,>(p: Who, fn: () => Promise<T>) => { current = p; return tenant.runInTenant(ws, fn, asUser(p)); };
  const first = await as(who("u_owner", "admin"), async () => { await records.workbenchReady(); return records.saveDraft("u_owner", { ...newProject("Board"), id: "d1", nodes: [] } as never, 0); });
  const board = first.productionProjectId as string;
  await as(who("u_owner", "admin"), async () => {
    const db = database.db();
    await db.execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,review_by,approved_by,approved_at,deleted) VALUES('g_priv',?,'video','mock','m','p','{}','succeeded','u_owner',1,1,1,'approved','Name u_owner','Name u_owner',1,0)", args: [board] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_plain','Plain production',0)", args: [] });
    /* A take of a board whose draft is gone (held or deleted), and one of an ordinary production. */
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,'Deleted board',0)", args: [HELD] });
    await db.execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted) VALUES('g_held',?,'video','mock','m','held p','{}','succeeded','u_owner',2,2,1,'draft',0)", args: [HELD] });
    await db.execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted) VALUES('g_plain','prod_plain','video','mock','m','plain p','{}','succeeded','u_owner',3,3,1,'draft',0)", args: [] });
  });
  const route = <T,>(file: string, extra: Record<string, unknown> = {}) => loadRoute<T>(file, () => current, extra);
  const lines = () => as(who("u_owner", "admin"), async () => (await database.db().execute({ sql: "SELECT actor_id, action, target_id FROM security_audit WHERE action LIKE 'board.%' ORDER BY created_at, id", args: [] })).rows.map((r) => `${r.actor_id}:${r.action}`));
  const breakAudit = (on: boolean) => as(who("u_owner", "admin"), async () => { await database.db().execute(on ? "CREATE TRIGGER arr_no_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'board.%' BEGIN SELECT RAISE(ABORT,'history is down'); END" : "DROP TRIGGER arr_no_audit"); });
  return { ws, as, board, route, lines, breakAudit, tenant, database, platform, draft, records };
}
const HELD = "prj_wb_heldboardnodraft0000000";
const ADMIN = who("u_admin", "admin");

test("an admin's read of a private board's takes is one history line each time it is made, and a history that cannot be written refuses the read", async () => {
  const f = await fixture("takes");
  const { readableProjectOr, mayReadTake } = f.draft;
  const selects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/export/selects/route.ts");
  const count = () => f.as(ADMIN, async () => { const res = await selects.GET(new Request(`https://particl.test/api/export/selects?projectId=${f.board}&format=count`)); return { status: res.status, body: await res.json() as Json }; });
  /* The Atomik turn feeds the board's takes, titles and prompts to the model through readableProjectOr; the export through mayReadTake. */
  expect(await f.as(ADMIN, () => readableProjectOr({ id: "u_admin", role: "admin" }, f.board))).toBe(f.board);
  expect(await f.lines()).toEqual(["u_admin:board.opened_by_admin"]);
  expect(await f.as(ADMIN, () => mayReadTake({ id: "u_admin", role: "admin" }, f.board))).toBe(true);
  expect((await count()).body).toEqual({ approved: 1 });
  expect((await f.lines()).filter((l) => l.startsWith("u_admin:")), "the same look soon after is the same line").toHaveLength(1);
  /* A different admin is a different line; the owner reading their own is none. A held or deleted board is no exception (owner, 14 Oct, 23:35): the same audited read, a line against its id. */
  await f.as(who("u_root", "admin"), () => readableProjectOr({ id: "u_root", role: "admin" }, f.board));
  expect(await f.lines()).toEqual(["u_admin:board.opened_by_admin", "u_root:board.opened_by_admin"]);
  await f.as(who("u_owner", "admin"), () => readableProjectOr({ id: "u_owner", role: "admin" }, f.board));
  expect(await f.lines()).toHaveLength(2);
  const heldLines = () => f.as(who("u_owner", "admin"), async () => (await f.database.db().execute({ sql: "SELECT actor_id, action FROM security_audit WHERE target_id=?", args: [HELD] })).rows.map((r) => `${r.actor_id}:${r.action}`));
  expect(await heldLines()).toEqual([]);
  expect(await f.as(ADMIN, () => mayReadTake({ id: "u_admin", role: "admin" }, HELD)), "a held board's take: read through the gate").toBe(true);
  expect(await f.as(ADMIN, () => readableProjectOr({ id: "u_admin", role: "admin" }, HELD))).toBe(HELD);
  expect(await heldLines(), "one line against the board's id, though no draft holds it").toEqual(["u_admin:board.opened_by_admin"]);
  expect(await f.as(ADMIN, () => mayReadTake({ id: "u_admin", role: "admin" }, "prj_wb_nodraftnotakes000000000")), "an id with neither a draft nor takes is nobody's").toBe(false);
  expect(await f.as(ADMIN, () => f.draft.mayReachProject({ id: "u_admin", role: "admin" }, HELD, "write")), "a write needs the draft").toBe(false);
  /* A third admin whose line cannot be written: refused, both ways. */
  const third = who("u_third", "admin");
  await f.platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('u_third','u_third@example.test','Name u_third','x',0)", args: [] });
  await f.breakAudit(true);
  expect(await f.as(third, () => readableProjectOr({ id: "u_third", role: "admin" }, f.board)), "no line, no read: Atomik reads nothing of the board").toBeNull();
  expect(await f.as(third, () => mayReadTake({ id: "u_third", role: "admin" }, f.board))).toBe(false);
  expect(await f.as(third, () => mayReadTake({ id: "u_third", role: "admin" }, HELD)), "a held board fails closed too").toBe(false);
  const refusedCount = await f.as(third, async () => { const res = await selects.GET(new Request(`https://particl.test/api/export/selects?projectId=${f.board}&format=count`)); return res.status; });
  expect(refusedCount, "the export answers as for a production with nothing approved").toBe(404);
  await f.breakAudit(false);
  expect((await f.lines()).filter((l) => l.startsWith("u_third"))).toEqual([]);
});

test("an admin's lists hide a member's private takes; the admin opens the board (audited) and sees them; held boards are no exception", async () => {
  const f = await fixture("lists");
  const jobs = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/jobs/route.ts");
  const ids = (p: Who, query: string) => f.as(p, async () => ((await (await jobs.GET(new Request(`https://particl.test/api/jobs${query}`))).json()) as Json).generations.map((g: Json) => g.id).sort() as string[]);
  const OWNER = who("u_owner", "admin"), MATE = who("u_mate");
  expect(await ids(OWNER, "?sync=0&limit=60"), "the owner's own list holds their private board's takes (the fixture's held board is no one's own)").toEqual(["g_plain", "g_priv"]);
  expect(await ids(ADMIN, "?sync=0&limit=60"), "an admin's list holds ordinary takes only: no private board's, a held board's either").toEqual(["g_plain"]);
  expect(await ids(MATE, "?sync=0&limit=60")).toEqual(["g_plain"]);
  expect(await f.lines(), "a list is not an open: no line").toEqual([]);
  expect(await ids(ADMIN, `?sync=0&limit=60&projectId=${f.board}`), "the admin opens the board").toEqual(["g_priv"]);
  expect(await f.lines()).toEqual(["u_admin:board.opened_by_admin"]);
  expect(await ids(ADMIN, `?sync=0&limit=60&projectId=${f.board}`)).toEqual(["g_priv"]);
  expect(await f.lines(), "the same look soon after is the same line").toHaveLength(1);
  expect(await ids(ADMIN, `?sync=0&limit=60&projectId=${HELD}`), "a held board is opened the same audited way").toEqual(["g_held"]);
  expect((await f.lines()).length).toBe(2);
  expect(await ids(MATE, `?sync=0&limit=60&projectId=${f.board}`), "a member opens nothing").toEqual([]);
  /* The usage screen keeps the spend and masks the words, as for a member. */
  const { takeLister } = f.draft;
  const listed = await f.as(ADMIN, () => takeLister({ id: "u_admin", role: "admin" }));
  expect([listed(f.board), listed(HELD), listed("prod_plain"), listed(null)]).toEqual([false, false, true, true]);
  /* Background work (nobody) is not asked. */
  expect((await f.as(ADMIN, () => takeLister(null)))(f.board)).toBe(true);
});

test("an admin's approvals queue shows a member's private-board take only through the audited read, one line per board", async () => {
  const f = await fixture("approvals");
  await f.as(who("u_owner", "admin"), async () => {
    const db = f.database.db();
    for (const [id, project] of [["h_priv", f.board], ["h_plain", "prod_plain"]] as const)
      await db.execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted) VALUES(?,?,'video','mock','m',?,?,'held','u_owner',5,5,1,'draft',0)", args: [id, project, `${id} prompt`, JSON.stringify({ held: { why: "credits", needs: 40 } })] });
  });
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  const read = (p: Who) => f.as(p, async () => ((await readApprovals({ id: p.id, role: p.role, owner: false })) as { items: { id: string }[] }).items.map((i) => i.id).filter((id) => id.startsWith("held:")).sort());
  expect(await read(ADMIN), "the admin approves what the queue shows").toEqual(["held:h_plain", "held:h_priv"]);
  expect(await f.lines(), "one line for the one private board shown").toEqual(["u_admin:board.opened_by_admin"]);
  await read(ADMIN);
  expect(await f.lines(), "the 15-minute rule: not another").toHaveLength(1);
  await f.breakAudit(true);
  expect(await read(who("u_root", "admin")), "no line, no row").toEqual(["held:h_plain"]);
  await f.breakAudit(false);
  expect(await read(who("u_mate")), "a member sees no one else's private board").toEqual(["held:h_plain"]);
  expect(await read(who("u_owner", "admin")), "the owner's own board needs no line").toEqual(["held:h_plain", "held:h_priv"]);
  expect(await f.lines()).toHaveLength(1);
});

test("an admin's approvals queue does not touch a board whose only held takes wait for a slot", async () => {
  const f = await fixture("approvals-slot");
  await f.as(who("u_owner", "admin"), async () => {
    await f.database.db().execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted) VALUES('h_slot',?,'video','mock','m','slot prompt',?,'held','u_owner',5,5,1,'draft',0)", args: [f.board, JSON.stringify({ held: { why: "slot" } })] });
  });
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  const items = await f.as(ADMIN, async () => ((await readApprovals({ id: "u_admin", role: "admin", owner: false })) as { items: { id: string }[] }).items.map((i) => i.id).filter((id) => id.startsWith("held:")));
  expect(items, "a slot-held take starts on its own and is not in the queue").toEqual([]);
  expect(await f.lines(), "and no false 'Viewed by'").toEqual([]);
});

test("a statement masks another member's private-board lines, keeps every total, and opens a board only through the audited read; a token reads none", async () => {
  const f = await fixture("statements");
  await f.as(who("u_owner", "admin"), async () => {
    await f.database.db().execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted,cost_usd) VALUES('g_secret',?,'video','mock','m','SECRET-PRIVATE-NOTE','{}','succeeded','u_owner',5,5,1,'draft',0,1)", args: [f.board] });
  });
  const statements = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/statements/route.ts");
  const get = (p: Who, query = "") => f.as(p, async () => { const res = await statements.GET(new Request(`https://particl.test/api/statements?month=1970-01${query}`)); return { status: res.status, text: await res.text() }; });
  const OWNER = who("u_owner", "admin");
  const mine = await get(OWNER);
  expect(mine.text, "the board's owner reads their own lines").toContain("SECRET-PRIVATE-NOTE");
  const seen = await get(ADMIN);
  expect(seen.status).toBe(200);
  expect(seen.text, "an admin reads no note of another's private board").not.toContain("SECRET-PRIVATE-NOTE");
  expect(seen.text).toContain("A private board");
  const totals = (r: { text: string }) => (JSON.parse(r.text) as Json).totals;
  expect(totals(seen), "every total stays whole").toEqual(totals(mine));
  expect(await f.lines(), "a statement is not an open").toEqual([]);
  const board = await get(ADMIN, `&project=${f.board}`);
  expect(board.text, "the admin opens the board: its lines, audited").toContain("SECRET-PRIVATE-NOTE");
  expect(await f.lines()).toEqual(["u_admin:board.opened_by_admin"]);
  const csv = await get(ADMIN, "&format=csv");
  expect(csv.text).not.toContain("SECRET-PRIVATE-NOTE");
  expect((await get({ ...ADMIN, token: true })).status, "an admin's token is a plain member's: no statement").toBe(403);
  expect((await get({ ...ADMIN, token: true }, `&project=${f.board}`)).status).toBe(403);
  expect((await get(who("u_mate"))).status).toBe(403);
  expect(await f.lines(), "no line for a token or a member").toHaveLength(1);
});

test("the usage screen of a workspace not billed in credits masks another member's private-board takes and board name, for a member and an admin", async () => {
  const f = await fixture("usage");
  await f.as(who("u_owner", "admin"), async () => {
    await f.database.db().execute({ sql: "INSERT INTO generations(id,project_id,kind,provider,model,title,prompt,params,status,created_by,created_at,updated_at,version,review_state,deleted,cost_usd) VALUES('g_secret',?,'video','mock','m','SECRET-TITLE','SECRET-PRIVATE-NOTE','{\"resolution\":\"720p\"}','succeeded','u_owner',5,5,1,'draft',0,1)", args: [f.board] });
  });
  const usage = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/usage/route.ts", {
    "@/lib/credits": { ...(await import("../../lib/credits")), creditsApply: () => false },
    /* The gateway's own credit read is a network call: stood in, nothing leaves the process. */
    "@/lib/enhance": { ...(await import("../../lib/enhance")), gatewayCredits: async () => null },
  });
  const get = (p: Who) => f.as(p, async () => { const res = await usage.GET(new Request("https://particl.test/api/usage")); return { status: res.status, body: (await res.json()) as Json }; });
  const mine = await get(who("u_owner", "admin"));
  expect(mine.status).toBe(200);
  expect(JSON.stringify(mine.body), "the owner reads their own take").toContain("SECRET-PRIVATE-NOTE");
  for (const viewer of [ADMIN, who("u_mate")]) {
    const got = await get(viewer);
    expect(got.status, viewer.id).toBe(200);
    expect(JSON.stringify(got.body), `${viewer.id}: no title, prompt or id of the take`).not.toMatch(/SECRET-TITLE|SECRET-PRIVATE-NOTE|g_secret/);
    expect(got.body.recent.find((r: Json) => r.title === "A private board"), viewer.id).toMatchObject({ id: "", prompt: "", params: {}, costUsd: 1 });
    expect(got.body.byProject.map((p: Json) => p.name), `${viewer.id}: the board's name`).toContain("A private board");
    expect(got.body.byProject.map((p: Json) => p.name)).not.toContain("Board");
    expect(got.body.totalSpend ?? got.body.spend ?? mine.body.totalSpend ?? mine.body.spend, "the totals stay whole").toBe(mine.body.totalSpend ?? mine.body.spend);
  }
});

test("an admin's Atomik quote on a private board writes one history line, and the board's context is read only through it", async () => {
  const f = await fixture("atomik");
  const atomik = f.route<{ POST: (r: Request) => Promise<Response> }>("app/api/atomik/route.ts");
  const { NextRequest } = createRequire(path.resolve("package.json"))("next/server") as typeof import("next/server");
  const ask = (p: Who) => f.as(p, async () => { const res = await atomik.POST(new NextRequest("https://particl.test/api/atomik", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quoteOnly: true, text: "Plan the next shot", projectId: f.board }) })); return res.status; });
  const status = await ask(ADMIN);
  expect(status, "the quote answers").toBeLessThan(500);
  expect(await f.lines()).toEqual(["u_admin:board.opened_by_admin"]);
  await f.breakAudit(true);
  const before = (await f.lines()).length;
  await ask(who("u_root", "admin"));
  expect(await f.lines(), "no line is written, and none was read through").toHaveLength(before);
  await f.breakAudit(false);
});

test("no live-room token through the admin rule: an admin cannot sign into a private board's room; its owner can", async () => {
  const f = await fixture("rooms");
  const { teamRoomFor } = await import("../../lib/workbench/team-canvas");
  class Liveblocks { prepareSession() { return { allow() {}, authorize: async () => ({ status: 200, body: JSON.stringify({ token: "stub" }) }) }; } }
  const auth = f.route<{ POST: (r: Request) => Promise<Response> }>("app/api/collab/auth/route.ts", { "@liveblocks/node": { Liveblocks } });
  const token = (p: Who) => f.as(p, async () => (await auth.POST(new Request("https://particl.test/api/collab/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: teamRoomFor(f.ws.id, f.board, 0) }) }))).status);
  expect(await token(who("u_owner", "admin"))).toBe(200);
  expect(await token(ADMIN), "an admin is not let into the live room").toBe(403);
  expect(await token(who("u_mate"))).toBe(403);
  /* They can still look at and edit the saved board, audited (a demotion then ends that too: there is no room to rotate). */
  const canvas = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/team-canvas/route.ts");
  expect((await f.as(ADMIN, async () => (await canvas.GET(new Request(`https://particl.test/api/workbench/team-canvas?productionId=${f.board}`))).status))).toBe(200);
  await f.platform.platformDb().execute({ sql: "UPDATE memberships SET role='member' WHERE workspace_id=? AND account_id='u_admin'", args: [f.ws.id] });
  const demoted = who("u_admin", "member");
  expect(await token(demoted)).toBe(403);
  expect((await f.as(demoted, async () => (await canvas.GET(new Request(`https://particl.test/api/workbench/team-canvas?productionId=${f.board}`))).status))).toBe(404);
});

test("paid text on a member's private board is refused to an admin and writes no history line for the spend; the owner's goes through", async () => {
  const f = await fixture("spend");
  const drafter = f.route<{ POST: (r: Request) => Promise<Response> }>("app/api/atomik/shots/draft/route.ts");
  const scene = f.route<{ POST: (r: Request) => Promise<Response> }>("app/api/atomik/treatment/scene/route.ts");
  const post = (route: { POST: (r: Request) => Promise<Response> }, p: Who, body: Json) => f.as(p, async () => { const res = await route.POST(new Request("https://particl.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); return [res.status, await res.json()] as const; });
  const unknown = await post(drafter, ADMIN, { projectId: "prj_wb_doesnotexist0000000000", scene: 1 });
  expect(await post(drafter, ADMIN, { projectId: f.board, scene: 1 })).toEqual(unknown);
  expect(await post(scene, ADMIN, { projectId: f.board, n: 1 })).toEqual(await post(scene, ADMIN, { projectId: "prj_wb_doesnotexist0000000000", n: 1 }));
  expect(await f.lines(), "an admin refused a spend writes no 'edited' line").toEqual([]);
});

test("a client link on a private board is its owner's alone; the owner (admin or not) makes one, reads every link on it, who made it and when, and withdraws it; anyone else is answered as for no such board", async () => {
  const f = await fixture("links");
  const links = f.route<{ POST: (r: Request) => Promise<Response>; DELETE: (r: Request) => Promise<Response>; GET: (r: Request) => Promise<Response> }>("app/api/review-links/route.ts");
  const legacy = f.route<{ POST: (r: Request) => Promise<Response>; DELETE: (r: Request) => Promise<Response>; GET: (r: Request) => Promise<Response> }>("app/api/shares/route.ts");
  const projects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts");
  const make = (route: typeof links, p: Who, projectId: string) => f.as(p, async () => { const res = await route.POST(new Request("https://particl.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) })); return { status: res.status, body: await res.json() as Json }; });
  const OWNER = who("u_owner", "admin"), OWNER_MEMBER = who("u_owner", "member"), MATE = who("u_mate");
  const unknownId = "prj_wb_doesnotexist0000000000";
  for (const [label, route] of [["client link", links], ["older link", legacy]] as const) {
    expect((await make(route, ADMIN, f.board)).status, `${label}: an admin of the workspace makes none on a member's private board`).toBe(404);
    expect((await make(route, ADMIN, f.board)).body, `${label}: answered as a production that is not saved`).toEqual((await make(route, ADMIN, unknownId)).body);
    const member = await make(route, MATE, f.board);
    expect(member.status, `${label}: a member`).toBe(404);
    expect(member, `${label}: the same answer for another's private board and for nothing, so nothing says which boards exist`).toEqual(await make(route, MATE, unknownId));
    expect((await make(route, OWNER, f.board)).status, `${label}: the owner, who is an admin`).toBe(201);
    expect((await make(route, OWNER_MEMBER, f.board)).status, `${label}: the owner, a plain member, makes their own private board's link`).toBe(201);
  }
  expect((await make(links, ADMIN, "prod_plain")).status, "a production of the workspace is an admin's, as before").toBe(201);
  expect((await make(links, MATE, "prod_plain")).status, "and a member's is refused, as before").toBe(403);
  /* The owner reads every link on their board, both kinds, who made it; other people read none. */
  const read = (p: Who) => f.as(p, async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  const mine = (await read(OWNER)).links as Json[];
  expect(mine.map((l) => l.kind).sort(), "both kinds, each made twice above (as an admin and as a plain member)").toEqual(["approved", "approved", "review", "review"]);
  expect(mine.every((l) => l.boardId === "d1" && l.live === true && l.by === "Name u_owner" && l.at > 0)).toBe(true);
  expect((await read(ADMIN)).links, "an admin reads none of another's board").toEqual([]);
  expect((await read(MATE)).links).toEqual([]);
  /* Withdraw: the owner (the board's owner, even a plain member), an admin, and nobody else; the same 403 for a link that is not there. */
  const withdraw = (route: typeof links, p: Who, id: string) => f.as(p, async () => { const res = await route.DELETE(new Request(`https://particl.test/x?id=${id}`, { method: "DELETE" })); return res.status; });
  const [review, approved] = [mine.find((l) => l.kind === "review")!.linkId as string, mine.find((l) => l.kind === "approved")!.linkId as string];
  expect(mine.every((l) => l.revokedBy === null), "a live link says nobody withdrew it").toBe(true);
  expect(await withdraw(links, MATE, review)).toBe(403);
  expect(await withdraw(links, MATE, "shr_doesnotexist0000")).toBe(403);
  expect(await withdraw(links, OWNER, review)).toBe(200);
  expect(await withdraw(legacy, ADMIN, approved)).toBe(200);
  for (const l of mine) if (l.linkId !== review && l.linkId !== approved) expect(await withdraw(links, OWNER_MEMBER, l.linkId as string), "the owner, a plain member, withdraws the rest").toBe(200);
  expect((await read(OWNER)).links.filter((l: Json) => l.live)).toEqual([]);
  /* "Client link revoked by <name>": the owner reads who withdrew each link, an admin of the workspace included (an admin may withdraw any link, never make one on another's private board). */
  const after = (await read(OWNER)).links as Json[];
  expect(after.find((l) => l.linkId === review)!.revokedBy, "withdrawn by the board's owner").toBe("Name u_owner");
  expect(after.find((l) => l.linkId === approved)!.revokedBy, "withdrawn by an admin").toBe("Name u_admin");
  expect(after.every((l) => typeof l.revokedBy === "string" && l.revokedAt > 0)).toBe(true);
  expect((await read(ADMIN)).links, "the admin who withdrew it reads no one's list of another's board").toEqual([]);
});

test("a link made by the platform owner reads Particl support in a client workspace's history", async () => {
  const f = await fixture("linkmask");
  const { mintShare } = await import("../../lib/shares");
  await f.as(who("u_owner", "admin"), () => mintShare({ workspaceId: f.ws.id, projectId: f.board, by: "Rhea Rootname", actorId: "u_root" }));
  const projects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts");
  const read = await f.as(who("u_owner", "admin"), async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  expect(read.links).toHaveLength(1);
  expect(read.links[0].by).toBe("Particl support");
  expect(read.links[0].revokedBy).toBeNull();
  /* Withdrawn by the platform owner: the same mask. */
  const { revokeShare } = await import("../../lib/shares");
  await f.as(who("u_owner", "admin"), () => revokeShare(f.ws.id, read.links[0].linkId, "u_root"));
  const gone = await f.as(who("u_owner", "admin"), async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  expect(gone.links[0].revokedBy).toBe("Particl support");
  expect(JSON.stringify(gone)).not.toContain("Rootname");
  /* A second revoke of a link already withdrawn changes nothing and writes no line: the one who withdrew it stays the one named. */
  expect(await f.as(who("u_owner", "admin"), () => revokeShare(f.ws.id, read.links[0].linkId, "u_owner"))).toBe(false);
  expect(await f.as(who("u_owner", "admin"), () => revokeShare(f.ws.id, read.links[0].linkId, "u_admin"))).toBe(false);
  const twice = await f.as(who("u_owner", "admin"), async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  expect(twice.links[0].revokedBy, "still the platform owner's, not the later attempts'").toBe("Particl support");
  const revokeLines = await f.platform.platformDb().execute({ sql: "SELECT actor_id FROM security_audit WHERE action='review_link.revoked' AND target_id=?", args: [read.links[0].linkId] });
  expect(revokeLines.rows.map((r) => r.actor_id), "one line").toEqual(["u_root"]);
  /* And were a later line ever there, the first still wins. */
  const { securityAuditStatement } = await import("../../lib/securityAudit");
  await f.platform.platformDb().execute(securityAuditStatement({ workspaceId: f.ws.id, actorId: "u_admin", action: "review_link.revoked", targetType: "review_link", targetId: read.links[0].linkId }));
  const later = await f.as(who("u_owner", "admin"), async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  expect(later.links[0].revokedBy).toBe("Particl support");
});

test("a token acts as a plain member whatever its creator's role: no admin reach, read-only or not", async () => {
  const f = await fixture("tokens");
  const { mayReachProject, isWorkspaceAdmin, readableProjectOr } = f.draft;
  const token = { ...ADMIN, token: true };
  const reach = (p: Who, access: "read" | "write") => f.as(p, () => mayReachProject({ id: p.id, role: p.role }, f.board, access));
  expect([await reach(ADMIN, "read"), await reach(ADMIN, "write")], "a signed-in admin").toEqual([true, true]);
  expect([await reach(token, "read"), await reach(token, "write")], "the same admin's token").toEqual([false, false]);
  expect(await f.as(ADMIN, async () => isWorkspaceAdmin({ id: "u_admin", role: "admin" }))).toBe(true);
  expect(await f.as(token, async () => isWorkspaceAdmin({ id: "u_admin", role: "admin" }))).toBe(false);
  expect(await f.as(token, () => readableProjectOr({ id: "u_admin", role: "admin" }, f.board))).toBeNull();
  /* The routes: the list of every board and an admin's open of a member's board answer a token as a route that is not there. */
  const projects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts");
  const get = (p: Who, q: string) => f.as(p, async () => (await projects.GET(new Request(`https://particl.test/api/workbench/projects?${q}`))).status);
  expect(await get(ADMIN, "all=1")).toBe(200);
  expect(await get(token, "all=1")).toBe(404);
  expect(await get(ADMIN, "id=d1&owner=u_owner")).toBe(200);
  expect(await get(token, "id=d1&owner=u_owner")).toBe(404);
  /* No history line for a token's refused look. */
  expect(await f.lines(), "only the signed-in admin's look and edit are lines; the token's refused ones are none").toEqual(["u_admin:board.opened_by_admin", "u_admin:board.edited_by_admin"]);
});

test("\"Viewed by\" names the platform owner as Particl support in a client workspace, and the owner reads it", async () => {
  const f = await fixture("viewed");
  const projects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts");
  const root = who("u_root", "admin");
  expect((await f.as(root, async () => (await projects.GET(new Request("https://particl.test/api/workbench/projects?id=d1&owner=u_owner"))).status))).toBe(200);
  const views = await f.as(who("u_owner", "admin"), async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?views=1"))).json()) as Json);
  expect(views.views).toHaveLength(1);
  expect(views.views[0].by.name).toBe("Particl support");
  expect(views.views[0].by.support).toBe(true);
  expect(views.views[0].by.id, "an opaque id of this workspace, not the account").toMatch(/^support_[0-9a-f]{24}$/);
  expect(JSON.stringify(views)).not.toMatch(/Rootname|u_root|root-/);
});
