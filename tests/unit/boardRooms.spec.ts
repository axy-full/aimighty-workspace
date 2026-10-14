import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The live room follows the share mode (board sharing, PR 6): taking "Can edit" away, or stopping sharing, closes the room at once (a Liveblocks access
 * token cannot be revoked and its connection stays open, so the room is rotated and the old one deleted through the REST API); no token is issued for a
 * closed room, and the new one is for writers alone. Liveblocks is stubbed at the network edge: nothing leaves this process.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-acting-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const WRITER = crypto.randomUUID();
const ROOT_EMAIL = `root-${run}@example.test`;
let envBefore: string | undefined;
test.beforeEach(async () => { envBefore = process.env.SUPER_ADMIN_EMAIL; process.env.SUPER_ADMIN_EMAIL = ROOT_EMAIL; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });
test.afterEach(async () => { if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });

const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: id, email: id === "u_root" ? ROOT_EMAIL : `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });

function loadRoute<T>(file: string, viewer: () => Who): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer() }), requireSession: async () => ({ user: viewer() }), requireRender: async () => ({ user: viewer() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

type Route = typeof import("../../app/api/workbench/projects/route");

async function fixture(name: string, options: { sample?: boolean } = {}) {
  const ws = workspace(`ba-${name}-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { createNode } = await import("../../lib/workbench/node-graph");
  const platform = await import("../../lib/platform");
  /* The workspace's people, as the platform holds them: a key named in a request must be an active member's. */
  await platform.platformReady();
  for (const id of ["u_owner", "u_mate", "u_root"]) {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x"] });
    await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, "member"] });
  }
  let current = who("u_owner");
  const route = loadRoute<Route>("app/api/workbench/projects/route.ts", () => current);
  const as = <T,>(person: Who, fn: () => Promise<T>) => { current = person; return tenant.runInTenant(ws, fn, asUser(person)); };
  const request = (method: string, body: unknown) => new Request("https://particl.test/api/workbench/projects", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const put = (project: unknown, revision: number, extra: Record<string, unknown> = {}) => route.PUT(request("PUT", { project, revision, ...extra }), undefined as never);
  const post = (body: Record<string, unknown>) => route.POST(request("POST", body), undefined as never);
  /* The owner's board, saved the ordinary way, with one card so a shot can be mapped. */
  let board = { ...newProject("Board"), id: "d1", nodes: [{ ...createNode("scene", 0), id: "n1" }] } as never as ReturnType<typeof newProject>;
  const first = await as(who("u_owner"), async () => { await records.workbenchReady(); return records.saveDraft("u_owner", board, 0); });
  board = { ...board, productionProjectId: first.productionProjectId } as typeof board;
  /* The owner's board is the marked sample: the platform owner (not its marker) has write reach to it (#694), a teammate has not. */
  if (options.sample) await as(who("u_owner"), async () => {
    await database.db().execute({ sql: "INSERT OR REPLACE INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_owner',0)", args: [JSON.stringify({ version: 1, projectId: first.productionProjectId, name: "Sample", draftOwner: "u_owner", draftId: "d1", markedBy: "u_owner", markedAt: 1 })] });
  });
  const members = { disable: (id: string) => platform.platformDb().execute({ sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?", args: [ws.id, id] }) };
  const row = (owner = "u_owner") => as(who("u_owner"), async () => (await database.db().execute({ sql: "SELECT body,revision,updated_by,owner FROM workbench_projects WHERE key=?", args: [`${owner}:d1`] })).rows[0]);
  return { ws, tenant, database, records, members, route, as, put, post, board, row, first };
}



const OLD_ENV = process.env.LIVEBLOCKS_SECRET_KEY;
test.afterAll(() => { if (OLD_ENV === undefined) delete process.env.LIVEBLOCKS_SECRET_KEY; else process.env.LIVEBLOCKS_SECRET_KEY = OLD_ENV; });

function authRoute(viewer: () => Who) {
  const calls: { user: string; room: string; permissions: string[] }[] = [];
  class Liveblocks {
    prepareSession(user: string) {
      const entry = { user, room: "", permissions: [] as string[] };
      return { allow(room: string, permissions: string[]) { entry.room = room; entry.permissions = permissions; calls.push(entry); }, authorize: async () => ({ status: 200, body: JSON.stringify({ token: "stub" }) }) };
    }
  }
  const root = process.cwd();
  const real = createRequire(path.resolve("app/api/collab/auth/route.ts"));
  const fakes: Record<string, unknown> = {
    "@liveblocks/node": { Liveblocks },
    "@/lib/auth": { withTenant: (h: unknown) => h, requireSession: async () => ({ user: viewer() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/collab/auth/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as { POST: (req: Request) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return { POST: mod.exports.POST, calls };
}

test("a downgrade or stopped sharing closes the live room: the old room is deleted, no token is issued for it, and the new room is for writers alone", async () => {
  process.env.LIVEBLOCKS_SECRET_KEY = "sk_test_stub_secret";
  const f = await fixture("rooms");
  const { teamRoomFor } = await import("../../lib/workbench/team-canvas");
  const { currentRoom, roomGeneration } = await import("../../lib/workbench/room-rotation");
  const production = f.first.productionProjectId as string;
  const room0 = teamRoomFor(f.ws.id, production);
  // Liveblocks' REST API, stubbed at the network edge.
  const deleted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "DELETE" && url.includes("/rooms/")) { deleted.push(decodeURIComponent(url.split("/rooms/")[1])); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected network call ${url}`);
  }) as typeof fetch;
  try {
    let current = who("u_mate");
    const auth = authRoute(() => current);
    const token = (room: string) => f.as(current, () => auth.POST(new Request("https://particl.test/api/collab/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room }) })));
    const setMode = (mode: string) => f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode }));
    const canvasRoom = async () => (await (await f.as(who("u_owner"), () => loadRoute<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/team-canvas/route.ts", () => who("u_owner")).GET(new Request(`https://particl.test/api/workbench/team-canvas?productionId=${production}`)))).json()).room as string;
    // Can edit: the editor holds a write token for the first room; the owner the same.
    expect((await setMode("edit")).status).toBe(200);
    expect(await f.as(who("u_owner"), () => canvasRoom())).toBe(room0);
    expect((await token(room0)).status).toBe(200);
    expect(auth.calls.at(-1)).toMatchObject({ room: room0, permissions: ["*:write"] });
    // Taking edit away (to view) closes the room; putting it back opens nothing old.
    expect((await setMode("view")).status).toBe(200);
    expect((await setMode("edit")).status).toBe(200);
    const afterFirst = await f.as(who("u_owner"), () => roomGeneration(production));
    expect(afterFirst).toBe(1);
    expect(deleted).toEqual([room0]);
    // The old room: no token for anyone, the ex-editor included; the new room: the current editor and the owner, not a teammate who may only look.
    const room1 = await f.as(who("u_owner"), () => currentRoom(f.ws.id, production));
    expect(room1).toBe(`${room0}:1`);
    for (const person of [who("u_mate"), who("u_owner")]) { current = person; expect((await token(room0)).status, `${person.id} old room`).toBe(403); }
    current = who("u_mate");
    expect((await token(room1)).status, "editor, new room").toBe(200);
    expect(await f.as(who("u_owner"), () => canvasRoom())).toBe(room1);
    // Downgraded to view again: the room closes again, and the editor is out.
    expect((await setMode("view")).status).toBe(200);
    expect(deleted).toEqual([room0, room1]);
    const room2 = await f.as(who("u_owner"), () => currentRoom(f.ws.id, production));
    expect(room2).toBe(`${room0}:2`);
    current = who("u_mate");
    expect((await token(room1)).status).toBe(403);
    expect((await token(room2)).status, "a viewer is not a writer").toBe(403);
    current = who("u_owner");
    expect((await token(room2)).status, "the owner").toBe(200);
    // Sharing stopped from edit rotates too; view -> none and none -> view do not.
    await setMode("edit");
    await setMode("none");
    expect(deleted).toEqual([room0, room1, room2]);
    await setMode("view");
    await setMode("none");
    expect(deleted).toHaveLength(3);
    // The response says so, for the owner's window to join the new room.
    await setMode("edit");
    const stop = await (await setMode("none")).json();
    expect(stop).toMatchObject({ ok: true, mode: "none", roomRotated: true });
    // Not a room of this workspace, or of another production: refused as before.
    current = who("u_owner");
    expect((await token("particl:other:" + production)).status).toBe(403);
    expect((await token(`particl:${f.ws.id}:${production}:x`)).status).toBe(403);
  } finally { globalThis.fetch = realFetch; }
});

test("rotating a room: the generation moves first, a room that does not exist or an unreachable Liveblocks changes nothing about that", async () => {
  const f = await fixture("rotate");
  const { rotateRoom, roomGeneration } = await import("../../lib/workbench/room-rotation");
  const { teamRoomFor, roomParts } = await import("../../lib/workbench/team-canvas");
  expect(teamRoomFor("w", "p")).toBe("particl:w:p");
  expect(teamRoomFor("w", "p", 3)).toBe("particl:w:p:3");
  expect(roomParts("particl:w:p", "w")).toEqual({ productionId: "p", generation: 0 });
  expect(roomParts("particl:w:p:3", "w")).toEqual({ productionId: "p", generation: 3 });
  for (const bad of ["particl:w:p:0", "particl:w:p:03", "particl:w:p:1:2", "particl:w:p:x", "particl:w:../p", "particl:v:p"]) expect(roomParts(bad, "w"), bad).toBeNull();
  const gone: string[] = [];
  const moved = await f.as(who("u_owner"), async () => {
    const a = await rotateRoom("prj_x", { deleteRoom: async (id) => { gone.push(id); } });
    const b = await rotateRoom("prj_x", { deleteRoom: async () => { throw new Error("404 no such room"); } });
    const c = await rotateRoom("prj_x", null);
    return { a, b, c, generation: await roomGeneration("prj_x"), other: await roomGeneration("prj_y") };
  });
  expect(moved.a).toEqual({ from: `particl:${f.ws.id}:prj_x`, to: `particl:${f.ws.id}:prj_x:1`, closed: true });
  expect(moved.b.to.endsWith(":2") && moved.c.to.endsWith(":3")).toBe(true);
  expect(moved).toMatchObject({ generation: 3, other: 0 });
  expect(gone).toEqual([`particl:${f.ws.id}:prj_x`]);
});

test("the share change and the room's rotation are one transaction: if the room cannot move, the board stays as it was", async () => {
  const f = await fixture("atomic");
  const { roomGeneration } = await import("../../lib/workbench/room-rotation");
  const production = f.first.productionProjectId as string;
  const stored = async () => JSON.parse(String((await f.row()).body));
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  expect(await stored()).toMatchObject({ teamShared: true, teamEdit: true });
  // The generation lives in the workspace's settings: take that table away for a moment, so the rotation inside the share change cannot be written.
  await f.as(who("u_owner"), () => f.database.db().execute("ALTER TABLE settings RENAME TO settings_away"));
  let refused: unknown;
  try { refused = await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "d1", { teamShared: true, teamEdit: false }, "u_owner").then(() => "changed", (e: Error) => e.message)); }
  finally { await f.as(who("u_owner"), () => f.database.db().execute("ALTER TABLE settings_away RENAME TO settings")); }
  expect(refused).toMatch(/settings/);
  // Nothing half-done: still shared with edit, same revision, generation not moved.
  expect(await stored()).toMatchObject({ teamShared: true, teamEdit: true });
  expect(await f.as(who("u_owner"), () => roomGeneration(production))).toBe(0);
  // With the table back, the one change does both, and says what it moved.
  const done = await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "d1", { teamShared: true, teamEdit: false }, "u_owner"));
  expect(done).toMatchObject({ teamEdit: false, rotation: { from: `particl:${f.ws.id}:${production}`, to: `particl:${f.ws.id}:${production}:1` } });
  expect(await f.as(who("u_owner"), () => roomGeneration(production))).toBe(1);
  expect(await stored()).toMatchObject({ teamShared: true });
  expect((await stored()).teamEdit).toBeUndefined();
  // A change that does not take edit away moves nothing.
  const same = await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "d1", { teamShared: true, teamEdit: true }, "u_owner"));
  expect(same?.rotation).toBeNull();
  expect(await f.as(who("u_owner"), () => roomGeneration(production))).toBe(1);
});

test("closing the old room is retried, and when Liveblocks cannot be reached the new generation still keeps the old room's tokens out", async () => {
  process.env.LIVEBLOCKS_SECRET_KEY = "sk_test_stub_secret";
  const { closeRoom } = await import("../../lib/workbench/room-rotation");
  // Three tries, then it gives up without throwing; a room that is already gone counts as closed.
  let tries = 0;
  expect(await closeRoom("r", { deleteRoom: async () => { tries++; if (tries < 3) throw new Error("503"); } }, [0, 0])).toBe(true);
  expect(tries).toBe(3);
  tries = 0;
  expect(await closeRoom("r", { deleteRoom: async () => { tries++; throw new Error("503"); } }, [0, 0])).toBe(false);
  expect(tries).toBe(3);
  expect(await closeRoom("r", { deleteRoom: async () => { throw Object.assign(new Error("no room"), { status: 404 }); } }, [0, 0])).toBe(true);
  expect(await closeRoom("r", null)).toBe(true);
  // Through the route, with Liveblocks answering 500 to every delete: the share change still succeeds, and the old room still gets no token.
  const f = await fixture("blocked");
  const production = f.first.productionProjectId as string;
  const { teamRoomFor } = await import("../../lib/workbench/team-canvas");
  const deletes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "DELETE" && url.includes("/rooms/")) { deletes.push(url); return new Response(JSON.stringify({ error: "down" }), { status: 500 }); }
    throw new Error(`unexpected network call ${url}`);
  }) as typeof fetch;
  const realTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => realTimeout(fn, ms && ms > 100 ? 1 : ms, ...rest)) as typeof setTimeout;
  try {
    await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
    const res = await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "none" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "none", roomRotated: true });
    expect(deletes.length).toBe(3);
    const current = who("u_owner");
    const auth = authRoute(() => current);
    const token = (room: string) => f.as(current, () => auth.POST(new Request("https://particl.test/api/collab/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room }) })));
    expect((await token(teamRoomFor(f.ws.id, production))).status, "the old room, never closed by Liveblocks").toBe(403);
  } finally { globalThis.fetch = realFetch; globalThis.setTimeout = realTimeout; }
});

test("a member switched off or removed closes every Can edit room; re-enabling, and boards that are only viewed or private, do not", async () => {
  process.env.LIVEBLOCKS_SECRET_KEY = "sk_test_stub_secret";
  const f = await fixture("membership");
  const { roomGeneration } = await import("../../lib/workbench/room-rotation");
  const { newProject } = await import("../../lib/workbench/studio");
  const { createNode } = await import("../../lib/workbench/node-graph");
  const owner = who("u_owner");
  const generations = async () => f.as(owner, async () => {
    const rows = (await f.database.db().execute("SELECT owner, project_id, body FROM workbench_projects ORDER BY project_id")).rows;
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.project_id)] = await roomGeneration((await import("../../lib/workbench/records")).mappedId("prj_wb_", f.ws.id, String(r.owner), String(r.project_id)));
    return out;
  });
  // d1 (edit), d2 (edit), d3 (view), d4 (private).
  for (const id of ["d2", "d3", "d4"]) await f.as(owner, () => f.records.saveDraft("u_owner", { ...newProject(id), id, nodes: [{ ...createNode("scene", 0), id: "n1" }] } as never, 0));
  await f.as(owner, () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  await f.as(owner, () => f.post({ action: "team-share", projectId: "d2", mode: "edit" }));
  await f.as(owner, () => f.post({ action: "team-share", projectId: "d3", mode: "view" }));
  expect(await generations()).toEqual({ d1: 0, d2: 0, d3: 0, d4: 0 });
  const deletes: string[] = [];
  const pending: (() => Promise<void>)[] = [];
  let inFlight = 0, mostAtOnce = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "DELETE" && url.includes("/rooms/")) {
      inFlight++; mostAtOnce = Math.max(mostAtOnce, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight--;
      deletes.push(decodeURIComponent(url.split("/rooms/")[1]));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected network call ${url}`);
  }) as typeof fetch;
  const afterResponse = async () => { while (pending.length) await pending.shift()!(); };
  try {
    const admin = { ...who("u_owner", "admin"), owner: true };
    const root = process.cwd();
    const file = "app/api/team/[id]/route.ts";
    const real = createRequire(path.resolve(file));
    const fakes: Record<string, unknown> = {
      "@/lib/auth": { withTenant: (h: unknown) => h, requireAdmin: async () => ({ user: admin }), isPlatformOwner: async () => false },
      /* `after` runs what the route hands it once the response has gone: here, when the test says so. */
      "next/server": { ...real("next/server"), after: (work: unknown) => { pending.push(typeof work === "function" ? (work as () => Promise<void>) : async () => { await work; }); } },
    };
    const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as { PATCH: (r: Request, c: unknown) => Promise<Response>; DELETE: (r: Request, c: unknown) => Promise<Response> } };
    new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
    const ctx = { params: Promise.resolve({ id: "u_mate" }) };
    const patch = (body: unknown) => f.as(admin, () => mod.exports.PATCH(new Request("https://particl.test/api/team/u_mate", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx));
    // Switched off: d1 and d2 move on, d3 (view) and d4 (private) do not; each old room is deleted.
    const off = await patch({ disabled: true });
    expect(off.status, JSON.stringify(await off.clone().json())).toBe(200);
    // The generations moved before the response went, so no old token is honoured; no room has been deleted yet: that is for after the response.
    expect(await generations()).toEqual({ d1: 2, d2: 2, d3: 0, d4: 0 });
    expect(deletes).toEqual([]);
    expect(pending.length).toBe(1);
    await afterResponse();
    /* Each Can edit room moved twice (before the change and again after it, for any room opened in between), and all four old rooms are closed. */
    expect(deletes.length).toBe(4);
    expect(mostAtOnce, "the old rooms are closed together, not one after another").toBe(4);
    // Switched back on, or only the role changed (a role change is the owner's call; the admin is the owner here): nothing moves.
    expect((await patch({ disabled: false })).status).toBe(200);
    expect(await generations()).toEqual({ d1: 2, d2: 2, d3: 0, d4: 0 });
    expect(deletes.length).toBe(4);
    // Removed: every Can edit room moves again.
    const removed = await f.as(admin, () => mod.exports.DELETE(new Request("https://particl.test/api/team/u_mate", { method: "DELETE" }), ctx));
    expect(removed.status, JSON.stringify(await removed.clone().json())).toBe(200);
    expect(await generations()).toEqual({ d1: 4, d2: 4, d3: 0, d4: 0 });
    expect(deletes.length).toBe(4);
    await afterResponse();
    expect(deletes.length).toBe(8);
  } finally { globalThis.fetch = realFetch; }
});
