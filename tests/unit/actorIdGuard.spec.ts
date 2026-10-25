import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * An account id is never shown as a reviewer's name. Rows written before the starter stored names hold a `usr_…` id in review_by, picked_by or approved_by.
 * Readers (the jobs API, a legacy client review link, the lock prompt) read an id through the workspace's own users row to the name, and the name through the owner
 * mask; an id that names no one reads as nothing. That holds for the response of a PATCH that marks a take (which re-reads its marks). The platform owner reads "Particl support" in a client workspace and the real name in the house. The scrub also
 * matches these columns by id. Real temporary databases; sign-in is a fake that masks the session user as the real sign-in does; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "actor-id-guard-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "actor-id-guard-unit-keyring-not-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const ROOT = { email: `root-${run}@example.test`, name: "Rhea Rootname" };
const MEMBER = { email: `mia-${run}@example.test`, name: "Mia Member" };
const SUPPORT = "Particl support";
const password = "Unique-studio-password-43";

const SCOPED_ENV = ["SUPER_ADMIN_EMAIL", "OWNER_PRIVACY_SCRUB_LOCAL", "VERCEL", "VERCEL_ENV", "PARTICL_DEPLOYMENT"] as const;
let envBefore: Record<string, string | undefined> = {};
test.beforeEach(async () => {
  envBefore = Object.fromEntries(SCOPED_ENV.map((k) => [k, process.env[k]]));
  process.env.SUPER_ADMIN_EMAIL = ROOT.email;
  delete process.env.VERCEL; delete process.env.VERCEL_ENV; delete process.env.PARTICL_DEPLOYMENT;
  process.env.OWNER_PRIVACY_SCRUB_LOCAL = "1";
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
test.afterEach(async () => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});

type WS = import("../../lib/tenant").TenantWorkspace;
type Acct = { id: string; email: string; name: string };

let made: Promise<{ house: WS; client: WS; root: Acct; member: Acct }> | null = null;
/* The platform database is shared by every spec file that runs in this worker, so every row this file adds is taken out again when it is done (the house row above all: another
   spec inserts its own, and a second one is a UNIQUE failure there). */
const added = { workspaces: [] as string[], accounts: [] as string[] };
test.afterAll(async () => {
  if (!made) return;
  const { platformDb } = await import("../../lib/platform");
  const marks = (list: string[]) => list.map(() => "?").join(",");
  const client = await made.catch(() => null);
  if (client) added.workspaces.push(client.client.id);
  const db = platformDb();
  if (added.workspaces.length) {
    await db.execute({ sql: `DELETE FROM memberships WHERE workspace_id IN (${marks(added.workspaces)})`, args: added.workspaces }).catch(() => {});
    await db.execute({ sql: `DELETE FROM workspace_provisioning WHERE workspace_id IN (${marks(added.workspaces)})`, args: added.workspaces }).catch(() => {});
    await db.execute({ sql: `DELETE FROM workspaces WHERE id IN (${marks(added.workspaces)})`, args: added.workspaces }).catch(() => {});
  }
  if (added.accounts.length) await db.execute({ sql: `DELETE FROM accounts WHERE id IN (${marks(added.accounts)})`, args: added.accounts }).catch(() => {});
});
function fixture() {
  made ??= (async () => {
    const { hashPassword } = await import("../../lib/auth");
    const { createAccount, addMember, legacyWorkspace, platformDb } = await import("../../lib/platform");
    const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
    const root = await createAccount(ROOT.email, ROOT.name, hashPassword(password));
    added.accounts.push(root.id);
    if (!(await legacyWorkspace())) {
      added.workspaces.push("ws_legacy");
      await platformDb().execute({
        sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at) VALUES ('ws_legacy', 'house', 'House', '(primary)', NULL, 1, 1, ?, ?, ?)`,
        args: [root.id, Date.now(), Date.now()],
      });
    }
    const house = (await legacyWorkspace())!;
    await addMember(house, root, "admin");
    const clientOwner = await createAccount(`cleo-${run}@example.test`, "Cleo Client", hashPassword(password));
    added.accounts.push(clientOwner.id);
    const client = (await resumeWorkspace(await requestWorkspace({ owner: clientOwner, name: "Client studio" }), clientOwner.id)).workspace!;
    const member = await createAccount(MEMBER.email, MEMBER.name, hashPassword(password));
    added.accounts.push(member.id);
    await addMember(client, root, "admin");
    await addMember(client, member, "member");
    await addMember(house, member, "member");
    return { house, client, root, member };
  })();
  return made;
}

async function inTenant<T>(ws: WS, fn: () => Promise<T>, user?: unknown): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  return runInTenant(ws, async () => { await ready(); return fn(); }, user as never);
}
const sql = async (ws: WS, statement: string, args: (string | number | null)[] = []) => {
  const { db } = await import("../../lib/db");
  return inTenant(ws, async () => (await db().execute({ sql: statement, args })).rows);
};

/** A route file, its `@/…` imports real, the signed-in person fake: the session user is masked as lib/auth.ts masks it (maskSessionUser). */
function loadRoute<T>(file: string, ws: () => WS, viewer: () => Acct & { role: string }): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const session = async () => {
    const { maskSessionUser, platformOwnerIdentity } = await import("../../lib/platformOwnerPrivacy");
    const v = viewer();
    const user = { ...v, owner: false, disabled: false, lastSeen: null, createdAt: 0 };
    return { user: maskSessionUser(user, ws(), await platformOwnerIdentity()) };
  };
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: session, requireSession: session, requireRender: session },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

/** Old rows: each reviewer column holds an account id (or a name, for the control). One approved take per row, all on one shot of one project. */
async function oldRows(ws: WS, tag: string, who: { member: string; root: string }) {
  const at = Date.now();
  const project = `prj_${tag}`, shot = `shot_${tag}`;
  await sql(ws, "INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Spot', ?)", [project, at]);
  await sql(ws, "INSERT OR IGNORE INTO shots (id, project_id, code, title, position, created_at, updated_at) VALUES (?, ?, 'SH010', 'One', 0, ?, ?)", [shot, project, at, at]);
  const take = (suffix: string, by: string | null, version: number) => sql(ws,
    `INSERT INTO generations (id, project_id, shot_id, version, model, prompt, params, status, review_state, review_by, picked_by, approved_by, approved_at, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mock', 'a shot', '{}', 'succeeded', 'approved', ?, ?, ?, ?, 0, ?, ?)`, [`g_${tag}_${suffix}`, project, shot, version, by, by, by, at + version, at + version, at + version]);
  await take("member", who.member, 1);
  await take("root", who.root, 2);
  await take("unknown", "usr_nobody_" + run, 3);
  await take("name", "Plain Name", 4);
  return { project, shot };
}

const readJobs = async (ws: WS, viewer: Acct, project: string) => {
  const current = viewer;
  const jobs = loadRoute<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", () => ws, () => ({ ...current, role: "member" }));
  return inTenant(ws, async () => {
    const res = await jobs.GET(new Request(`https://particl.test/api/jobs?limit=100&projectId=${project}`), undefined as never);
    const body = (await res.json()) as { generations: { id: string; reviewBy: string | null; pickedBy: string | null; approvedBy: string | null }[] };
    return Object.fromEntries(body.generations.map((g) => [g.id, g]));
  }, { user: { ...current, role: "member", owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
};

test("a client workspace: an old row's member id reads as the member's name in the jobs API and in the lock prompt, and a client review link names no one; the owner's id reads Particl support; an unknown id reads as nothing, never the id", async () => {
  const { client, root, member } = await fixture();
  const { project, shot } = await oldRows(client, "c", { member: member.id, root: root.id });
  const g = await readJobs(client, member, project);
  for (const col of ["reviewBy", "pickedBy", "approvedBy"] as const) {
    expect(g.g_c_member[col], `member ${col}`).toBe(MEMBER.name);
    expect(g.g_c_root[col], `owner ${col}`).toBe(SUPPORT);
    expect(g.g_c_unknown[col], `unknown ${col}`).toBeNull();
    expect(g.g_c_name[col], `name ${col}`).toBe("Plain Name");
  }
  expect(JSON.stringify(g)).not.toMatch(/usr_/);
  /* A legacy client review link: an outside guest reads the approved takes, and no one's name or id (SOW-report #59). */
  const { mintShare } = await import("../../lib/shares");
  const { token } = await inTenant(client, () => mintShare({ workspaceId: client.id, projectId: project, by: MEMBER.name, actorId: member.id }));
  const review = await import("../../app/api/review/[token]/route");
  const page = (await (await review.GET(new Request(`http://x/api/review/${token}`), { params: Promise.resolve({ token }) })).json()) as { takes: Record<string, unknown>[] };
  expect(page.takes.map((t) => "approvedBy" in t)).toEqual([false, false, false, false]);
  for (const name of [MEMBER.name, SUPPORT, "Plain Name"]) expect(JSON.stringify(page)).not.toContain(name);
  expect(JSON.stringify(page)).not.toMatch(/usr_/);
  /* The lock prompt: the newest approved take of the shot names who approved it. Each take in turn is the newest. */
  const { approvedTakeOf } = await import("../../lib/shots");
  const { lockAsk } = await import("../../lib/approval");
  const byTake = async (suffix: string) => {
    await sql(client, "UPDATE generations SET approved_at = ? WHERE id = ?", [Date.now() + 10_000_000, `g_c_${suffix}`]);
    const approved = await inTenant(client, () => approvedTakeOf(shot));
    await sql(client, "UPDATE generations SET approved_at = 1 WHERE id = ?", [`g_c_${suffix}`]);
    return approved!;
  };
  const m = await byTake("member"); expect(m.by).toBe(MEMBER.name); expect(lockAsk(m.version, m.by).line).toContain(MEMBER.name);
  const r = await byTake("root"); expect(r.by).toBe(SUPPORT); expect(lockAsk(r.version, r.by).line).toContain(SUPPORT);
  const u = await byTake("unknown"); expect(u.by).toBeNull(); expect(lockAsk(u.version, u.by).line).not.toMatch(/usr_/);
});

test("the house: the owner's id reads the real name", async () => {
  const { house, root, member } = await fixture();
  const { project, shot } = await oldRows(house, "h", { member: member.id, root: root.id });
  const g = await readJobs(house, member, project);
  expect(g.g_h_root.reviewBy).toBe(ROOT.name);
  expect(g.g_h_member.approvedBy).toBe(MEMBER.name);
  expect(g.g_h_unknown.reviewBy).toBeNull();
  const { approvedTakeOf } = await import("../../lib/shots");
  await sql(house, "UPDATE generations SET approved_at = ? WHERE id = 'g_h_root'", [Date.now() + 10_000_000]);
  expect((await inTenant(house, () => approvedTakeOf(shot)))!.by).toBe(ROOT.name);
});

test("the scrub also matches the reviewer columns by the owner's account id", async () => {
  const { client, root, member } = await fixture();
  const { platformOwnerScrub } = await import("../../lib/platformOwnerScrub");
  const at = Date.now();
  for (const [id, by] of [["g_scrub_root", root.id], ["g_scrub_member", member.id]] as const)
    await sql(client, "INSERT INTO generations (id, model, prompt, params, status, review_by, picked_by, approved_by, created_at, updated_at) VALUES (?, 'mock', 'p', '{}', 'succeeded', ?, ?, ?, ?, ?)", [id, by, by, by, at, at]);
  const dry = await inTenant(client, () => platformOwnerScrub({ apply: false }));
  for (const column of ["review_by", "picked_by", "approved_by"]) expect(dry.lines.find((l) => l.table === "generations" && l.column === column)?.matched, column).toBeGreaterThanOrEqual(1);
  await inTenant(client, () => platformOwnerScrub({ apply: true }));
  const rows = Object.fromEntries((await sql(client, "SELECT id, review_by, picked_by, approved_by FROM generations WHERE id LIKE 'g_scrub_%'")).map((r) => [String(r.id), r]));
  expect(rows.g_scrub_root).toMatchObject({ review_by: SUPPORT, picked_by: SUPPORT, approved_by: SUPPORT });
  expect(rows.g_scrub_member).toMatchObject({ review_by: member.id, picked_by: member.id, approved_by: member.id });
});

test("the starter seeded by the platform owner (a real name, a session masked as the real sign-in masks it) reads Particl support, in the row and in the jobs API", async () => {
  const { client, root, member } = await fixture();
  expect(root.name).toBe(ROOT.name);
  let current: Acct & { role: string } = { ...root, role: "admin" };
  const projects = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => client, () => current);
  const res = await inTenant(client, () => projects.POST(new Request("https://particl.test/api/workbench/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "starter" }) }), undefined as never), { user: { ...current, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  expect(res.status).toBe(200);
  const starter = String((await sql(client, "SELECT id FROM projects WHERE starter = 1 LIMIT 1"))[0].id);
  const stored = (await sql(client, "SELECT review_by, created_by FROM generations WHERE project_id = ? AND review_state = 'approved'", [starter])).map((r) => ({ by: String(r.review_by), created: String(r.created_by) }));
  expect(stored.length).toBeGreaterThan(0);
  for (const r of stored) { expect(r.by).toBe(SUPPORT); expect(r.by).not.toContain(ROOT.name); expect(r.created).toBe(root.id); }
  const g = await readJobs(client, member, starter);
  const approved = Object.values(g).filter((x) => x.reviewBy);
  expect(approved.length).toBeGreaterThan(0);
  for (const x of approved) expect(x.reviewBy).toBe(SUPPORT);
  current = { ...member, role: "member" };
});

test("a PATCH that marks a take re-reads its marks: an old row's ids come back as names, never as ids", async () => {
  const { client, root, member } = await fixture();
  const { project } = await oldRows(client, "p", { member: member.id, root: root.id });
  const admin = { ...member, role: "admin" };
  const jobs = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => client, () => admin);
  const patch = (id: string, body: unknown) => inTenant(client, async () => {
    const res = await jobs.PATCH(new Request(`https://particl.test/api/jobs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
    return { status: res.status, text: await res.text() };
  }, { user: { ...admin, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  for (const [id, who] of [["g_p_member", MEMBER.name], ["g_p_root", SUPPORT], ["g_p_unknown", null]] as const) {
    const sent = await patch(id, { reviewState: "changes" });
    expect(sent.status, id).toBe(200);
    expect(sent.text, id).not.toMatch(/usr_/);
    const review = (JSON.parse(sent.text) as { review?: { pickedBy: string | null; approvedBy: string | null } }).review;
    expect(review?.approvedBy, `${id} approvedBy`).toBe(who);
    expect(review?.pickedBy, `${id} pickedBy`).toBe(who);
  }
  void project;
});

test("the owner's id is matched by id, with certainty: an unscrubbed users row that still holds the owner's real name, shared by another member, still reads Particl support", async () => {
  const { client, root } = await fixture();
  const before = (await sql(client, "SELECT name FROM users WHERE id = ?", [root.id]))[0].name as string;
  try {
    await sql(client, "UPDATE users SET name = ? WHERE id = ?", [ROOT.name, root.id]);
    await sql(client, "INSERT OR REPLACE INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_namesake', 'namesake@example.test', ?, 'x', 'member', 0)", [ROOT.name]);
    const { readableActors } = await import("../../lib/platformOwnerPrivacy");
    const shown = await inTenant(client, () => readableActors([root.id, "usr_namesake"]));
    expect(shown(root.id)).toBe(SUPPORT);
    /* The namesake is a different person: their id reads their name, which is now ambiguous with the owner's, so the mask does not claim it. */
    expect(shown("usr_namesake")).toBe(ROOT.name);
  } finally {
    await sql(client, "DELETE FROM users WHERE id = 'usr_namesake'");
    await sql(client, "UPDATE users SET name = ? WHERE id = ?", [before, root.id]);
  }
});
