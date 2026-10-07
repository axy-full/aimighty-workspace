import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

/*
 * The platform owner is visible only inside the house workspace
 * (lib/platformOwnerPrivacy.ts), and what was stored before the rule is
 * rewritten only on request, after a dry run (lib/platformOwnerScrub.ts).
 * Real platform and workspace databases in a temp directory, mocked engines;
 * nothing renders and nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-owner-privacy-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;
delete process.env.RESEND_API_KEY;

/* Unique per run: specs in one worker can share the platform database. The
   underscore matters: an unescaped LIKE would read it as "any character". */
const run = Math.random().toString(36).slice(2, 8);
const OWNER = { email: `platform_owner-${run}@example.com`, name: "Pat Platform" };
const MEMBER = { email: `mia-${run}@example.com`, name: "Mia Member" };
const CLIENT = { email: `cleo-${run}@example.com`, name: "Cleo Client" };
const SUPPORT = "Particl support";

/* The rewrite's guard (scrubAllowedHere) reads where it runs from the
   environment. Each test here runs as a local machine that opted in: off
   Vercel (VERCEL and VERCEL_ENV unset) with OWNER_PRIVACY_SCRUB_LOCAL=1.
   VERCEL_ENV is cleared, not assumed absent: another spec can leave it set for
   the whole run (tests/unit/workerProbe.spec.ts sets VERCEL_ENV=preview when
   it loads, the runner loads every spec before it starts workers, and workers
   inherit its environment). What each test found is put back after it. */
const SCOPED_ENV = ["SUPER_ADMIN_EMAIL", "OWNER_PRIVACY_SCRUB_LOCAL", "VERCEL", "VERCEL_ENV"] as const;
let envBefore: Record<string, string | undefined> = {};
test.beforeEach(async () => {
  envBefore = Object.fromEntries(SCOPED_ENV.map((k) => [k, process.env[k]]));
  process.env.SUPER_ADMIN_EMAIL = OWNER.email;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  // Off Vercel the rewrite runs only when asked for explicitly; these tests ask.
  process.env.OWNER_PRIVACY_SCRUB_LOCAL = "1";
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
test.afterEach(async () => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
const password = "Unique-studio-password-43";

/** Nothing a client workspace is sent may carry the owner's address or name. */
function expectNoOwner(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(OWNER.email);
  expect(text).not.toContain(OWNER.name);
}

type WS = import("../../lib/tenant").TenantWorkspace;
type Acct = { id: string; email: string; name: string };
type Fixture = { house: WS; client: WS; owner: Acct; member: Acct; clientOwner: Acct };

async function clientWorkspace(label: string, email: string): Promise<{ ws: WS; clientOwner: Acct }> {
  const { hashPassword } = await import("../../lib/auth");
  const { createAccount } = await import("../../lib/platform");
  const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const clientOwner = await createAccount(email, label, hashPassword(password));
  const requestId = await requestWorkspace({ owner: clientOwner, name: `${label} studio` });
  return { ws: (await resumeWorkspace(requestId, clientOwner.id)).workspace!, clientOwner };
}

let made: Promise<Fixture> | null = null;
function fixture(): Promise<Fixture> {
  made ??= (async () => {
    const { hashPassword } = await import("../../lib/auth");
    const { createAccount, addMember, legacyWorkspace, platformDb } = await import("../../lib/platform");
    // The platform owner is the deployment's SUPER_ADMIN_EMAIL, and is in the house.
    const owner = await createAccount(OWNER.email, OWNER.name, hashPassword(password));
    if (!(await legacyWorkspace())) {
      await platformDb().execute({
        sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at)
              VALUES ('ws_legacy', 'house', 'House', '(primary)', NULL, 1, 1, ?, ?, ?)`,
        args: [owner.id, Date.now(), Date.now()],
      });
    }
    const house = (await legacyWorkspace())!;
    await addMember(house, owner, "admin");
    const { ws: client, clientOwner } = await clientWorkspace(CLIENT.name, CLIENT.email);
    const member = await createAccount(MEMBER.email, MEMBER.name, hashPassword(password));
    // The platform owner joins the client workspace (support), and a normal member joins both.
    await addMember(client, owner, "admin");
    await addMember(client, member, "member");
    await addMember(house, member, "member");
    // An open invitation to the owner's address.
    for (const [ws, code] of [[client, `inv-client-${run}`], [house, `inv-house-${run}`]] as const) {
      await platformDb().execute({
        sql: `INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,?,'member',?,?)`,
        args: [code, ws.id, OWNER.email, OWNER.name, Date.now(), Date.now() + 3600_000],
      });
    }
    return { house, client, owner, member, clientOwner };
  })();
  return made;
}

/** Runs a route file with its `@/lib/*` imports bound to the real modules, and the session mocked. */
async function route(file: string, user: Acct & { owner?: boolean; role?: string }) {
  const real = async (name: string) => import(`../../lib/${name}`);
  const mods: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireUser: async () => ({ user }),
      requireAdmin: async () => ({ user }),
      requireSuperAdmin: async () => ({ user }),
      isPlatformOwner: (await real("auth")).isPlatformOwner,
    },
  };
  for (const name of ["accountDb", "credits", "db", "houseWorkspace", "mail", "mentions", "originalMedia", "platform",
    "platformOwnerPrivacy", "platformOwnerScrub", "push", "security/review-link", "securityAudit", "settings", "shares",
    "teamInvitations", "tenant", "workbench/request-scope"]) mods[`@/lib/${name}`] = await real(name);
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (req: Request, ctx?: unknown) => Promise<Response>> = {};
  const req = createRequire(path.resolve(file));
  vm.runInNewContext(compiled, {
    exports, Response, Request, URL, JSON, console,
    require: (name: string) => {
      if (name in mods) return mods[name];
      if (name.startsWith("@/")) throw new Error(`unmapped import ${name}`);
      return req(name);
    },
  });
  return exports;
}

async function inTenant<T>(ws: WS, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  return runInTenant(ws, async () => { await ready(); return fn(); });
}
const sql = async (ws: WS, statement: string, args: (string | number | null)[] = []) => {
  const { db } = await import("../../lib/db");
  return inTenant(ws, async () => (await db().execute({ sql: statement, args })).rows);
};

test("the helper hides the platform owner outside the house, and only them", async () => {
  const { maskFor, mirrorIdentity, isOwnerAddress } = await import("../../lib/platformOwnerPrivacy");
  const identity = { email: OWNER.email, accountIds: ["usr_owner"] };
  const house = maskFor({ id: "ws_legacy" }, identity);
  const client = maskFor({ id: "ws_client" }, identity);
  const owner = { id: "usr_owner", email: OWNER.email, name: OWNER.name };
  const member = { id: "usr_mia", email: MEMBER.email, name: MEMBER.name };
  expect(house.name(owner)).toBe(OWNER.name);
  expect(house.members([owner, member])).toHaveLength(2);
  expect(client.name(owner)).toBe(SUPPORT);
  expect(client.name({ id: "usr_owner" })).toBe(SUPPORT);
  expect(client.name({ email: OWNER.email.toUpperCase() })).toBe(SUPPORT);
  expect(client.name(member)).toBe(MEMBER.name);
  expect(client.members([owner, member])).toEqual([member]);
  // The underscore is a character, not a wildcard; the deleted suffix is an exact prefix.
  expect(isOwnerAddress(identity, OWNER.email.replace("_", "X"))).toBe(false);
  expect(isOwnerAddress(identity, `${OWNER.email}#deleted-12`)).toBe(true);
  expect(isOwnerAddress({ email: null, accountIds: [] }, "")).toBe(false);
  expect(mirrorIdentity({ id: "ws_legacy" }, owner, identity)).toEqual({ email: OWNER.email, name: OWNER.name });
  expectNoOwner(mirrorIdentity({ id: "ws_client" }, owner, identity));
  expect(mirrorIdentity({ id: "ws_client" }, member, identity)).toEqual({ email: MEMBER.email, name: MEMBER.name });
});

test("a client workspace's own database never holds the owner's address or name; the house's does", async () => {
  const { house, client, owner, member } = await fixture();
  const clientRows = await sql(client, "SELECT id, email, name FROM users");
  expectNoOwner(clientRows);
  expect(clientRows.find((r) => r.id === owner.id)?.name).toBe(SUPPORT);
  expect(clientRows.find((r) => r.id === member.id)).toMatchObject({ email: MEMBER.email, name: MEMBER.name });
  expect((await sql(house, "SELECT email, name FROM users WHERE id=?", [owner.id]))[0]).toMatchObject({ email: OWNER.email, name: OWNER.name });
});

test("Team: the owner is one Particl support row, without an address, in a client workspace; named in the house", async () => {
  const { house, client, clientOwner, owner } = await fixture();
  const { GET } = await route("app/api/team/route.ts", { ...clientOwner, owner: true });
  const clientBody = await (await inTenant(client, () => GET(new Request("http://x/api/team")))).json();
  expectNoOwner(clientBody);
  expect(clientBody.users).toHaveLength(3);
  expect(JSON.stringify(clientBody)).not.toContain(owner.id);
  const support = clientBody.users.find((u: { support?: boolean }) => u.support);
  expect(support).toMatchObject({ name: SUPPORT, email: "", standing: "admin", lastSeen: null, twoStep: null, locked: false });
  expect(support.id).toMatch(/^support_[0-9a-f]{24}$/);
  expect(clientBody.users.find((u: { email: string }) => u.email === MEMBER.email)).toMatchObject({ name: MEMBER.name });
  expect(clientBody.invites).toEqual([expect.objectContaining({ name: SUPPORT, email: "", support: true })]);
  const houseBody = await (await inTenant(house, () => GET(new Request("http://x/api/team")))).json();
  expect(houseBody.users.find((u: { id: string }) => u.id === owner.id)).toMatchObject({ email: OWNER.email, name: OWNER.name });
  expect(houseBody.invites.map((i: { email: string }) => i.email)).toContain(OWNER.email);
});

test("Team: the client can disable and remove the support row by its own id", async () => {
  const { owner } = await fixture();
  const { addMember, platformDb } = await import("../../lib/platform");
  const { ws, clientOwner } = await clientWorkspace("Fourth client", `fourth-${run}@example.com`);
  await addMember(ws, owner, "admin");
  const viewer = { ...clientOwner, owner: true, role: "admin" };
  const { GET } = await route("app/api/team/route.ts", viewer);
  const support = (await (await inTenant(ws, () => GET(new Request("http://x/api/team")))).json()).users.find((u: { support?: boolean }) => u.support);
  const { PATCH, DELETE } = await route("app/api/team/[id]/route.ts", viewer);
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const membership = async () => (await platformDb().execute({ sql: "SELECT disabled FROM memberships WHERE workspace_id=? AND account_id=?", args: [ws.id, owner.id] })).rows[0];
  const patch = (id: string, body: unknown) => inTenant(ws, () => PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), ctx(id)));
  const lockout = async () => (await platformDb().execute({ sql: "SELECT failed_count, locked_until FROM accounts WHERE id=?", args: [owner.id] })).rows[0];
  // An id that is no one's finds no one.
  expect((await patch("support_000000000000000000000000", { disabled: true })).status).toBe(404);
  // The account is the platform's: no unlock (it would clear a platform-wide sign-in lockout), no standing.
  const lockedUntil = Date.now() + 3_600_000;
  await platformDb().execute({ sql: "UPDATE accounts SET failed_count=8, locked_until=? WHERE id=?", args: [lockedUntil, owner.id] });
  try {
    const unlock = await patch(support.id, { unlock: true });
    expect(unlock.status).toBe(403);
    expect((await unlock.json()).error).not.toContain(OWNER.email);
    expect((await patch(support.id, { role: "member" })).status).toBe(403);
    // This workspace's own membership switch works, and leaves the account's lockout alone both ways.
    expect((await patch(support.id, { disabled: true })).status).toBe(200);
    expect(Number((await membership()).disabled)).toBe(1);
    expect((await patch(support.id, { disabled: false })).status).toBe(200);
    expect(Number((await membership()).disabled)).toBe(0);
    expect(await lockout()).toMatchObject({ failed_count: 8, locked_until: lockedUntil });
  } finally {
    await platformDb().execute({ sql: "UPDATE accounts SET failed_count=0, locked_until=NULL WHERE id=?", args: [owner.id] });
  }
  expect((await patch(support.id, { disabled: true })).status).toBe(200);
  expect(Number((await membership()).disabled)).toBe(1);
  const removed = await inTenant(ws, () => DELETE(new Request("http://x", { method: "DELETE" }), ctx(support.id)));
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ ok: true, name: SUPPORT });
  expect(await membership()).toBeUndefined();
});

test("@mention list: the owner is not offered in a client workspace; teammates are", async () => {
  const { house, client, member } = await fixture();
  const { GET } = await route("app/api/members/route.ts", member);
  const clientBody = await (await inTenant(client, () => GET(new Request("http://x/api/members")))).json();
  expectNoOwner(clientBody);
  const names = clientBody.members.map((m: { name: string }) => m.name);
  expect(names).toEqual(expect.arrayContaining([MEMBER.name, CLIENT.name]));
  expect(names).not.toContain(SUPPORT);
  const houseBody = await (await inTenant(house, () => GET(new Request("http://x/api/members")))).json();
  expect(houseBody.members.map((m: { name: string }) => m.name)).toContain(OWNER.name);
});

test("comment authors: the owner's note reads Particl support in a client workspace, their name in the house", async () => {
  const { house, client, owner, member } = await fixture();
  const { GET } = await route("app/api/notes/route.ts", member);
  const notes = async (ws: WS) => {
    for (const [id, by] of [["n_owner", owner.id], ["n_member", member.id]]) {
      await sql(ws, "INSERT OR REPLACE INTO notes (id, gen_id, user_id, text, created_at) VALUES (?,?,?,?,?)", [id, "gen_1", by, "the pan slower", Date.now()]);
    }
    const body = await (await inTenant(ws, () => GET(new Request("http://x/api/notes?genId=gen_1")))).json();
    return Object.fromEntries(body.notes.map((n: { id: string; author: string }) => [n.id, n.author]));
  };
  const clientNotes = await notes(client);
  expectNoOwner(clientNotes);
  expect(clientNotes).toEqual({ n_owner: SUPPORT, n_member: MEMBER.name });
  expect(await notes(house)).toEqual({ n_owner: OWNER.name, n_member: MEMBER.name });
});

test("approval lines: what the owner approved reads Particl support in a client workspace", async () => {
  const { house, client, owner, member } = await fixture();
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  const { db } = await import("../../lib/db");
  const decided = async (ws: WS) => inTenant(ws, async () => {
    const at = Date.now();
    await db().execute({ sql: "INSERT OR REPLACE INTO atomik_chats (id, project_id, created_by, created_at, updated_at) VALUES ('chat_1', NULL, ?, ?, ?)", args: [member.id, at, at] });
    for (const [id, by] of [["step_owner", owner.id], ["step_member", member.id]]) {
      await db().execute({
        sql: "INSERT OR REPLACE INTO atomik_steps (id, chat_id, title, model, status, claimed_by, created_at, updated_at) VALUES (?, 'chat_1', ?, 'mock', 'done', ?, ?, ?)",
        args: [id, `Shot by ${id}`, by, at, at],
      });
    }
    const reply = await readApprovals({ id: member.id, role: "admin", owner: true }, at + 1000);
    return reply.decided.map((d) => ({ title: d.title, by: d.by }));
  });
  const clientLines = await decided(client);
  expectNoOwner(clientLines);
  expect(clientLines).toEqual(expect.arrayContaining([
    { title: "Shot by step_owner", by: SUPPORT },
    { title: "Shot by step_member", by: MEMBER.name },
  ]));
  expect(await decided(house)).toEqual(expect.arrayContaining([{ title: "Shot by step_owner", by: OWNER.name }]));
});

test("audit lines: the owner's actions read Particl support in a client workspace's Settings", async () => {
  const { house, client, owner, clientOwner } = await fixture();
  const { platformDb } = await import("../../lib/platform");
  const { securityAuditStatement } = await import("../../lib/securityAudit");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  for (const ws of [client, house]) {
    await platformDb().execute(securityAuditStatement({ workspaceId: ws.id, actorId: owner.id, action: "workspace.mode_changed", targetType: "workspace", targetId: ws.id }));
    await platformDb().execute(securityAuditStatement({ workspaceId: ws.id, actorId: owner.id, action: "member.updated", targetType: "member", targetId: owner.id }));
  }
  const read = async (ws: WS, viewer: Acct) => {
    const { GET } = await route("app/api/workspaces/audit/route.ts", viewer);
    return (await (await inTenant(ws, () => GET(new Request("http://x/api/workspaces/audit", {
      headers: { "X-Workbench-Scope": workbenchScopeFor(ws.id, viewer.id) },
    })))).json()) as { actors: Record<string, string> };
  };
  const clientPage = await read(client, clientOwner);
  expectNoOwner(clientPage);
  expect(clientPage.actors[owner.id]).toBe(SUPPORT);
  expect((await read(house, owner)).actors[owner.id]).toBe(OWNER.name);
});

test("names written at the time of an action, and invitation emails, never name the owner outside the house", async () => {
  const { house, client, owner, member } = await fixture();
  const { withPipelineActor } = await import("../../lib/pipeline/actor");
  const { inviteEmail, signupInviteEmail } = await import("../../lib/mail");
  const { publicActorName, publicActorEmail } = await import("../../lib/platformOwnerPrivacy");
  const actorIn = (ws: WS, id: string) => withPipelineActor(ws.id, id, async ({ user }) => user);
  const clientActor = await actorIn(client, owner.id);
  expect(clientActor.name).toBe(SUPPORT);
  expect((await actorIn(house, owner.id)).name).toBe(OWNER.name);
  expect((await actorIn(client, member.id)).name).toBe(MEMBER.name);
  // What the review, share and invite routes write: the session's name.
  const mail = inviteEmail({ name: "New person", inviter: `${clientActor.name} (${client.name})`, link: "https://example.com/invite/x", role: "member", expiresAt: Date.now() + 86_400_000 });
  expectNoOwner(mail);
  expect(mail.subject).toContain(SUPPORT);
  expect(mail.text).toMatch(/— particl studio$/);
  // The platform's sign-up invitation always comes from "Particl", and escapes what the desk typed.
  const signup = signupInviteEmail({ name: "<b>Ana</b>", link: "https://example.com/signup?invite=a&b", days: 7 });
  expectNoOwner(signup);
  expect(signup.subject).toBe("Particl invited you to particl studio");
  expect(signup.html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
  expect(signup.html).not.toContain("<b>Ana</b>");
  expect(signup.html).toContain("invite=a&amp;b");
  // The invitation re-sent from the accept page reads the inviter from the platform account.
  expect(await publicActorName(client, owner)).toBe(SUPPORT);
  expect(await publicActorName(house, owner)).toBe(OWNER.name);
  expect(await publicActorName(client, member)).toBe(MEMBER.name);
  // Lock and binding records: no address for the owner outside the house.
  expect(await publicActorEmail(client, owner)).toBeNull();
  expect(await publicActorEmail(house, owner)).toBe(OWNER.email);
  expect(await publicActorEmail(client, member)).toBe(MEMBER.email);
});

test("read time: a lock stored under the owner's address reads Particl support, and a guest's review page names no owner", async () => {
  const { house, client, owner, member } = await fixture();
  const { getElement } = await import("../../lib/elements");
  const { platformOwnerIdentity } = await import("../../lib/platformOwnerPrivacy");
  await platformOwnerIdentity();
  for (const ws of [client, house]) {
    await sql(ws, "INSERT OR REPLACE INTO elements (id, name, locked, locked_by, created_at, updated_at) VALUES ('el_owner', 'Hero', 1, ?, ?, ?)", [OWNER.email, Date.now(), Date.now()]);
    await sql(ws, "INSERT OR REPLACE INTO elements (id, name, locked, locked_by, created_at, updated_at) VALUES ('el_id', 'Car', 1, ?, ?, ?)", [owner.id, Date.now(), Date.now()]);
    await sql(ws, "INSERT OR REPLACE INTO elements (id, name, locked, locked_by, created_at, updated_at) VALUES ('el_member', 'Lamp', 1, ?, ?, ?)", [MEMBER.email, Date.now(), Date.now()]);
  }
  const lockedBy = (ws: WS, id: string) => inTenant(ws, async () => (await getElement(id))?.lockedBy);
  expect(await lockedBy(client, "el_owner")).toBe(SUPPORT);
  expect(await lockedBy(client, "el_id")).toBe(SUPPORT);
  expect(await lockedBy(client, "el_member")).toBe(MEMBER.email);
  expect(await lockedBy(house, "el_owner")).toBe(OWNER.email);

  // An older client review link: who approved each take, as the guest reads it.
  const { mintShare } = await import("../../lib/shares");
  await sql(client, "INSERT OR REPLACE INTO projects (id, name, created_at) VALUES ('prj_review', 'Spot', ?)", [Date.now()]);
  for (const [id, by] of [["g_owner_name", OWNER.name], ["g_owner_mail", OWNER.email], ["g_member", MEMBER.name]]) {
    await sql(client, `INSERT OR REPLACE INTO generations (id, project_id, model, prompt, params, status, review_state, review_by, deleted, created_at, updated_at)
      VALUES (?, 'prj_review', 'mock', 'a shot', '{}', 'succeeded', 'approved', ?, 0, ?, ?)`, [id, by, Date.now(), Date.now()]);
  }
  const { token } = await inTenant(client, () => mintShare({ workspaceId: client.id, projectId: "prj_review", by: MEMBER.name, actorId: member.id }));
  const { GET } = await route("app/api/review/[token]/route.ts", member);
  const page = await (await GET(new Request(`http://x/api/review/${token}`), { params: Promise.resolve({ token }) })).json();
  expectNoOwner(page);
  const approved = Object.fromEntries(page.takes.map((t: { id: string; approvedBy: string }) => [t.id, t.approvedBy]));
  expect(approved).toEqual({ g_owner_name: SUPPORT, g_owner_mail: SUPPORT, g_member: MEMBER.name });

  // The mask the team-canvas lock record, treatment drafts and the bible's publisher are read through.
  const { storedActorMaskHere } = await import("../../lib/platformOwnerPrivacy");
  const clientMask = await inTenant(client, () => storedActorMaskHere());
  expect([OWNER.name, `Atomik for ${OWNER.name}`, OWNER.email, owner.id, MEMBER.name, "Atomik"].map(clientMask))
    .toEqual([SUPPORT, `Atomik for ${SUPPORT}`, SUPPORT, SUPPORT, MEMBER.name, "Atomik"]);
  const houseMask = await inTenant(house, () => storedActorMaskHere());
  expect(houseMask(OWNER.name)).toBe(OWNER.name);
  const { listTreatmentVersions } = await import("../../lib/atomikDocs");
  for (const [id, version, by] of [["tv_o", 1, OWNER.name], ["tv_m", 2, MEMBER.name]] as const) {
    await sql(client, `INSERT OR REPLACE INTO treatment_versions (id, project_id, version, title, logline, setup, scenes, notes, "by", created_at) VALUES (?, 'prj_review', ?, '', '', '{}', '[]', '[]', ?, ?)`, [id, version, by, Date.now()]);
  }
  const drafts = await inTenant(client, () => listTreatmentVersions("prj_review"));
  expect(drafts.map((d) => d.by)).toEqual([MEMBER.name, SUPPORT]);
});

test("the rewrite refuses on a preview or staging deployment", async () => {
  const { owner } = await fixture();
  const { scrubAllowedHere } = await import("../../lib/platformOwnerScrub");
  // Off Vercel only with the explicit opt-in; on Vercel only in production, opt-in or not.
  expect(scrubAllowedHere({})).toBe(false);
  expect(scrubAllowedHere({ OWNER_PRIVACY_SCRUB_LOCAL: "1" })).toBe(true);
  expect(scrubAllowedHere({ OWNER_PRIVACY_SCRUB_LOCAL: "true" })).toBe(false);
  expect(scrubAllowedHere({ VERCEL: "1", VERCEL_ENV: "production" })).toBe(true);
  expect(scrubAllowedHere({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe(false);
  expect(scrubAllowedHere({ VERCEL: "1", VERCEL_ENV: "preview", OWNER_PRIVACY_SCRUB_LOCAL: "1" })).toBe(false);
  expect(scrubAllowedHere({ VERCEL: "1" })).toBe(false);
  expect(scrubAllowedHere({ VERCEL_ENV: "development" })).toBe(false);
  const { ws } = await clientWorkspace("Preview client", `preview-${run}@example.com`);
  const { GET, POST } = await route("app/api/admin/owner-privacy/route.ts", owner);
  const saved = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV, OWNER_PRIVACY_SCRUB_LOCAL: process.env.OWNER_PRIVACY_SCRUB_LOCAL };
  const refusedBoth = async () => {
    expect((await inTenant(ws, () => GET(new Request("http://x/api/admin/owner-privacy")))).status).toBe(403);
    const post = await inTenant(ws, () => POST(new Request("http://x/api/admin/owner-privacy", { method: "POST", body: JSON.stringify({ confirm: true, expected: 0 }) })));
    expect(post.status).toBe(403);
    expect((await post.json()).error).toContain("production");
  };
  try {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    await refusedBoth();
    // Off Vercel without the opt-in.
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.OWNER_PRIVACY_SCRUB_LOCAL;
    await refusedBoth();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("the rewrite itself refuses, and writes nothing, off Vercel without the opt-in and on a deployment that is not production", async () => {
  const { owner } = await fixture();
  const { addMember } = await import("../../lib/platform");
  const { platformOwnerScrub, SCRUB_REFUSED } = await import("../../lib/platformOwnerScrub");
  const { ws } = await clientWorkspace("Refused client", `refused-${run}@example.com`);
  await addMember(ws, owner, "admin");
  const at = Date.now();
  await sql(ws, "INSERT INTO generations (id, model, prompt, params, status, review_by, created_at, updated_at) VALUES ('g_refused', 'mock', 'p', '{}', 'succeeded', ?, ?, ?)", [OWNER.name, at, at]);
  const refused = async () => {
    for (const apply of [false, true]) await expect(inTenant(ws, () => platformOwnerScrub({ apply }))).rejects.toThrow(SCRUB_REFUSED);
    expect((await sql(ws, "SELECT review_by FROM generations WHERE id='g_refused'"))[0].review_by).toBe(OWNER.name);
  };
  // The hooks put the environment back after this test.
  delete process.env.OWNER_PRIVACY_SCRUB_LOCAL; // off Vercel, not opted in
  await refused();
  process.env.OWNER_PRIVACY_SCRUB_LOCAL = "true"; // only "1" opts in
  await refused();
  process.env.OWNER_PRIVACY_SCRUB_LOCAL = "1"; // the opt-in counts for nothing on a deployment
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "preview";
  await refused();
  delete process.env.VERCEL; // VERCEL_ENV alone still says a deployment
  await refused();
  process.env.VERCEL_ENV = "development";
  await refused();
  // The control: off Vercel with the opt-in, the same call runs and finds the owner's value.
  delete process.env.VERCEL_ENV;
  const dry = await inTenant(ws, () => platformOwnerScrub({ apply: false }));
  expect(dry.lines.find((l) => l.table === "generations" && l.column === "review_by")).toMatchObject({ matched: 1 });
});

test("the rewrite is optimistic: a canvas or bible that changed after the read is left and reported, and the live room is told", async () => {
  const { owner } = await fixture();
  const { addMember } = await import("../../lib/platform");
  const { platformOwnerScrub } = await import("../../lib/platformOwnerScrub");
  const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { ws } = await clientWorkspace("Fifth client", `fifth-${run}@example.com`);
  await addMember(ws, owner, "admin");
  await inTenant(ws, async () => { await teamCanvasReady(); await workbenchReady(); });
  const at = Date.now();
  const card = (lockedBy: string) => JSON.stringify({ nodes: { a: { id: "a", master: { lockedBy } } } });
  await sql(ws, "INSERT INTO workbench_team_canvas (production_id, body, revision, updated_at) VALUES ('stays', ?, 2, ?), ('moves', ?, 7, ?)", [card(OWNER.name), at, card(OWNER.name), at]);
  await sql(ws, "INSERT INTO workbench_bibles (project_id, version, owner, body, created_at) VALUES ('p', 1, ?, ?, ?), ('p', 2, ?, ?, ?)",
    [owner.id, JSON.stringify({ publishedBy: OWNER.name }), at, owner.id, JSON.stringify({ publishedBy: OWNER.name, brief: "x" }), at]);
  const { db } = await import("../../lib/db");
  // Someone saves one canvas and one bible version between the read and the write.
  const report = await inTenant(ws, () => platformOwnerScrub({
    apply: true,
    beforeWrite: async () => {
      await db().execute("UPDATE workbench_team_canvas SET revision = revision + 1 WHERE production_id = 'moves'");
      await db().execute(`UPDATE workbench_bibles SET body = '{"publishedBy":"${OWNER.name}","brief":"y"}' WHERE version = 2`);
    },
  }));
  expect(report.changed).toBe(2);
  expect(report.note).toContain("run it again");
  expect(report.lines.find((l) => l.table === "workbench_team_canvas")).toMatchObject({ matched: 2, changed: 1 });
  expect(report.lines.find((l) => l.table === "workbench_bibles")).toMatchObject({ matched: 2, changed: 1 });
  const rows = await sql(ws, "SELECT production_id, body, revision FROM workbench_team_canvas ORDER BY production_id");
  expect(rows.map((r) => [r.production_id, JSON.parse(String(r.body)).nodes.a.master.lockedBy, Number(r.revision)]))
    .toEqual([["moves", OWNER.name, 8], ["stays", SUPPORT, 3]]);
  expect((await sql(ws, "SELECT body FROM workbench_bibles ORDER BY version")).map((r) => JSON.parse(String(r.body)).publishedBy)).toEqual([SUPPORT, OWNER.name]);
  // The live room is told of the landed rewrite only: one outbox row, for the canvas that took it, saying nothing to the team.
  const ops = await sql(ws, "SELECT production_id, op_id, changed, revision, changes FROM rig_canvas_ops");
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({ production_id: "stays", op_id: "owner-privacy:3", changed: 0, revision: 3 });
  const change = JSON.parse(String(ops[0].changes))[0];
  expect(change).toMatchObject({ id: "a", made: false, fields: ["master"], before: { master: { lockedBy: OWNER.name } }, after: { master: { lockedBy: SUPPORT } } });
  // Run again: what changed is rewritten now.
  const again = await inTenant(ws, () => platformOwnerScrub({ apply: true }));
  expect(again.changed).toBeUndefined();
  expect(again.total).toBe(2);
  expect((await sql(ws, "SELECT body FROM workbench_team_canvas WHERE production_id='moves'")).map((r) => JSON.parse(String(r.body)).nodes.a.master.lockedBy)).toEqual([SUPPORT]);
});

test("the rewrite of older records: a dry run first, then only the owner's values, only in this workspace, once", async () => {
  const { owner, member, client } = await fixture();
  const { addMember, platformDb } = await import("../../lib/platform");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  const { ws, clientOwner } = await clientWorkspace("Second client", `second-${run}@example.com`);
  await addMember(ws, owner, "admin");
  await addMember(ws, member, "member");
  const at = Date.now();
  // What a workspace held before the rule.
  await sql(ws, "UPDATE users SET email=?, name=? WHERE id=?", [OWNER.email, OWNER.name, owner.id]);
  const decoy = `${OWNER.email.replace("_", "X")}#deleted-1`;
  await sql(ws, "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_decoy', ?, 'Decoy One', '!', ?)", [decoy, at]);
  await sql(ws, "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_old', ?, ?, '!', ?)", [`${OWNER.email}#deleted-9`, OWNER.name, at]);
  for (const [id, review, picked, approved] of [["g1", OWNER.name, MEMBER.name, OWNER.name], ["g2", OWNER.email, null, null], ["g3", MEMBER.name, MEMBER.name, MEMBER.name]]) {
    await sql(ws, "INSERT INTO generations (id, model, prompt, params, status, review_by, picked_by, approved_by, created_at, updated_at) VALUES (?, 'mock', 'p', '{}', 'succeeded', ?, ?, ?, ?, ?)", [id, review, picked, approved, at, at]);
  }
  for (const [id, by] of [["e1", OWNER.email], ["e2", owner.id], ["e3", MEMBER.email], ["e4", decoy]]) {
    await sql(ws, "INSERT INTO elements (id, name, locked, locked_by, created_at, updated_at) VALUES (?, 'x', 1, ?, ?, ?)", [id, by, at, at]);
  }
  for (const [id, by] of [["b1", OWNER.email], ["b2", MEMBER.email]]) {
    await sql(ws, "INSERT INTO bindings (id, shot_id, slot, element_id, created_by, created_at, updated_at) VALUES (?, ?, 'character', 'e1', ?, ?, ?)", [id, `shot_${id}`, by, at, at]);
  }
  for (const [id, user, name] of [["ev1", owner.id, OWNER.name], ["ev2", member.id, MEMBER.name]]) {
    await sql(ws, "INSERT INTO element_lock_events (id, element_id, action, by_user, by_name, at) VALUES (?, 'e1', 'lock', ?, ?, ?)", [id, user, name, at]);
  }
  await sql(ws, "INSERT INTO treatments (id, updated_by, created_at, updated_at) VALUES ('t1', ?, ?, ?)", [OWNER.name, at, at]);
  await sql(ws, "INSERT INTO notes (id, gen_id, user_id, text, mentions, created_at) VALUES ('n1', 'g1', ?, 'hi', ?, ?)", [member.id, JSON.stringify([OWNER.name, MEMBER.name]), at]);
  await sql(ws, `INSERT INTO treatment_versions (id, project_id, version, title, logline, setup, scenes, notes, "by", created_at) VALUES ('tv1', 'p', 1, '', '', '{}', '[]', '[]', ?, ?), ('tv2', 'p', 2, '', '', '{}', '[]', '[]', ?, ?)`, [OWNER.name, at, MEMBER.name, at]);
  const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
  const { workbenchReady } = await import("../../lib/workbench/records");
  await inTenant(ws, async () => { await teamCanvasReady(); await workbenchReady(); });
  const canvas = { nodes: { a: { id: "a", master: { lockedBy: OWNER.name } }, b: { id: "b", master: { lockedBy: `Atomik for ${OWNER.name}` } }, c: { id: "c", master: { lockedBy: MEMBER.name } } } };
  await sql(ws, "INSERT INTO workbench_team_canvas (production_id, body, revision, updated_at) VALUES ('prod1', ?, 4, ?), ('prod2', ?, 1, ?)",
    [JSON.stringify(canvas), at, JSON.stringify({ nodes: { d: { id: "d", master: { lockedBy: MEMBER.name } } } }), at]);
  await sql(ws, "INSERT INTO workbench_bibles (project_id, version, owner, body, created_at) VALUES ('p', 1, ?, ?, ?), ('p', 2, ?, ?, ?)",
    [owner.id, JSON.stringify({ brief: "b", publishedBy: OWNER.name }), at, member.id, JSON.stringify({ brief: "b", publishedBy: MEMBER.name }), at]);
  for (const [id, wsId] of [[`shr_mine_${run}`, ws.id], [`shr_other_${run}`, client.id]]) {
    await platformDb().execute({ sql: "INSERT INTO p_shares (id, token_hash, workspace_id, project_id, created_by, created_at, expires_at) VALUES (?, ?, ?, 'p', ?, ?, ?)", args: [id, `h_${id}`, wsId, OWNER.name, at, at + 1e6] });
  }

  const { GET, POST } = await route("app/api/admin/owner-privacy/route.ts", owner);
  const headers = { "X-Workbench-Scope": workbenchScopeFor(ws.id, owner.id), "Content-Type": "application/json" };
  const dry = await (await inTenant(ws, () => GET(new Request("http://x/api/admin/owner-privacy")))).json();
  const count = (table: string, column: string) => dry.lines.find((l: { table: string; column: string }) => l.table === table && l.column === column);
  expect(count("users", "email").matched).toBe(2);
  expect(count("generations", "review_by").matched).toBe(2);
  expect(count("generations", "picked_by").matched).toBe(0);
  expect(count("generations", "approved_by").matched).toBe(1);
  expect(count("treatments", "updated_by").matched).toBe(1);
  expect(count("elements", "locked_by").matched).toBe(2);
  expect(count("bindings", "created_by").matched).toBe(1);
  expect(count("element_lock_events", "by_name").matched).toBe(1);
  expect(count("p_shares", "created_by").matched).toBe(1);
  expect(count("notes", "mentions").matched).toBe(1);
  expect(count("treatment_versions", "by").matched).toBe(1);
  expect(count("workbench_team_canvas", "body.lockedBy").matched).toBe(1);
  expect(count("workbench_bibles", "body.publishedBy").matched).toBe(1);
  expect(dry.total).toBe(15);
  expect(dry.applied).toBe(false);
  // The dry run wrote nothing.
  expect((await sql(ws, "SELECT review_by FROM generations WHERE id='g1'"))[0].review_by).toBe(OWNER.name);

  const post = (body: unknown) => inTenant(ws, () => POST(new Request("http://x/api/admin/owner-privacy", { method: "POST", headers, body: JSON.stringify(body) })));
  expect((await post({ expected: 15 })).status).toBe(400);
  expect((await post({ confirm: true, expected: 14 })).status).toBe(409);
  const done = await (await post({ confirm: true, expected: 15 })).json();
  expect(done).toMatchObject({ applied: true, total: 15 });

  // The owner's values are gone; everyone else's are as they were.
  expectNoOwner(await sql(ws, "SELECT id, email, name FROM users WHERE id IN (?, 'usr_old')", [owner.id]));
  expect((await sql(ws, "SELECT email, name FROM users WHERE id=?", [member.id]))[0]).toMatchObject({ email: MEMBER.email, name: MEMBER.name });
  expect((await sql(ws, "SELECT email, name FROM users WHERE id=?", [clientOwner.id]))[0]).toMatchObject({ name: "Second client" });
  expect((await sql(ws, "SELECT email FROM users WHERE id='usr_decoy'"))[0].email).toBe(decoy);
  expect(await sql(ws, "SELECT id, review_by, picked_by, approved_by FROM generations ORDER BY id")).toEqual([
    expect.objectContaining({ id: "g1", review_by: SUPPORT, picked_by: MEMBER.name, approved_by: SUPPORT }),
    expect.objectContaining({ id: "g2", review_by: SUPPORT }),
    expect.objectContaining({ id: "g3", review_by: MEMBER.name, picked_by: MEMBER.name, approved_by: MEMBER.name }),
  ]);
  expect((await sql(ws, "SELECT id, locked_by FROM elements ORDER BY id")).map((r) => r.locked_by)).toEqual([SUPPORT, SUPPORT, MEMBER.email, decoy]);
  expect((await sql(ws, "SELECT created_by FROM bindings ORDER BY id")).map((r) => r.created_by)).toEqual([SUPPORT, MEMBER.email]);
  expect((await sql(ws, "SELECT by_name FROM element_lock_events ORDER BY id")).map((r) => r.by_name)).toEqual([SUPPORT, MEMBER.name]);
  expect((await sql(ws, "SELECT updated_by FROM treatments"))[0].updated_by).toBe(SUPPORT);
  expect(JSON.parse(String((await sql(ws, "SELECT mentions FROM notes WHERE id='n1'"))[0].mentions))).toEqual([SUPPORT, MEMBER.name]);
  expect((await sql(ws, `SELECT "by" AS who FROM treatment_versions ORDER BY id`)).map((r) => r.who)).toEqual([SUPPORT, MEMBER.name]);
  const canvases = await sql(ws, "SELECT production_id, body, revision FROM workbench_team_canvas ORDER BY production_id");
  const locks = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(JSON.parse(String(row.body)).nodes as Record<string, { master: { lockedBy: string } }>).map(([k, n]) => [k, n.master.lockedBy]));
  expect(locks(canvases[0])).toEqual({ a: SUPPORT, b: `Atomik for ${SUPPORT}`, c: MEMBER.name });
  expect(Number(canvases[0].revision)).toBe(5);
  expect(locks(canvases[1])).toEqual({ d: MEMBER.name });
  expect(Number(canvases[1].revision)).toBe(1);
  expect((await sql(ws, "SELECT body FROM workbench_bibles ORDER BY version")).map((r) => JSON.parse(String(r.body)).publishedBy)).toEqual([SUPPORT, MEMBER.name]);
  const shares = (await platformDb().execute({ sql: "SELECT id, created_by FROM p_shares WHERE id IN (?, ?)", args: [`shr_mine_${run}`, `shr_other_${run}`] })).rows;
  expect(Object.fromEntries(shares.map((r) => [r.id, r.created_by]))).toEqual({ [`shr_mine_${run}`]: SUPPORT, [`shr_other_${run}`]: OWNER.name });

  // A second run finds nothing left.
  expect((await (await inTenant(ws, () => GET(new Request("http://x/api/admin/owner-privacy")))).json()).total).toBe(0);
  // And the house is never rewritten.
  const { house } = await fixture();
  expect((await inTenant(house, () => GET(new Request("http://x/api/admin/owner-privacy")))).status).toBe(400);
});

test("the rewrite with SUPER_ADMIN_EMAIL unset, and a name another member shares, touches nothing it can't be sure of", async () => {
  const { owner } = await fixture();
  const { addMember, createAccount } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  const { platformOwnerScrub } = await import("../../lib/platformOwnerScrub");
  const { ws } = await clientWorkspace("Third client", `third-${run}@example.com`);
  await addMember(ws, owner, "admin");
  // Someone else here is also called "Pat Platform".
  const namesake = await createAccount(`namesake-${run}@example.com`, OWNER.name, hashPassword(password));
  await addMember(ws, namesake, "member");
  const at = Date.now();
  await sql(ws, "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_blank', '', 'Blank', '!', ?)", [at]);
  await sql(ws, "INSERT INTO generations (id, model, prompt, params, status, review_by, created_at, updated_at) VALUES ('g1', 'mock', 'p', '{}', 'succeeded', ?, ?, ?)", [OWNER.name, at, at]);
  await sql(ws, "INSERT INTO elements (id, name, locked, locked_by, created_at, updated_at) VALUES ('e1', 'x', 1, '', ?, ?)", [at, at]);
  const identity = { email: null, accountIds: [owner.id], names: [OWNER.name] };
  const dry = await inTenant(ws, () => platformOwnerScrub({ apply: false, identity }));
  expect(dry.total).toBe(0);
  expect(dry.lines.find((l) => l.table === "generations" && l.column === "review_by")).toMatchObject({ matched: 0, ambiguous: 1 });
  await inTenant(ws, () => platformOwnerScrub({ apply: true, identity }));
  expect((await sql(ws, "SELECT email, name FROM users WHERE id='usr_blank'"))[0]).toMatchObject({ email: "", name: "Blank" });
  expect((await sql(ws, "SELECT email, name FROM users WHERE id=?", [namesake.id]))[0]).toMatchObject({ name: OWNER.name });
  expect((await sql(ws, "SELECT review_by FROM generations WHERE id='g1'"))[0].review_by).toBe(OWNER.name);
  expect((await sql(ws, "SELECT locked_by FROM elements WHERE id='e1'"))[0].locked_by).toBe("");
});
