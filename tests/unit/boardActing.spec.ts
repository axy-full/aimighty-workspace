import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Acting on a board stored under someone else's key, and the sharing flags as the server's own (board sharing, PR 3).
 *
 * A board is stored under its author's key. A person with write reach who is not the author saves, maps shots and publishes against that key as
 * themselves: the key, the mappings and the revision stay the board's, the actor is recorded. The share flags (`teamShared`) are never set or cleared
 * by a save, only by the `team-share` action, and only the owner may call it. A stale revision is refused, never overwritten. Real temporary databases;
 * sign-in is a fake; nothing is sent or spent.
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

test("a save under another key records the actor and keeps the board's own key, mappings and revision; a stale revision is refused and overwrites nothing", async () => {
  const f = await fixture("save", { sample: true });
  // The board's own save recorded its author as the actor.
  expect((await f.row()).updated_by).toBe("u_owner");
  // Saved as the platform owner under u_owner's key.
  const saved = await f.as(who("u_root"), () => f.records.saveDraft("u_owner", { ...f.board, name: "Renamed by an editor" }, 1, undefined, "u_root"));
  expect(saved).toMatchObject({ revision: 2, productionProjectId: f.first.productionProjectId });
  const row = await f.row();
  expect(row).toMatchObject({ owner: "u_owner", revision: 2, updated_by: "u_root" });
  expect(JSON.parse(String(row.body)).name).toBe("Renamed by an editor");
  // Nothing was stored under the actor's own key.
  expect(await f.as(who("u_root"), () => f.records.readDraft("u_root", "d1"))).toBeNull();
  // A stale revision (the first window never saw revision 2) is refused, whoever sends it, and the stored board is untouched.
  for (const [actor, label] of [["u_owner", "the owner"], ["u_root", "the editor"]] as const) {
    const stale = await f.as(who(actor), () => f.records.saveDraft("u_owner", { ...f.board, name: `Stale ${label}` }, 1, undefined, actor).then(() => "saved", (e: Error) => (e as { code?: string }).code ?? e.message));
    expect(stale, label).toMatch(/revision_conflict|not a person/);
  }
  const after = await f.row();
  expect(JSON.parse(String(after.body)).name).toBe("Renamed by an editor");
  expect(Number(after.revision)).toBe(2);
});

test("the share flags are the server's: no save sets or clears them", async () => {
  const f = await fixture("flags", { sample: true });
  const stored = async () => JSON.parse(String((await f.row()).body)).teamShared as boolean | undefined;
  expect(await stored()).toBeUndefined();
  // A save that says "shared" does not share a private board, whoever saves it.
  let revision = 1;
  const save = async (project: Record<string, unknown>, actor = "u_owner") => { const out = await f.as(who(actor), () => f.records.saveDraft("u_owner", project as never, revision, undefined, actor)); revision = out.revision; };
  await save({ ...f.board, teamShared: true });
  expect(await stored()).toBeUndefined();
  await save({ ...f.board, teamShared: true }, "u_root");
  expect(await stored()).toBeUndefined();
  // The action shares it (and only the flag changes: the revision is the same, the actor is recorded).
  const shared = await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "d1", { teamShared: true }, "u_owner"));
  expect(shared).toEqual({ revision, teamShared: true });
  expect(await stored()).toBe(true);
  expect(Number((await f.row()).revision)).toBe(revision);
  // A save that says "private", that never heard of the flag, or from a stale window's copy: the board stays shared.
  await save({ ...f.board, teamShared: false });
  expect(await stored()).toBe(true);
  const { teamShared: _gone, ...without } = f.board as Record<string, unknown>;
  void _gone;
  await save(without);
  expect(await stored()).toBe(true);
  await save({ ...without, name: "A teammate's change" }, "u_root");
  expect(await stored()).toBe(true);
  // Only the action takes it back.
  await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "d1", { teamShared: false }, "u_owner"));
  expect(await stored()).toBeUndefined();
  // A first save never carries a flag in: a copy of a shared board starts private.
  const copy = await f.as(who("u_owner"), () => f.records.saveDraft("u_owner", { ...f.board, id: "d2", name: "Copy", teamShared: true } as never, 0));
  expect(copy.revision).toBe(1);
  const copied = (await f.as(who("u_owner"), () => f.records.readDraft("u_owner", "d2")))!.project;
  expect(copied.teamShared).toBeUndefined();
  // No board, no change.
  expect(await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "nothing", { teamShared: true }))).toBeNull();
});

test("team-share: the owner shares and stops; a save through the route cannot; a teammate and an unreachable board are refused and nothing changes", async () => {
  const f = await fixture("action");
  const flag = async () => JSON.parse(String((await f.row()).body)).teamShared as boolean | undefined;
  // The route's save carrying the flag does nothing to it.
  const sent = await f.as(who("u_owner"), () => f.put({ ...f.board, teamShared: true }, 1));
  expect(sent.status, JSON.stringify(await sent.clone().json())).toBe(200);
  expect(await flag()).toBeUndefined();
  // The action does.
  const shared = await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", shared: true }));
  expect(await shared.json()).toMatchObject({ ok: true, shared: true });
  expect(await flag()).toBe(true);
  expect((await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", shared: "yes" }))).status).toBe(400);
  // A teammate, without or with the owner named: refused as a write to a board that is not theirs always was.
  for (const extra of [{}, { owner: "u_owner" }]) {
    const res = await f.as(who("u_mate"), () => f.post({ action: "team-share", projectId: "d1", shared: false, ...extra }));
    expect([403, 404], JSON.stringify(extra)).toContain(res.status);
  }
  expect(await flag()).toBe(true);
  // Stopping, by the owner.
  expect(await (await f.as(who("u_owner"), () => f.post({ action: "team-share", projectId: "d1", shared: false }))).json()).toMatchObject({ ok: true, shared: false });
  expect(await flag()).toBeUndefined();
  // The owner's own saves keep working with the flag absent, and a stale one is refused.
  const stale = await f.as(who("u_owner"), () => f.put({ ...f.board, name: "Late" }, 0));
  expect(stale.status).toBe(409);
});

test("a request that names someone else's key without write reach is answered as it was before: view-only for a shared board, not found for a private one; nothing is written", async () => {
  const f = await fixture("refuse");
  const before = JSON.stringify(await f.row());
  // Private: no one but the owner knows it is there.
  const priv = await f.as(who("u_mate"), () => f.put({ ...f.board, name: "Intruder" }, 1, { owner: "u_owner" }));
  const none = await f.as(who("u_mate"), () => f.put({ ...f.board, id: "dX", name: "Intruder" }, 1, { owner: "u_owner" }));
  expect(priv.status).toBe(none.status);
  expect(await priv.json()).toEqual(await none.json());
  for (const body of [{ action: "check-write", projectId: "d1", write: { writer: WRITER, seq: 1 } }, { action: "map-shot", projectId: "d1", nodeId: "n1" }, { action: "publish", projectId: "d1", expectedBibleVersion: 0 }]) {
    const res = await f.as(who("u_mate"), () => f.post({ ...body, owner: "u_owner" }));
    expect([403, 404], JSON.stringify(body)).toContain(res.status);
  }
  expect(JSON.stringify(await f.row())).toBe(before);
  // Shared with the team: still no write (view-only, naming the maker, for an active member; not found otherwise).
  await f.as(who("u_owner"), () => f.records.setBoardSharing("u_owner", "d1", { teamShared: true }));
  const afterShare = JSON.stringify(await f.row());
  const named = await f.as(who("u_mate"), () => f.put({ ...f.board, name: "Still no" }, 1, { owner: "u_owner" }));
  expect(named.status).toBeGreaterThanOrEqual(400);
  expect([403, 404]).toContain(named.status);
  expect(JSON.stringify(await f.row())).toBe(afterShare);
  // Naming your own id as the owner is just your own board.
  const own = await f.as(who("u_owner"), () => f.put({ ...f.board, name: "Mine" }, 1, { owner: "u_owner" }));
  expect(own.status).toBe(200);
});

test("with write reach (the sample's editor, #694) the route saves, checks, maps and publishes against the board's key as the actor", async () => {
  const f = await fixture("reach", { sample: true });
  // A teammate: the sample is read-only for them, as before.
  const mate = await f.as(who("u_mate"), () => f.put({ ...f.board, name: "No" }, 1, { owner: "u_owner" }));
  expect(mate.status).toBeGreaterThanOrEqual(400);
  expect(Number((await f.row()).revision)).toBe(1);
  // The platform owner acts on it, as themselves.
  const root = who("u_root");
  const saved = await f.as(root, () => f.put({ ...f.board, name: "Sample, edited" }, 1, { owner: "u_owner", write: { writer: WRITER, seq: 1 } }));
  expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
  expect(await saved.json()).toMatchObject({ revision: 2 });
  expect(await f.row()).toMatchObject({ owner: "u_owner", revision: 2, updated_by: "u_root" });
  // The save is checkable under the board's key.
  const checked = await f.as(root, () => f.post({ action: "check-write", projectId: "d1", write: { writer: WRITER, seq: 1 }, owner: "u_owner" }));
  expect(await checked.json()).toMatchObject({ landed: 2, revision: 2 });
  // Not checkable (and nothing written) under the actor's own key.
  expect(await f.as(root, () => f.records.readDraft("u_root", "d1"))).toBeNull();
  // A stale revision is refused for the actor too.
  expect((await f.as(root, () => f.put({ ...f.board, name: "Late" }, 1, { owner: "u_owner" }))).status).toBe(409);
  expect(JSON.parse(String((await f.row()).body)).name).toBe("Sample, edited");
  // Mapping a shot is recorded as the actor's; the shot belongs to the board's key.
  const mapped = await f.as(root, () => f.post({ action: "map-shot", projectId: "d1", nodeId: "n1", owner: "u_owner" }));
  const shotId = (await mapped.json()).shotId as string;
  const shot = await f.as(root, async () => (await f.database.db().execute({ sql: "SELECT created_by FROM shots WHERE id=?", args: [shotId] })).rows[0]);
  expect(shot.created_by).toBe("u_root");
  expect((await f.as(root, async () => (await f.database.db().execute({ sql: "SELECT owner FROM workbench_shots WHERE shot_id=?", args: [shotId] })).rows[0])).owner).toBe("u_owner");
  // Publishing records who published.
  const published = await f.as(root, () => f.post({ action: "publish", projectId: "d1", expectedBibleVersion: 0, owner: "u_owner" }));
  expect(published.status).toBe(200);
  const bible = await f.as(root, async () => (await f.database.db().execute({ sql: "SELECT owner FROM workbench_bibles WHERE project_id=?", args: [f.first.productionProjectId] })).rows[0]);
  expect(bible.owner).toBe("u_root");
  // Sharing stays the owner's: not the sample's editor acting on their key.
  expect((await f.as(root, () => f.post({ action: "team-share", projectId: "d1", shared: true, owner: "u_owner" }))).status).toBeGreaterThanOrEqual(400);
});

test("a board linked to an ordinary production (a starter draft, one opened from a production or a take link) is not reachable by naming its owner: nothing is read, written or fenced", async () => {
  const f = await fixture("ordinary", { sample: true });
  // The owner's other drafts: linked to the workspace's ordinary productions, as a starter or an opened production is. Their ids are derivable.
  const { createNode } = await import("../../lib/workbench/node-graph");
  const { newProject } = await import("../../lib/workbench/studio");
  await f.as(who("u_owner"), async () => {
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_ordinary','Ordinary',0)", args: [] });
    await f.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prj_ordinary','Ordinary project',0,'prod_ordinary')", args: [] });
    for (const id of ["starter-d", "opened-d"]) {
      const draft = { ...newProject(id), id, productionProjectId: "prj_ordinary", nodes: [{ ...createNode("scene", 0), id: "n1" }] };
      await f.database.db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,3,0)", args: [`u_owner:${id}`, "u_owner", id, id, JSON.stringify(draft)] });
    }
  });
  const snapshot = () => f.as(who("u_owner"), async () => JSON.stringify([(await f.database.db().execute("SELECT key,body,revision,updated_by FROM workbench_projects ORDER BY key")).rows, (await f.database.db().execute("SELECT * FROM workbench_draft_writes")).rows, (await f.database.db().execute("SELECT COUNT(*) AS n FROM workbench_bibles")).rows, (await f.database.db().execute("SELECT COUNT(*) AS n FROM workbench_shots")).rows]));
  const before = await snapshot();
  const unknown = async (who_: Who, body: Record<string, unknown>) => (await f.as(who_, () => f.post(body)));
  for (const stranger of [who("u_mate"), who("u_root")]) {
    for (const id of ["starter-d", "opened-d"]) {
      const probes = [
        { action: "check-write", projectId: id, owner: "u_owner", write: { writer: WRITER, seq: 1 } },
        { action: "map-shot", projectId: id, owner: "u_owner", nodeId: "n1" },
        { action: "publish", projectId: id, owner: "u_owner", expectedBibleVersion: 0 },
        { action: "team-share", projectId: id, owner: "u_owner", shared: true },
      ];
      // The answer for a board that is not there at all.
      const missing = await unknown(stranger, { ...probes[0], projectId: `no-such-${id}` });
      for (const probe of probes) {
        const res = await unknown(stranger, probe);
        expect([res.status, await res.clone().text().then((t) => /"project"|productionProjectId|"revision"/.test(t))], `${stranger.id} ${probe.action} ${id}`).toEqual([missing.status, false]);
      }
      const put = await f.as(stranger, () => f.put({ ...newProject(id), id, productionProjectId: "prj_ordinary", name: "Overwritten" }, 3, { owner: "u_owner" }));
      expect([put.status, await put.clone().text().then((t) => /"revision"/.test(t))], `${stranger.id} PUT ${id}`).toEqual([missing.status, false]);
    }
  }
  // Nothing was read into an answer, written, mapped, published or fenced.
  expect(await snapshot()).toBe(before);
});

test("the key must be an active member's: a disabled owner's board is not reachable even through a grant", async () => {
  const f = await fixture("disabled", { sample: true });
  const root = who("u_root");
  expect((await f.as(root, () => f.put({ ...f.board, name: "Works" }, 1, { owner: "u_owner" }))).status).toBe(200);
  await f.members.disable("u_owner");
  const refused = await f.as(root, () => f.put({ ...f.board, name: "Not now" }, 2, { owner: "u_owner" }));
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(String((await f.row()).body)).name).toBe("Works");
  const checked = await f.as(root, () => f.post({ action: "check-write", projectId: "d1", write: { writer: WRITER, seq: 9 }, owner: "u_owner" }));
  expect(checked.status).toBeGreaterThanOrEqual(400);
});
