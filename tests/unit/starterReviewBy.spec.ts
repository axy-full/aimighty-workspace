import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * The starter production's approved demo take records WHO approved it as a display name, the way every other writer does (`review_by` is a name; the account id
 * stays in `created_by`). A member who seeds it is named by their name on the Library's take, never by their account id; the platform owner, in a client
 * workspace, still reads "Particl support" there. A legacy client review link names no one at all (SOW-report #59): no approvedBy, no name, no id.
 * Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "starter-review-by-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "starter-review-by-unit-keyring-not-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const ROOT_EMAIL = `root-${run}@example.test`;
let envBefore: string | undefined;
test.beforeEach(async () => { envBefore = process.env.SUPER_ADMIN_EMAIL; process.env.SUPER_ADMIN_EMAIL = ROOT_EMAIL; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });
test.afterEach(async () => { if (envBefore === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = envBefore; (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity(); });

type Who = { id: string; name: string; email: string; role: "admin" | "member" };
const MEMBER: Who = { id: "usr_member_" + run, name: "Maya Member", email: `maya-${run}@example.test`, role: "member" };
const ROOT: Who = { id: "usr_root_" + run, name: "Particl support", email: ROOT_EMAIL, role: "admin" };
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });

function loadRoute<T>(file: string, viewer: () => Who): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: asUser(viewer()).user }), requireSession: async () => ({ user: asUser(viewer()).user }), requireRender: async () => ({ user: asUser(viewer()).user }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

async function workspace(name: string) {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  await platformReady();
  const id = `starter-rb-${name}-${run}`;
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`],
  });
  for (const w of [MEMBER, ROOT]) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [w.id, w.email, w.name, "x"] });
    await platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [id, w.id, w.role] });
  }
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

/** Seeds the starter as `seeder` through the route a person presses, then reads the approved take three ways: the row, the Library's list, a legacy client review link. */
async function seededBy(name: string, seeder: Who) {
  const ws = await workspace(name);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), shares = await import("../../lib/shares");
  let current = seeder;
  const projects = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => current);
  const jobs = loadRoute<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", () => current);
  const reviewRoute = await import("../../app/api/review/[token]/route");
  const as = <T,>(who: Who, fn: () => Promise<T>) => { current = who; return tenant.runInTenant(ws, fn, asUser(who)); };
  const opened = await as(seeder, async () => {
    await database.ready();
    /* The workspace's members as it holds them (the privacy mask reads these). */
    for (const w of [MEMBER, ROOT]) await database.db().execute({ sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,0)", args: [w.id, w.email, w.name, "x", w.role] }).catch(() => {});
    const res = await projects.POST(new Request("https://particl.test/api/workbench/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "starter" }) }), undefined as never);
    expect(res.status).toBe(200);
    return res.json() as Promise<{ seeded: boolean }>;
  });
  expect(opened.seeded).toBe(true);
  const row = await as(seeder, async () => {
    const starter = (await database.db().execute("SELECT id FROM projects WHERE starter = 1 LIMIT 1")).rows[0];
    const approved = (await database.db().execute({ sql: "SELECT review_by, created_by FROM generations WHERE project_id=? AND review_state='approved'", args: [starter.id] })).rows;
    return { projectId: String(starter.id), approved: approved.map((r) => ({ reviewBy: String(r.review_by), createdBy: String(r.created_by) })) };
  });
  /* The Library's list, read by another member. */
  const list = await as(MEMBER.id === seeder.id ? ROOT : MEMBER, async () => {
    const res = await jobs.GET(new Request(`https://particl.test/api/jobs?limit=100&projectId=${row.projectId}`), undefined as never);
    const body = (await res.json()) as { generations?: { reviewState?: string; reviewBy?: string | null }[] };
    return (body.generations ?? []).filter((j) => j.reviewState === "approved");
  });
  const { token } = await as(seeder, () => shares.mintShare({ workspaceId: ws.id, projectId: row.projectId, by: seeder.name, actorId: seeder.id }));
  const page = (await (await reviewRoute.GET(new Request(`http://x/api/review/${token}`), { params: Promise.resolve({ token }) })).json()) as { takes: Record<string, unknown>[] };
  return { row, list, guest: page.takes, guestText: JSON.stringify(page) };
}

test("seeded by a member: the approved demo take names the member, never their account id, in the Library's list; a legacy client review link names no one; created_by stays the id", async () => {
  const { row, list, guest, guestText } = await seededBy("member", MEMBER);
  expect(row.approved.length).toBeGreaterThan(0);
  for (const r of row.approved) { expect(r.reviewBy).toBe(MEMBER.name); expect(r.createdBy).toBe(MEMBER.id); }
  expect(list.length).toBeGreaterThan(0);
  for (const j of list) { expect(j.reviewBy).toBe(MEMBER.name); expect(j.reviewBy).not.toMatch(/^usr_/); }
  expect(guest.length).toBeGreaterThan(0);
  for (const t of guest) expect("approvedBy" in t).toBe(false);
  for (const who of [MEMBER.name, MEMBER.id, "Particl support"]) expect(guestText).not.toContain(who);
  expect(guestText).not.toMatch(/usr_/);
});

test("seeded by the platform owner in a client workspace: it still reads Particl support in the Library; a legacy client review link names no one", async () => {
  const { row, list, guest, guestText } = await seededBy("root", ROOT);
  expect(row.approved.length).toBeGreaterThan(0);
  expect(list.length).toBeGreaterThan(0);
  for (const r of row.approved) expect(r.reviewBy).toBe("Particl support");
  for (const j of list) expect(j.reviewBy).toBe("Particl support");
  expect(guest.length).toBeGreaterThan(0);
  for (const t of guest) expect("approvedBy" in t).toBe(false);
  for (const who of ["Particl support", ROOT.name, ROOT.id, ROOT_EMAIL]) expect(guestText).not.toContain(who);
});
