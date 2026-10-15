import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Where a saved board stands (board sharing, PR 8): `GET ?id=&head=1` answers the revision, the time and who saved it last (the name this workspace may read,
 * never an id) for the person's own board and for one they may write; any other board is not found. Windows with no live room poll it; the rooms' "saved"
 * hint leads to the same read.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-acting-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
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



test("the head of a board: own, or one the person may write, with the saver's name and no id; any other board is not found", async () => {
  const f = await fixture("head");
  const head = (person: Who, query = "id=d1&head=1") => f.as(person, () => f.route.GET(new Request(`https://particl.test/api/workbench/projects?${query}`), undefined as never));
  await f.as(who("u_owner"), () => f.database.db().execute({ sql: "INSERT OR REPLACE INTO users(id,email,name,password_hash,role,created_at) VALUES('u_mate','m@example.test','Mia Mate','x','member',0)", args: [] }));
  // The owner's own board: saved by the owner, so "mine" and no name.
  const own = await head(who("u_owner"));
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ revision: 1, by: null, mine: true });
  // Not shared, view-only shared: nobody else gets even a revision.
  for (const query of ["id=d1&head=1", "id=d1&head=1&owner=u_owner"]) expect((await head(who("u_mate"), query)).status, query).toBe(404);
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "view" }));
  expect((await head(who("u_mate"), "id=d1&head=1&owner=u_owner")).status).toBe(404);
  // Can edit: the editor saves, and the owner then sees who, by name; the editor sees their own as theirs.
  await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", mode: "edit" }));
  const saved = await f.as(who("u_mate"), () => f.put({ ...f.board, name: "Edited" }, 1, { owner: "u_owner" }));
  expect(saved.status).toBe(200);
  const seenByOwner = await (await head(who("u_owner"))).json();
  expect(seenByOwner).toMatchObject({ revision: 2, by: "Mia Mate", mine: false });
  expect(JSON.stringify(seenByOwner)).not.toContain("u_mate");
  expect(typeof seenByOwner.updatedAt).toBe("number");
  for (const query of ["id=d1&head=1", "id=d1&head=1&owner=u_owner"]) expect(await (await head(who("u_mate"), query)).json(), query).toMatchObject({ revision: 2, by: null, mine: true });
  // A person with no standing in the workspace's users list is a teammate, not a name.
  await f.as(who("u_owner"), () => f.database.db().execute("DELETE FROM users WHERE id='u_mate'"));
  expect((await (await head(who("u_owner"))).json()).by).toBe("A teammate");
  // An id nobody has: not found.
  expect((await head(who("u_owner"), "id=nothing&head=1")).status).toBe(404);
});
