import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A member switched off or removed moves the live room of every Can edit board first, and fails closed: if the rooms cannot move, the change does not
 * land and the answer is an error (like a membership change whose audit line cannot be written), so no old token is left honoured under a member who looks switched off.
 * Each room is the one the board's draft is LINKED to (`productionProjectId`), the one setBoardSharing rotates, not a recomputed default. Liveblocks is stubbed at the
 * network edge: nothing leaves this process.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-rooms-membership-"));
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

type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: id, email: `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });

async function fixture(name: string, options: { between?: () => Promise<void> } = {}) {
  const ws = { id: `brm-${name}-${run}`, name: name, slug: name, legacy: false, dbUrl: `file:${path.join(dir, `brm-${name}-${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true } as TenantWorkspace;
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const platform = await import("../../lib/platform");
  await platform.platformReady();
  for (const [id, role] of [["u_owner", "member"], ["u_mate", "member"], ["u_admin", "admin"]] as const) {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x"] });
    await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, role] });
  }
  const admin = { ...who("u_admin", "admin"), owner: true };
  const as = <T,>(p: Who, fn: () => Promise<T>) => tenant.runInTenant(ws, fn, asUser(p));
  /* An ordinary production, which a draft may be linked to, and two Can edit boards: one on its own default project, one LINKED to that production. */
  await as(admin, async () => { await database.ready(); await database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_linked','Linked production',0)", args: [] }); });
  const ids: Record<string, string> = {};
  const save = async (draftId: string, linked?: string) => {
    const first = await as(who("u_owner"), async () => { await records.workbenchReady(); return records.saveDraft("u_owner", { ...newProject(draftId), id: draftId, nodes: [], ...(linked ? { productionProjectId: linked } : {}) } as never, 0); });
    ids[draftId] = first.productionProjectId as string;
    await as(who("u_owner"), () => records.setBoardSharing("u_owner", draftId, { teamShared: true, teamEdit: true }));
  };
  await save("d-default");
  await save("d-linked", "prod_linked");
  expect(ids["d-linked"], "the draft is linked to the other production").toBe("prod_linked");
  expect(ids["d-default"]).toMatch(/^prj_wb_/);
  const rooms = await import("../../lib/workbench/room-rotation");
  const { teamRoomFor } = await import("../../lib/workbench/team-canvas");
  const generation = (production: string) => as(admin, () => rooms.roomGeneration(production));
  const strays = () => as(admin, async () => (await database.db().execute({ sql: "SELECT key, value FROM settings WHERE key LIKE 'collab:room-generation:%' ORDER BY key", args: [] })).rows.map((r) => `${r.key}=${r.value}`));
  const pending: (() => Promise<void>)[] = [];
  const root = process.cwd();
  const file = "app/api/team/[id]/route.ts";
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireAdmin: async () => ({ user: admin }), isPlatformOwner: async () => false },
    /* The membership change, with a hook that runs after its last statement and before its commit: the window in which the member is still a member. */
    "@/lib/accountDb": (() => { const accounts = real(path.join(root, "lib/accountDb")); return { ...accounts, accountTransaction: (fn: (tx: unknown) => Promise<unknown>) => accounts.accountTransaction(async (tx: unknown) => { const out = await fn(tx); await options.between?.(); return out; }) }; })(),
    "next/server": { ...real("next/server"), after: (work: unknown) => { pending.push(typeof work === "function" ? (work as () => Promise<void>) : async () => { await work; }); } },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as { PATCH: (r: Request, c: unknown) => Promise<Response>; DELETE: (r: Request, c: unknown) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((n: string) => (Object.hasOwn(fakes, n) ? fakes[n] : n.startsWith("@/") ? real(path.join(root, n.slice(2))) : real(n)), mod, mod.exports);
  const ctx = { params: Promise.resolve({ id: "u_mate" }) };
  const patch = (body: unknown) => as(admin, () => mod.exports.PATCH(new Request("https://particl.test/api/team/u_mate", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx));
  const remove = () => as(admin, () => mod.exports.DELETE(new Request("https://particl.test/api/team/u_mate", { method: "DELETE" }), ctx));
  const membership = async () => (await platform.platformDb().execute({ sql: "SELECT disabled FROM memberships WHERE workspace_id=? AND account_id='u_mate'", args: [ws.id] })).rows;
  const audit = () => as(admin, async () => (await database.db().execute({ sql: "SELECT action FROM security_audit WHERE workspace_id=? AND action LIKE 'member.%'", args: [ws.id] })).rows.map((r) => String(r.action)));
  const auditPlatform = async () => (await platform.platformDb().execute({ sql: "SELECT action FROM security_audit WHERE workspace_id=? AND action LIKE 'member.%'", args: [ws.id] })).rows.map((r) => String(r.action));
  return { ws, as, admin, ids, rooms, teamRoomFor, generation, strays, pending, patch, remove, membership, audit, auditPlatform, database };
}

test("a draft linked to another production: removing a member moves THAT room (the one its token is for), closes it, and writes no stray row for a recomputed id", async () => {
  const f = await fixture("linked");
  const deletes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? "GET") === "DELETE" && url.includes("/rooms/")) { deletes.push(decodeURIComponent(url.split("/rooms/")[1])); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected network call ${url}`);
  }) as typeof fetch;
  try {
    expect(await f.generation("prod_linked")).toBe(0);
    const oldRoom = f.teamRoomFor(f.ws.id, "prod_linked", 0);
    const removed = await f.remove();
    expect(removed.status, JSON.stringify(await removed.clone().json())).toBe(200);
    expect(await f.generation("prod_linked"), "the linked production's room moved, before the change and again after it").toBe(2);
    expect(await f.generation(f.ids["d-default"]), "and the default one").toBe(2);
    /* One row per room that exists: the two real productions, none for a production id the linked draft never had. */
    expect(await f.strays()).toEqual([`collab:room-generation:${f.ids["d-default"]}=2`, "collab:room-generation:prod_linked=2"].sort());
    while (f.pending.length) await f.pending.shift()!();
    expect(deletes, "the old room of the linked production is closed").toContain(oldRoom);
    expect(deletes, "and the room that was current between the two moves").toContain(f.teamRoomFor(f.ws.id, "prod_linked", 1));
    expect(deletes).toHaveLength(4);
  } finally { globalThis.fetch = realFetch; }
});

test("the rooms moving is part of the membership change and fails closed: if they cannot move, a switch-off or a removal does not land, the answer is an error, and nothing is recorded", async () => {
  const f = await fixture("closed");
  /* The generation row cannot be written: every move fails. */
  await f.as(f.admin, () => f.database.db().execute("CREATE TRIGGER brm_bump_down BEFORE INSERT ON settings WHEN NEW.key LIKE 'collab:room-generation:%' BEGIN SELECT RAISE(ABORT,'rooms are down'); END"));
  const off = await f.patch({ disabled: true });
  expect(off.status, "an error, not a 200 over tokens that stay valid").toBe(503);
  expect(await f.membership(), "still switched on").toEqual([expect.objectContaining({ disabled: 0 })]);
  const gone = await f.remove();
  expect(gone.status).toBe(503);
  expect(await f.membership(), "still a member").toHaveLength(1);
  expect(await f.audit(), "no tenant line").toEqual([]);
  expect(await f.auditPlatform(), "no receipt for a change that did not land").toEqual([]);
  expect(await f.strays()).toEqual([]);
  expect(f.pending, "nothing to close").toHaveLength(0);
  /* The rooms can move again: the same requests now land. */
  await f.as(f.admin, () => f.database.db().execute("DROP TRIGGER brm_bump_down"));
  expect((await f.patch({ disabled: true })).status).toBe(200);
  expect(await f.membership()).toEqual([expect.objectContaining({ disabled: 1 })]);
  expect(await f.generation("prod_linked")).toBe(2);
  expect((await f.remove()).status).toBe(200);
  expect(await f.membership()).toHaveLength(0);
  expect(await f.generation("prod_linked")).toBe(4);
});

test("a room opened in the window between the first move and the commit is moved and closed too", async () => {
  const deletes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? "GET") === "DELETE" && url.includes("/rooms/")) { deletes.push(decodeURIComponent(url.split("/rooms/")[1])); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected network call ${url}`);
  }) as typeof fetch;
  const issued: { room: string; status: number }[] = [];
  let ask: (() => Promise<void>) | null = null;
  try {
    const f = await fixture("window", { between: async () => { await ask?.(); } });
    /* The collab sign-in as the member being removed, with Liveblocks stubbed to hand out a token. */
    class Liveblocks { prepareSession() { return { allow() {}, authorize: async () => ({ status: 200, body: JSON.stringify({ token: "stub" }) }) }; } }
    const root = process.cwd();
    const file = "app/api/collab/auth/route.ts";
    const real = createRequire(path.resolve(file));
    const fakes: Record<string, unknown> = {
      "@liveblocks/node": { Liveblocks },
      "@/lib/auth": { withTenant: (h: unknown) => h, requireSession: async () => ({ user: who("u_mate") }) },
      "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
      "@/lib/requestOrigin": { crossOriginProblem: () => null },
    };
    const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as { POST: (r: Request) => Promise<Response> } };
    new Function("require", "module", "exports", compiled)((n: string) => (Object.hasOwn(fakes, n) ? fakes[n] : n.startsWith("@/") ? real(path.join(root, n.slice(2))) : real(n)), mod, mod.exports);
    const tenant = await import("../../lib/tenant");
    const signIn = async (room: string) => { const res = await tenant.runInTenant(f.ws, () => mod.exports.POST(new Request("https://particl.test/api/collab/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room }) })), asUser(who("u_mate"))); issued.push({ room, status: res.status }); return res.status; };
    const between = f.teamRoomFor(f.ws.id, "prod_linked", 1);
    /* The sign-in names the room user through the platform owner's identity (lib/collab.ts › roomUserId, owner 14 Oct), a platform read; it is cached ahead so the sign-in inside the window below does not wait on the platform transaction the membership change holds open. */
    await (await import("../../lib/platformOwnerPrivacy")).platformOwnerIdentity();
    /* In the window, after the first move: the room the board is now edited in is open to the member, who is still a member. */
    ask = async () => { ask = null; await signIn(between); };
    const removed = await f.remove();
    expect(removed.status, JSON.stringify(await removed.clone().json())).toBe(200);
    expect(issued, "the member was signed into the new room in the window").toEqual([{ room: between, status: 200 }]);
    /* After the commit it is moved again and closed with the rest; nobody can be signed into it now. */
    expect(await f.generation("prod_linked")).toBe(2);
    while (f.pending.length) await f.pending.shift()!();
    expect(deletes).toContain(f.teamRoomFor(f.ws.id, "prod_linked", 0));
    expect(deletes, "the room opened in the window is closed").toContain(between);
    expect(await signIn(between)).toBe(403);
  } finally { globalThis.fetch = realFetch; }
});

test("a workspace database that was never set up has no board to move: the rooms move on nothing and a removal is not failed for want of a table", async () => {
  const tenant = await import("../../lib/tenant");
  const { bumpEditRooms } = await import("../../lib/workbench/room-rotation");
  const fresh = { id: `brm-fresh-${run}`, name: "fresh", slug: "fresh", legacy: false, dbUrl: `file:${path.join(dir, `brm-fresh-${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true } as TenantWorkspace;
  expect(await tenant.runInTenant(fresh, () => bumpEditRooms(), asUser(who("u_admin", "admin")))).toEqual([]);
});
