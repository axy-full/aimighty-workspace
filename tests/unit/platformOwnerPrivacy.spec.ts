import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

/*
 * The platform owner is visible only inside the house workspace
 * (lib/platformOwnerPrivacy.ts). Real platform and workspace databases in a
 * temp directory, mocked engines; nothing renders and nothing is billed.
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

/* Unique per run: specs in one worker can share the platform database. */
const run = Math.random().toString(36).slice(2, 8);
const OWNER = { email: `platform-owner-${run}@example.com`, name: "Pat Platform" };
const MEMBER = { email: `mia-${run}@example.com`, name: "Mia Member" };
const CLIENT = { email: `cleo-${run}@example.com`, name: "Cleo Client" };

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
  expect(text).not.toContain("Pat");
}

type Acct = { id: string; email: string; name: string };
type Fixture = {
  house: import("../../lib/tenant").TenantWorkspace;
  client: import("../../lib/tenant").TenantWorkspace;
  owner: Acct; member: Acct; clientOwner: Acct;
};
let made: Promise<Fixture> | null = null;
function fixture(): Promise<Fixture> {
  made ??= (async () => {
    const { hashPassword } = await import("../../lib/auth");
    const { createAccount, addMember, legacyWorkspace, platformDb } = await import("../../lib/platform");
    const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
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
    const clientOwner = await createAccount(CLIENT.email, CLIENT.name, hashPassword(password));
    const requestId = await requestWorkspace({ owner: clientOwner, name: "Client studio" });
    const client = (await resumeWorkspace(requestId, clientOwner.id)).workspace!;
    const member = await createAccount(MEMBER.email, MEMBER.name, hashPassword(password));
    // The platform owner joins the client workspace (support), and a normal member joins both.
    await addMember(client, owner, "admin");
    await addMember(client, member, "member");
    await addMember(house, member, "member");
    // An open invitation to the owner's address shows in the client's Team list too.
    for (const [ws, code] of [[client, "inv-client"], [house, "inv-house"]] as const) {
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
      isPlatformOwner: (await real("auth")).isPlatformOwner,
    },
  };
  for (const name of ["accountDb", "credits", "db", "mail", "mentions", "platform", "platformOwnerPrivacy", "push",
    "securityAudit", "teamInvitations", "tenant", "workbench/request-scope"]) mods[`@/lib/${name}`] = await real(name);
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (req: Request) => Promise<Response>> = {};
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

async function inTenant<T>(ws: Fixture["house"], fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn);
}

test("the helper hides the platform owner outside the house, and only them", async () => {
  const { maskFor, mirrorIdentity, SUPPORT_ACTOR } = await import("../../lib/platformOwnerPrivacy");
  const identity = { email: OWNER.email, accountIds: ["usr_owner"] };
  const house = maskFor({ id: "ws_legacy" }, identity);
  const client = maskFor({ id: "ws_client" }, identity);
  const owner = { id: "usr_owner", email: OWNER.email, name: OWNER.name };
  const member = { id: "usr_mia", email: MEMBER.email, name: MEMBER.name };
  expect(house.name(owner)).toBe(OWNER.name);
  expect(house.members([owner, member])).toHaveLength(2);
  expect(client.name(owner)).toBe(SUPPORT_ACTOR);
  expect(client.name({ id: "usr_owner" })).toBe(SUPPORT_ACTOR);
  expect(client.name({ email: OWNER.email.toUpperCase() })).toBe(SUPPORT_ACTOR);
  expect(client.name(member)).toBe(MEMBER.name);
  expect(client.members([owner, member])).toEqual([member]);
  expect(mirrorIdentity({ id: "ws_legacy" }, owner, identity)).toEqual({ email: OWNER.email, name: OWNER.name });
  expectNoOwner(mirrorIdentity({ id: "ws_client" }, owner, identity));
  expect(mirrorIdentity({ id: "ws_client" }, member, identity)).toEqual({ email: MEMBER.email, name: MEMBER.name });
});

test("a client workspace's own database never holds the owner's address or name; the house's does", async () => {
  const { house, client, owner, member } = await fixture();
  const { db, ready } = await import("../../lib/db");
  const users = (ws: Fixture["house"]) => inTenant(ws, async () => { await ready(); return (await db().execute("SELECT id, email, name FROM users")).rows; });
  const clientRows = await users(client);
  expectNoOwner(clientRows);
  expect(clientRows.find((r) => r.id === owner.id)?.name).toBe("Particl support");
  expect(clientRows.find((r) => r.id === member.id)).toMatchObject({ email: MEMBER.email, name: MEMBER.name });
  const houseRows = await users(house);
  expect(houseRows.find((r) => r.id === owner.id)).toMatchObject({ email: OWNER.email, name: OWNER.name });
});

test("a row written before the rule is rewritten in a client workspace and left alone in the house", async () => {
  const { house, client, owner } = await fixture();
  const { db, ready } = await import("../../lib/db");
  const { scrubOwnerFromWorkspaceDb } = await import("../../lib/platformOwnerPrivacy");
  for (const ws of [client, house]) {
    await inTenant(ws, async () => {
      await ready();
      await db().execute({ sql: "UPDATE users SET email=?, name=? WHERE id=?", args: [OWNER.email, OWNER.name, owner.id] });
      await scrubOwnerFromWorkspaceDb(db(), ws);
    });
  }
  const read = (ws: Fixture["house"]) => inTenant(ws, async () => (await db().execute({ sql: "SELECT email, name FROM users WHERE id=?", args: [owner.id] })).rows[0]);
  const scrubbed = await read(client);
  expectNoOwner(scrubbed);
  expect(scrubbed.name).toBe("Particl support");
  expect(await read(house)).toMatchObject({ email: OWNER.email, name: OWNER.name });
});

test("Team list and invitations: the owner is omitted in a client workspace and listed in the house", async () => {
  const { house, client, clientOwner, owner } = await fixture();
  const { GET } = await route("app/api/team/route.ts", { ...clientOwner, owner: true });
  const clientBody = await (await inTenant(client, () => GET(new Request("http://x/api/team")))).json();
  expectNoOwner(clientBody);
  expect(clientBody.users.map((u: { email: string }) => u.email).sort()).toEqual([CLIENT.email, MEMBER.email]);
  expect(clientBody.invites).toHaveLength(0);
  const houseBody = await (await inTenant(house, () => GET(new Request("http://x/api/team")))).json();
  expect(houseBody.users.map((u: { id: string }) => u.id)).toContain(owner.id);
  expect(houseBody.users.find((u: { id: string }) => u.id === owner.id)).toMatchObject({ email: OWNER.email, name: OWNER.name });
  expect(houseBody.invites.map((i: { email: string }) => i.email)).toContain(OWNER.email);
});

test("@mention list: the owner is not offered in a client workspace; teammates are", async () => {
  const { house, client, member } = await fixture();
  const { GET } = await route("app/api/members/route.ts", member);
  const clientBody = await (await inTenant(client, () => GET(new Request("http://x/api/members")))).json();
  expectNoOwner(clientBody);
  expect(clientBody.members.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining([MEMBER.name, CLIENT.name]));
  expect(clientBody.members.map((m: { name: string }) => m.name)).not.toContain("Particl support");
  const houseBody = await (await inTenant(house, () => GET(new Request("http://x/api/members")))).json();
  expect(houseBody.members.map((m: { name: string }) => m.name)).toContain(OWNER.name);
});

test("comment authors: the owner's note reads Particl support in a client workspace, their name in the house", async () => {
  const { house, client, owner, member } = await fixture();
  const { db, ready, now } = await import("../../lib/db");
  const { GET } = await route("app/api/notes/route.ts", member);
  const notes = async (ws: Fixture["house"]) => {
    await inTenant(ws, async () => {
      await ready();
      for (const [id, by] of [["n_owner", owner.id], ["n_member", member.id]]) {
        await db().execute({ sql: "INSERT OR REPLACE INTO notes (id, gen_id, user_id, text, created_at) VALUES (?,?,?,?,?)", args: [id, "gen_1", by, "the pan slower", now()] });
      }
    });
    const body = await (await inTenant(ws, () => GET(new Request("http://x/api/notes?genId=gen_1")))).json();
    return Object.fromEntries(body.notes.map((n: { id: string; author: string }) => [n.id, n.author]));
  };
  const clientNotes = await notes(client);
  expectNoOwner(clientNotes);
  expect(clientNotes).toEqual({ n_owner: "Particl support", n_member: MEMBER.name });
  expect(await notes(house)).toEqual({ n_owner: OWNER.name, n_member: MEMBER.name });
});

test("approval lines: what the owner approved reads Particl support in a client workspace", async () => {
  const { house, client, owner, member } = await fixture();
  const { db, ready, now } = await import("../../lib/db");
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  const decided = async (ws: Fixture["house"]) => inTenant(ws, async () => {
    await ready();
    const at = now();
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
    { title: "Shot by step_owner", by: "Particl support" },
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
  const { GET } = await route("app/api/workspaces/audit/route.ts", clientOwner);
  const read = async (ws: Fixture["house"], viewer: Acct) => (await (await inTenant(ws, () => GET(new Request("http://x/api/workspaces/audit", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(ws.id, viewer.id) },
  })))).json()) as { actors: Record<string, string> };
  const clientPage = await read(client, clientOwner);
  expectNoOwner(clientPage);
  expect(clientPage.actors[owner.id]).toBe("Particl support");
  const housePage = await (await route("app/api/workspaces/audit/route.ts", owner)).GET;
  const houseBody = await (await inTenant(house, () => housePage(new Request("http://x/api/workspaces/audit", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(house.id, owner.id) },
  })))).json();
  expect(houseBody.actors[owner.id]).toBe(OWNER.name);
});

test("names written at the time of an action, and invitation email, say Particl support in a client workspace", async () => {
  const { house, client, owner, member } = await fixture();
  const { withPipelineActor } = await import("../../lib/pipeline/actor");
  const { inviteEmail } = await import("../../lib/mail");
  const { publicActorName, publicActorEmail } = await import("../../lib/platformOwnerPrivacy");
  const actorIn = (ws: Fixture["house"], id: string) => withPipelineActor(ws.id, id, async ({ user }) => user);
  const clientActor = await actorIn(client, owner.id);
  expect(clientActor.name).toBe("Particl support");
  expect((await actorIn(house, owner.id)).name).toBe(OWNER.name);
  expect((await actorIn(client, member.id)).name).toBe(MEMBER.name);
  // What the review, share and invite routes write: the session's name.
  const mail = inviteEmail({ name: "New person", inviter: `${clientActor.name} (${client.name})`, link: "https://example.com/invite/x", role: "member", expiresAt: Date.now() + 86_400_000 });
  expectNoOwner(mail);
  expect(mail.subject).toContain("Particl support");
  expect(mail.text).toMatch(/— particl studio$/);
  // The invitation re-sent from the accept page reads the inviter from the platform account.
  expect(await publicActorName(client, owner)).toBe("Particl support");
  expect(await publicActorName(house, owner)).toBe(OWNER.name);
  expect(await publicActorName(client, member)).toBe(MEMBER.name);
  // Lock and binding records: no address for the owner outside the house.
  expect(await publicActorEmail(client, owner)).toBeNull();
  expect(await publicActorEmail(house, owner)).toBe(OWNER.email);
  expect(await publicActorEmail(client, member)).toBe(MEMBER.email);
});
