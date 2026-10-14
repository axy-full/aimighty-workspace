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
  });
  const route = <T,>(file: string, extra: Record<string, unknown> = {}) => loadRoute<T>(file, () => current, extra);
  const lines = () => as(who("u_owner", "admin"), async () => (await database.db().execute({ sql: "SELECT actor_id, action, target_id FROM security_audit WHERE action LIKE 'board.%' ORDER BY created_at, id", args: [] })).rows.map((r) => `${r.actor_id}:${r.action}`));
  const breakAudit = (on: boolean) => as(who("u_owner", "admin"), async () => { await database.db().execute(on ? "CREATE TRIGGER arr_no_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'board.%' BEGIN SELECT RAISE(ABORT,'history is down'); END" : "DROP TRIGGER arr_no_audit"); });
  return { ws, as, board, route, lines, breakAudit, tenant, database, platform, draft, records };
}
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
  /* A different admin is a different line; the owner reading their own is none; a held board no draft holds is still an admin's. */
  await f.as(who("u_root", "admin"), () => readableProjectOr({ id: "u_root", role: "admin" }, f.board));
  expect(await f.lines()).toEqual(["u_admin:board.opened_by_admin", "u_root:board.opened_by_admin"]);
  await f.as(who("u_owner", "admin"), () => readableProjectOr({ id: "u_owner", role: "admin" }, f.board));
  expect(await f.lines()).toHaveLength(2);
  expect(await f.as(ADMIN, () => mayReadTake({ id: "u_admin", role: "admin" }, "prj_wb_heldboardnodraft0000000"))).toBe(true);
  expect(await f.as(ADMIN, () => readableProjectOr({ id: "u_admin", role: "admin" }, "prj_wb_heldboardnodraft0000000"))).toBe("prj_wb_heldboardnodraft0000000");
  /* A third admin whose line cannot be written: refused, both ways. */
  const third = who("u_third", "admin");
  await f.platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('u_third','u_third@example.test','Name u_third','x',0)", args: [] });
  await f.breakAudit(true);
  expect(await f.as(third, () => readableProjectOr({ id: "u_third", role: "admin" }, f.board)), "no line, no read: Atomik reads nothing of the board").toBeNull();
  expect(await f.as(third, () => mayReadTake({ id: "u_third", role: "admin" }, f.board))).toBe(false);
  const refusedCount = await f.as(third, async () => { const res = await selects.GET(new Request(`https://particl.test/api/export/selects?projectId=${f.board}&format=count`)); return res.status; });
  expect(refusedCount, "the export answers as for a production with nothing approved").toBe(404);
  await f.breakAudit(false);
  expect((await f.lines()).filter((l) => l.startsWith("u_third"))).toEqual([]);
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

test("a client link on a private board is its owner's alone; the owner reads every link on it, who made it and when, and withdraws it; the role check comes first", async () => {
  const f = await fixture("links");
  const links = f.route<{ POST: (r: Request) => Promise<Response>; DELETE: (r: Request) => Promise<Response>; GET: (r: Request) => Promise<Response> }>("app/api/review-links/route.ts");
  const legacy = f.route<{ POST: (r: Request) => Promise<Response>; DELETE: (r: Request) => Promise<Response>; GET: (r: Request) => Promise<Response> }>("app/api/shares/route.ts");
  const projects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts");
  const make = (route: typeof links, p: Who, projectId: string) => f.as(p, async () => { const res = await route.POST(new Request("https://particl.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) })); return { status: res.status, body: await res.json() as Json }; });
  const OWNER = who("u_owner", "admin"), MATE = who("u_mate");
  const unknownId = "prj_wb_doesnotexist0000000000";
  for (const [label, route] of [["client link", links], ["older link", legacy]] as const) {
    expect((await make(route, ADMIN, f.board)).status, `${label}: an admin of the workspace makes none on a member's private board`).toBe(404);
    expect((await make(route, ADMIN, f.board)).body, `${label}: answered as a production that is not saved`).toEqual((await make(route, ADMIN, unknownId)).body);
    const member = await make(route, MATE, f.board);
    expect(member.status, `${label}: a member`).toBe(403);
    expect(member, `${label}: the role check is first: the same answer for the board and for nothing`).toEqual(await make(route, MATE, unknownId));
    expect((await make(route, OWNER, f.board)).status, `${label}: the owner`).toBe(201);
  }
  expect((await make(links, ADMIN, "prod_plain")).status, "a production of the workspace is an admin's, as before").toBe(201);
  /* The owner reads every link on their board, both kinds, who made it; other people read none. */
  const read = (p: Who) => f.as(p, async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  const mine = (await read(OWNER)).links as Json[];
  expect(mine.map((l) => l.kind).sort()).toEqual(["approved", "review"]);
  expect(mine.every((l) => l.boardId === "d1" && l.live === true && l.by === "Name u_owner" && l.at > 0)).toBe(true);
  expect((await read(ADMIN)).links, "an admin reads none of another's board").toEqual([]);
  expect((await read(MATE)).links).toEqual([]);
  /* Withdraw: the owner (even a plain member would be refused creating, but may withdraw their board's), an admin, and nobody else; the same 403 for a link that is not there. */
  const withdraw = (route: typeof links, p: Who, id: string) => f.as(p, async () => { const res = await route.DELETE(new Request(`https://particl.test/x?id=${id}`, { method: "DELETE" })); return res.status; });
  const [review, approved] = [mine.find((l) => l.kind === "review")!.linkId as string, mine.find((l) => l.kind === "approved")!.linkId as string];
  expect(await withdraw(links, MATE, review)).toBe(403);
  expect(await withdraw(links, MATE, "shr_doesnotexist0000")).toBe(403);
  expect(await withdraw(links, OWNER, review)).toBe(200);
  expect(await withdraw(legacy, ADMIN, approved)).toBe(200);
  expect((await read(OWNER)).links.filter((l: Json) => l.live)).toEqual([]);
});

test("a link made by the platform owner reads Particl support in a client workspace's history", async () => {
  const f = await fixture("linkmask");
  const { mintShare } = await import("../../lib/shares");
  await f.as(who("u_owner", "admin"), () => mintShare({ workspaceId: f.ws.id, projectId: f.board, by: "Rhea Rootname", actorId: "u_root" }));
  const projects = f.route<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts");
  const read = await f.as(who("u_owner", "admin"), async () => (await (await projects.GET(new Request("https://particl.test/api/workbench/projects?links=1"))).json()) as Json);
  expect(read.links).toHaveLength(1);
  expect(read.links[0].by).toBe("Particl support");
  expect(JSON.stringify(read)).not.toContain("Rootname");
});

test("a token acts as a plain member whatever its creator's role: no admin reach, read-only or not", async () => {
  const f = await fixture("tokens");
  const { mayReachProject, seesEveryBoard, readableProjectOr } = f.draft;
  const token = { ...ADMIN, token: true };
  const reach = (p: Who, access: "read" | "write") => f.as(p, () => mayReachProject({ id: p.id, role: p.role }, f.board, access));
  expect([await reach(ADMIN, "read"), await reach(ADMIN, "write")], "a signed-in admin").toEqual([true, true]);
  expect([await reach(token, "read"), await reach(token, "write")], "the same admin's token").toEqual([false, false]);
  expect(await f.as(ADMIN, async () => seesEveryBoard({ id: "u_admin", role: "admin" }))).toBe(true);
  expect(await f.as(token, async () => seesEveryBoard({ id: "u_admin", role: "admin" }))).toBe(false);
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
