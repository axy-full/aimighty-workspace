import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";

/*
 * Workspace settings, the server's side (prototype v14, README § V14.2; components/v12/settings/console). Everything the console
 * shows or changes goes through routes that already existed or that this change added, and each is held here the way the
 * console uses it, with real sessions in separate workspaces on the local mock server:
 *  - an admin of workspace A cannot read or change anything of workspace B, by id, by code, by name, or by forging B's scope;
 *  - a member gets only what a member gets, and every admin read and write is refused;
 *  - any admin changes roles; the owner and the last admin can neither be demoted nor removed (at once, or by leaving);
 *  - invites, role changes, removals, limits, a rename, leaving and deleting each leave a line in the workspace's history;
 *  - deleting asks for the typed name, and the server checks it;
 *  - the name-only profile change is the signed-in person's own.
 * No credit is spent and nothing is generated; local ENGINE_MOCK servers only (signInLocally checks).
 */
test.describe.configure({ mode: "serial" });
const DESKTOP = "workbench-1440x900";

type Person = { ctx: APIRequestContext; id: string; email: string; name: string; scope: string; headers: { "X-Workbench-Scope": string } };
type World = { ws: { id: string; name: string }; owner: Person };

async function me(ctx: APIRequestContext, workspaceId: string, name: string): Promise<Person> {
  const body = (await (await ctx.get("/api/me")).json()) as { id: string; email: string; name: string };
  const scope = `particl-active-${workspaceId}-${body.id}`;
  return { ctx, id: body.id, email: body.email, name: name || body.name, scope, headers: { "X-Workbench-Scope": scope } };
}
async function newWorld(browser: Browser, name: string): Promise<World> {
  const ctx = (await browser.newContext()).request;
  const { workspace } = await signInLocally(ctx, name);
  /* On a plan with no member limit, as a paid workspace is (the Invite plan holds three people). */
  await platform((db) => db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [workspace.id] }));
  return { ws: { id: workspace.id, name: workspace.name }, owner: await me(ctx, workspace.id, name) };
}
/** A person in `world`'s workspace, through the real invitation and accept routes. */
async function addPerson(browser: Browser, world: World, name: string, role: "member" | "admin" = "member"): Promise<Person> {
  const ctx = (await browser.newContext()).request;
  await signInLocally(ctx, name);
  const account = (await (await ctx.get("/api/me")).json()) as { email: string };
  const code = randomBytes(18).toString("base64url");
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)", args: [code, world.ws.id, account.email, name, role, world.owner.id, Date.now(), Date.now() + 3_600_000] });
  } finally { db.close(); }
  const accepted = await ctx.post("/api/auth/accept", { data: { code, accept: true } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  return me(ctx, world.ws.id, name);
}
const get = (p: Person, url: string) => p.ctx.get(url, { headers: p.headers });
const send = (p: Person, method: "POST" | "PATCH" | "DELETE", url: string, data?: unknown) => p.ctx.fetch(url, { method, headers: p.headers, data });
type Event = { action: string; targetType: string; targetId: string | null; actorId: string | null; details: Record<string, unknown> };
async function history(p: Person): Promise<Event[]> {
  const response = await get(p, "/api/workspaces/audit?limit=100");
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { events: Event[] }).events;
}
const lines = (events: Event[], action: string) => events.filter((e) => e.action === action);
async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}
/** A settled job on the platform's meter, so Usage has something to read. */
const spend = (workspaceId: string, author: string, credits: number) => platform((db) => db.execute({
  sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,1,?,?,?)`,
  args: [`wss_${randomBytes(6).toString("hex")}`, workspaceId, "image", "nano-banana", "nano-banana", "succeeded", credits, author, Date.now(), Date.now()],
}));

test.beforeEach(({}, info) => test.skip(info.project.name !== DESKTOP, "server rules do not depend on the window; one size runs them"));

test("an admin of one workspace cannot read or change anything of another, by id, code, name or forged scope", async ({ browser }) => {
  test.setTimeout(240_000);
  const A = await newWorld(browser, "Settings Owner A");
  const B = await newWorld(browser, "Settings Owner B");
  const bMember = await addPerson(browser, B, "Settings Member B");
  const aMember = await addPerson(browser, A, "Settings Member A");
  /* B has an open invitation, a rule of its own, a limit, and spend. */
  const invited = (await (await send(B.owner, "POST", "/api/team", { email: `pending-${randomBytes(4).toString("hex")}@example.test`, name: "Pending B", role: "member" })).json()) as { code: string };
  expect(invited.code).toBeTruthy();
  const rule = (await (await send(B.owner, "POST", "/api/rules", { text: "B keeps its skies blue.", scope: "all", apply: "prompt" })).json()) as { rule: { id: string } };
  expect((await send(B.owner, "PATCH", "/api/settings", { capWarnPct: "55" })).ok()).toBe(true);
  await spend(B.ws.id, bMember.id, 40);
  await spend(A.ws.id, aMember.id, 7);

  /* Reads: only A's own. */
  const team = (await (await get(A.owner, "/api/team")).json()) as { users: { id: string; email: string }[]; invites: { code: string }[] };
  expect(team.users.map((u) => u.id).sort()).toEqual([A.owner.id, aMember.id].sort());
  expect(JSON.stringify(team)).not.toContain(bMember.email);
  expect(team.invites.map((i) => i.code)).not.toContain(invited.code);
  const settings = (await (await get(A.owner, "/api/settings")).json()) as { settings: Record<string, string> };
  expect(settings.settings.capWarnPct).not.toBe("55");
  const rules = (await (await get(A.owner, "/api/rules")).json()) as { rules: { text: string }[] };
  expect(rules.rules.some((r) => /skies blue/.test(r.text))).toBe(false);
  const month = new Date().toISOString().slice(0, 7);
  const people = (await (await get(A.owner, `/api/usage/people?month=${month}`)).json()) as { people: { name: string; credits: number }[] };
  expect(people.people.map((p) => p.credits)).toEqual([7]);
  const boards = (await (await get(A.owner, `/api/usage/boards?month=${month}`)).json()) as { boards: { credits: number }[] };
  expect(boards.boards.reduce((n, b) => n + b.credits, 0)).toBeLessThanOrEqual(7);
  const billing = (await (await get(A.owner, "/api/billing")).json()) as { workspace: { id: string } };
  expect(billing.workspace.id).toBe(A.ws.id);
  const audit = (await (await get(A.owner, "/api/workspaces/audit?limit=100")).json()) as { events: { workspaceId: string }[] };
  expect(audit.events.every((e) => e.workspaceId === A.ws.id)).toBe(true);

  /* Writes by B's ids and codes find nothing of B's to change. */
  expect((await send(A.owner, "PATCH", `/api/team/${bMember.id}`, { role: "admin" })).status()).toBe(404);
  expect((await send(A.owner, "PATCH", `/api/team/${bMember.id}`, { disabled: true })).status()).toBe(404);
  expect((await send(A.owner, "DELETE", `/api/team/${bMember.id}`)).status()).toBe(404);
  await send(A.owner, "DELETE", `/api/team/invites/${invited.code}`);
  const stillThere = (await (await get(B.owner, "/api/team")).json()) as { invites: { code: string }[]; users: { id: string; role?: string; disabled: boolean }[] };
  expect(stillThere.invites.map((i) => i.code)).toContain(invited.code);
  expect(stillThere.users.find((u) => u.id === bMember.id)).toMatchObject({ role: "member", disabled: false });
  expect((await history(A.owner)).filter((e) => e.action === "invite.revoked")).toHaveLength(0);
  expect([400, 404]).toContain((await send(A.owner, "POST", `/api/team/invites/${invited.code}/send`)).status());
  expect((await send(A.owner, "PATCH", `/api/rules/${rule.rule.id}`, { text: "A takes B's rule" })).status()).toBe(404);
  expect((await send(A.owner, "DELETE", `/api/rules/${rule.rule.id}`)).status()).toBe(404);
  const bRules = (await (await get(B.owner, "/api/rules")).json()) as { rules: { text: string }[] };
  expect(bRules.rules.some((r) => /skies blue/.test(r.text))).toBe(true);
  /* Deleting by B's name deletes nothing (it is the session's own workspace that would go, and its name is not B's). */
  expect((await send(A.owner, "DELETE", "/api/workspaces", { name: B.ws.name })).status()).toBe(400);
  expect((await get(B.owner, "/api/me")).ok()).toBe(true);
  expect((await get(A.owner, "/api/me")).ok()).toBe(true);

  /* B's scope on A's session is refused, and B's settings stay as they were. */
  const forged = await A.owner.ctx.fetch("/api/settings", { method: "PATCH", headers: { "X-Workbench-Scope": B.owner.scope }, data: { capWarnPct: "90" } });
  expect(forged.status()).toBeGreaterThanOrEqual(400);
  expect(((await (await get(B.owner, "/api/settings")).json()) as { settings: Record<string, string> }).settings.capWarnPct).toBe("55");
  const forgedRead = await A.owner.ctx.get("/api/workspaces/audit", { headers: { "X-Workbench-Scope": B.owner.scope } });
  expect(forgedRead.status()).toBe(409);
});

test("a member reads only what a member may: every admin read and write is refused, and they see only their own spend", async ({ browser }) => {
  test.setTimeout(240_000);
  const W = await newWorld(browser, "Settings Owner M");
  const member = await addPerson(browser, W, "Settings Member M");
  await spend(W.ws.id, W.owner.id, 12);
  await spend(W.ws.id, member.id, 5);
  const month = new Date().toISOString().slice(0, 7);

  for (const [method, url, body] of [
    ["GET", "/api/team", undefined], ["POST", "/api/team", { email: "x@example.test", name: "X", role: "member" }],
    ["PATCH", `/api/team/${W.owner.id}`, { role: "member" }], ["DELETE", `/api/team/${W.owner.id}`, undefined],
    ["DELETE", "/api/team/invites/nothing", undefined], ["POST", "/api/team/invites/nothing/send", undefined],
    ["PATCH", "/api/settings", { capWarnPct: "60" }], ["POST", "/api/rules", { text: "A member's rule", scope: "all", apply: "prompt" }],
    ["PATCH", "/api/workspaces", { name: "Taken over" }], ["GET", "/api/workspaces/audit", undefined],
  ] as const) {
    const response = method === "GET" ? await get(member, url) : await send(member, method, url, body);
    expect(response.status(), `${method} ${url}`).toBeGreaterThanOrEqual(400);
    expect(response.status(), `${method} ${url}`).toBeLessThan(500);
  }
  const deleted = await send(member, "DELETE", "/api/workspaces", { name: W.ws.name });
  expect(deleted.status()).toBe(400);
  expect((await get(W.owner, "/api/me")).ok()).toBe(true);
  /* The workspace is as the owner left it: nothing the member tried took. */
  expect(((await (await get(W.owner, "/api/team")).json()) as { users: unknown[] }).users).toHaveLength(2);
  expect((await history(W.owner)).filter((e) => ["member.updated", "member.removed", "limits.updated", "workspace.renamed"].includes(e.action))).toHaveLength(0);

  /* What a member does get: the plan, their own spend and name, their own notifications. */
  expect((await get(member, "/api/billing")).ok()).toBe(true);
  expect((await get(member, "/api/me/notify")).ok()).toBe(true);
  const own = (await (await get(member, `/api/usage/people?month=${month}`)).json()) as { people: { name: string; you: boolean; credits: number }[] };
  expect(own.people).toHaveLength(1);
  expect(own.people[0]).toMatchObject({ you: true, credits: 5 });
  expect(JSON.stringify(own)).not.toContain("Settings Owner M");
  const all = (await (await get(W.owner, `/api/usage/people?month=${month}`)).json()) as { people: { credits: number; you: boolean }[] };
  expect(all.people.map((p) => p.credits).sort((a, b) => a - b)).toEqual([5, 12]);
  expect(all.people.filter((p) => p.you)).toHaveLength(1);
});

test("any admin changes roles; the owner and the last admin are never demoted or removed, at once or by leaving; each change leaves a line", async ({ browser }) => {
  test.setTimeout(300_000);
  const W = await newWorld(browser, "Settings Owner R");
  const admin = await addPerson(browser, W, "Settings Admin R", "admin");
  const other = await addPerson(browser, W, "Settings Other R");
  const third = await addPerson(browser, W, "Settings Third R");

  /* An admin who is not the owner sets roles. */
  expect((await send(admin, "PATCH", `/api/team/${other.id}`, { role: "admin" })).ok()).toBe(true);
  expect((await send(admin, "PATCH", `/api/team/${other.id}`, { role: "member" })).ok()).toBe(true);
  const roster = (await (await get(admin, "/api/team")).json()) as { canSeeRoles: boolean; users: { id: string; role: string; standing: string }[] };
  expect(roster.canSeeRoles).toBe(true);
  expect(roster.users.find((u) => u.id === other.id)?.role).toBe("member");
  /* The owner's standing is not anyone's to change. */
  for (const body of [{ role: "member" }, { disabled: true }]) expect((await send(admin, "PATCH", `/api/team/${W.owner.id}`, body)).status()).toBe(400);
  expect((await send(admin, "DELETE", `/api/team/${W.owner.id}`)).status()).toBe(400);
  /* Removing someone: a line, and they are gone. */
  expect((await send(admin, "DELETE", `/api/team/${third.id}`)).ok()).toBe(true);
  expect((await get(third, "/api/me")).status()).toBeGreaterThanOrEqual(400);
  const events = await history(W.owner);
  expect(lines(events, "member.updated").map((e) => e.details.role).filter(Boolean).sort()).toEqual(["admin", "member"]);
  expect(lines(events, "member.removed")).toHaveLength(1);
  expect(lines(events, "member.removed")[0]).toMatchObject({ targetId: third.id, actorId: admin.id });
  expect(lines(events, "member.updated")[0].actorId).toBe(admin.id);

  /* The last admin: a workspace with no owner row left (as an old one may be) must still keep one admin. */
  const X = await newWorld(browser, "Settings Admin X1");
  const y = await addPerson(browser, X, "Settings Admin X2", "admin");
  await platform((db) => db.execute({ sql: "UPDATE memberships SET role='admin' WHERE workspace_id=? AND account_id=?", args: [X.ws.id, X.owner.id] }));
  expect((await send(X.owner, "PATCH", `/api/team/${y.id}`, { role: "member" })).ok()).toBe(true);
  const alone = await send(X.owner, "PATCH", `/api/team/${X.owner.id}`, { role: "member" });
  expect(alone.status()).toBe(400);
  expect(await alone.text()).toMatch(/at least one admin/);
  expect((await send(X.owner, "POST", "/api/workspaces/leave")).status()).toBe(400);
  const stillAdmin = (await (await get(X.owner, "/api/team")).json()) as { users: { id: string; role: string }[] };
  expect(stillAdmin.users.find((u) => u.id === X.owner.id)?.role).toBe("admin");
  /* Two admins: one may go, and the one who stays cannot. */
  expect((await send(X.owner, "PATCH", `/api/team/${y.id}`, { role: "admin" })).ok()).toBe(true);
  expect((await send(y, "POST", "/api/workspaces/leave")).ok()).toBe(true);
  expect(lines(await history(X.owner), "member.left")).toHaveLength(1);
  expect((await send(X.owner, "POST", "/api/workspaces/leave")).status()).toBe(400);
  /* The owner of a workspace cannot leave it either. */
  expect((await send(W.owner, "POST", "/api/workspaces/leave")).status()).toBe(400);
});

test("invitations, limits, rename, leaving and deleting each leave a line; deleting asks for the typed name", async ({ browser }) => {
  test.setTimeout(300_000);
  const W = await newWorld(browser, "Settings Owner H");
  const admin = await addPerson(browser, W, "Settings Admin H", "admin");
  const leaver = await addPerson(browser, W, "Settings Leaver H");

  /* Invitations: made and withdrawn by an admin, named in the history by a reference, never by the link. */
  const email = `invite-${randomBytes(4).toString("hex")}@example.test`;
  const made = (await (await send(admin, "POST", "/api/team", { email, name: "Invited H", role: "member" })).json()) as { code: string };
  expect(made.code).toBeTruthy();
  const seats = ((await (await get(admin, "/api/team")).json()) as { seats: { used: number; ceiling: number | null }; invites: { code: string }[] });
  expect(seats.invites.map((i) => i.code)).toContain(made.code);
  expect(seats.seats.used).toBe(4);
  expect((await send(admin, "DELETE", `/api/team/invites/${made.code}`)).ok()).toBe(true);
  const afterInvites = await history(W.owner);
  const created = lines(afterInvites, "invite.created"), revoked = lines(afterInvites, "invite.revoked");
  expect(created).toHaveLength(1);
  expect(revoked).toHaveLength(1);
  expect(created[0]).toMatchObject({ targetType: "invite", actorId: admin.id, details: { role: "member" } });
  expect(created[0].targetId).toBe(revoked[0].targetId);
  expect(JSON.stringify(afterInvites)).not.toContain(made.code);

  /* Limits: one line per real change, none for the same value again. */
  expect((await send(admin, "PATCH", "/api/settings", { productionBudgetCredits: "500" })).ok()).toBe(true);
  expect((await send(admin, "PATCH", "/api/settings", { capWarnPct: "70" })).ok()).toBe(true);
  expect((await send(admin, "PATCH", "/api/settings", { shotCapCredits: "60" })).ok()).toBe(true);
  expect((await send(admin, "PATCH", "/api/settings", { productionBudgetCredits: "500", capWarnPct: "70" })).ok()).toBe(true);
  const limits = lines(await history(W.owner), "limits.updated");
  expect(limits.map((e) => [e.details.limit, e.details.value]).sort()).toEqual([["board", 500], ["shot", 60], ["warn", 70]]);
  expect(limits.every((e) => e.actorId === admin.id && e.targetType === "limits")).toBe(true);
  expect((await send(admin, "PATCH", "/api/settings", { capWarnPct: "0" })).status()).toBe(400);
  expect((await send(admin, "PATCH", "/api/settings", { productionBudgetCredits: "" })).ok()).toBe(true);
  expect(lines(await history(W.owner), "limits.updated")).toHaveLength(4);
  /* The default aspect is a setting too, with a fixed vocabulary. */
  expect((await send(admin, "PATCH", "/api/settings", { defaultAspect: "9:16" })).ok()).toBe(true);
  expect((await send(admin, "PATCH", "/api/settings", { defaultAspect: "7:3" })).status()).toBe(400);
  expect(((await (await get(admin, "/api/settings")).json()) as { settings: Record<string, string> }).settings.defaultAspect).toBe("9:16");

  /* Rename: the owner's. */
  expect((await send(admin, "PATCH", "/api/workspaces", { name: "By an admin" })).status()).toBeGreaterThanOrEqual(400);
  expect((await send(W.owner, "PATCH", "/api/workspaces", { name: `${W.ws.name} renamed` })).ok()).toBe(true);
  expect(lines(await history(W.owner), "workspace.renamed")).toHaveLength(1);
  const renamed = `${W.ws.name} renamed`;

  /* Leaving: a person's own membership, with a line, and their session here ends. */
  expect((await send(leaver, "POST", "/api/workspaces/leave")).ok()).toBe(true);
  expect(lines(await history(W.owner), "member.left")).toEqual([expect.objectContaining({ actorId: leaver.id, targetId: leaver.id })]);
  expect((await get(leaver, "/api/team")).status()).toBeGreaterThanOrEqual(400);

  /* Deleting: the owner only, by the exact name, checked by the server. */
  expect((await send(admin, "DELETE", "/api/workspaces", { name: renamed })).status()).toBe(400);
  expect((await send(W.owner, "DELETE", "/api/workspaces", { name: "" })).status()).toBe(400);
  expect((await send(W.owner, "DELETE", "/api/workspaces", { name: W.ws.name })).status()).toBe(400);
  expect((await send(W.owner, "DELETE", "/api/workspaces", { name: ` ${renamed.toUpperCase()} ` })).status()).toBe(400);
  expect((await get(W.owner, "/api/me")).ok()).toBe(true);
  expect((await send(W.owner, "DELETE", "/api/workspaces", { name: renamed })).ok()).toBe(true);
  const closed = await platform((db) => db.execute({ sql: "SELECT action,actor_id FROM security_audit WHERE workspace_id=? AND action='workspace.deleted'", args: [W.ws.id] }));
  expect(closed.rows).toHaveLength(1);
  expect(String(closed.rows[0].actor_id)).toBe(W.owner.id);
  expect((await get(admin, "/api/team")).status()).toBeGreaterThanOrEqual(400);
});

test("the profile change is the signed-in person's own name, and nothing else", async ({ browser }) => {
  test.setTimeout(240_000);
  const W = await newWorld(browser, "Settings Owner P");
  const member = await addPerson(browser, W, "Settings Member P");
  expect((await send(member, "PATCH", "/api/me", { name: "" })).status()).toBe(400);
  expect((await send(member, "PATCH", "/api/me", { name: "x".repeat(81) })).status()).toBe(400);
  const changed = await send(member, "PATCH", "/api/me", { name: "  Renamed   Member ", id: W.owner.id, email: "taken@example.test", role: "admin" });
  expect(changed.ok(), await changed.text()).toBe(true);
  const now = (await (await get(member, "/api/me")).json()) as { name: string; email: string; role: string; id: string };
  expect(now).toMatchObject({ name: "Renamed Member", role: "member", id: member.id });
  expect(now.email).toBe(member.email);
  const owner = (await (await get(W.owner, "/api/me")).json()) as { name: string };
  expect(owner.name).toBe("Settings Owner P");
  const roster = (await (await get(W.owner, "/api/team")).json()) as { users: { id: string; name: string }[] };
  expect(roster.users.find((u) => u.id === member.id)?.name).toBe("Renamed Member");
});
