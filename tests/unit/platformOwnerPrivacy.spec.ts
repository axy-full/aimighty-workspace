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

const before = process.env.SUPER_ADMIN_EMAIL;
test.beforeEach(async () => {
  process.env.SUPER_ADMIN_EMAIL = OWNER.email;
  (await import("../../lib/platformOwnerPrivacy")).resetPlatformOwnerIdentity();
});
test.afterAll(async () => {
  if (before === undefined) delete process.env.SUPER_ADMIN_EMAIL;
  else process.env.SUPER_ADMIN_EMAIL = before;
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
  const support = clientBody.users.find((u: { id: string }) => u.id === owner.id);
  expect(support).toMatchObject({ name: SUPPORT, email: "", support: true, standing: "admin" });
  expect(clientBody.users.find((u: { email: string }) => u.email === MEMBER.email)).toMatchObject({ name: MEMBER.name });
  expect(clientBody.invites).toEqual([expect.objectContaining({ name: SUPPORT, email: "", support: true })]);
  const houseBody = await (await inTenant(house, () => GET(new Request("http://x/api/team")))).json();
  expect(houseBody.users.find((u: { id: string }) => u.id === owner.id)).toMatchObject({ email: OWNER.email, name: OWNER.name });
  expect(houseBody.invites.map((i: { email: string }) => i.email)).toContain(OWNER.email);
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
  expect(dry.total).toBe(12);
  expect(dry.applied).toBe(false);
  // The dry run wrote nothing.
  expect((await sql(ws, "SELECT review_by FROM generations WHERE id='g1'"))[0].review_by).toBe(OWNER.name);

  const post = (body: unknown) => inTenant(ws, () => POST(new Request("http://x/api/admin/owner-privacy", { method: "POST", headers, body: JSON.stringify(body) })));
  expect((await post({ expected: 12 })).status).toBe(400);
  expect((await post({ confirm: true, expected: 11 })).status).toBe(409);
  const done = await (await post({ confirm: true, expected: 12 })).json();
  expect(done).toMatchObject({ applied: true, total: 12 });

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
