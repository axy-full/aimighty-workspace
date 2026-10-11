import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/*
 * Lane 5 · MCP tokens (Gaps B) and Team security. A token made in Settings › Connections reads, or prepares jobs a
 * person approves; neither spends. Proved through the real lib/auth.ts:
 * - the scope is read from the stored word, and an unknown word is never read as spending;
 * - a `prepare` token's only write is a prepared job: every other write is refused before any handler runs, and
 *   requireRender refuses it, so it can never approve spend, set limits, top up, approve a post or record consent;
 * - only the prepared-jobs route and the MCP transport opt in to a token's POST (a closed list, checked in the code);
 * - a person, never a token, opens or dismisses a prepared job, and releases a held take;
 * - Team security reads two-factor per person and only the three roles.
 * Neutral names only.
 */
const dir = freshDatabases("tokens");
const A = workspace(dir, "ws_tokena");
const TOKENS = [
  { id: "tok_read", userId: "owner", scope: "read", raw: rawToken(A, "1") },
  { id: "tok_prep", userId: "owner", scope: "prepare", raw: rawToken(A, "2") },
  { id: "tok_render", userId: "owner", scope: "render", raw: rawToken(A, "3") },
  { id: "tok_odd", userId: "owner", scope: "Render ", raw: rawToken(A, "4") },
];
const asToken = (raw: string): Who => ({ mode: "token", ws: A, userId: "owner", name: "Owner", role: "owner", bearer: raw });
const asOwner = (): Who => ({ mode: "session", ws: A, userId: "owner", name: "Owner", role: "owner", bearer: "" });

test.describe.configure({ mode: "serial" });

test("a token's scope is its stored word; an unknown word reads as read-only, never as spending", async () => {
  await seedPeople(A, [{ id: "owner", name: "Owner" }], TOKENS);
  const auth = await authAs(asToken(""));
  const scopes = await Promise.all(TOKENS.map(async (t) => (await auth.callerFromToken(t.raw))?.token?.scope));
  expect(scopes).toEqual(["read", "prepare", "render", "read"]);
});

test("a prepare or read token is refused every write but its own, before the handler runs; requireRender refuses both", async () => {
  for (const t of TOKENS.filter((x) => x.scope !== "render")) {
    const who = asToken(t.raw);
    const auth = await authAs(who);
    let ran = 0;
    const handler = auth.withTenant(async () => { ran++; return Response.json({ ok: true }); });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await handler(scoped(who, "http://localhost/api/anything", { method, body: method === "DELETE" ? undefined : "{}" }), undefined as never);
      expect(res.status, `${t.scope} ${method}`).toBe(403);
    }
    expect(ran, `${t.scope}: no handler ran`).toBe(0);
    /* Reading is allowed, as before. */
    expect((await handler(scoped(who, "http://localhost/api/anything"), undefined as never)).status).toBe(200);
    /* Paid routes ask requireRender: refused, whatever route it is. */
    const paid = auth.withTenant(async () => { const got = await auth.requireRender(); return got.response ?? Response.json({ spent: true }); }, { preparedJobs: true });
    const res = await paid(scoped(who, "http://localhost/api/generate", { method: "POST", body: "{}" }), undefined as never);
    expect(res.status, `${t.scope} requireRender`).toBe(403);
    /* People-only checks refuse it too. */
    const personOnly = auth.withTenant(async () => { const got = await auth.requireSession(); return got.response ?? Response.json({ ok: true }); }, { preparedJobs: true });
    expect((await personOnly(scoped(who, "http://localhost/api/settings", { method: "POST", body: "{}" }), undefined as never)).status).toBe(403);
  }
  /* The one door a prepare token's write goes through is a route that opts in. */
  const who = asToken(TOKENS[1].raw);
  const auth = await authAs(who);
  const preparing = auth.withTenant(async () => Response.json({ ok: true }), { preparedJobs: true });
  expect((await preparing(scoped(who, "http://localhost/api/prepared-jobs", { method: "POST", body: "{}" }), undefined as never)).status).toBe(200);
  expect((await preparing(scoped(who, "http://localhost/api/prepared-jobs", { method: "DELETE" }), undefined as never)).status).toBe(403);
});

test("only the prepared-jobs route and the MCP transport let a prepare token's POST through: the list is closed", () => {
  const files = (pattern: string) => spawnSync("git", ["grep", "-l", "--untracked", "-E", pattern, "--", "app/api"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  expect(files("preparedJobs: *true|mcpTransport: *true")).toEqual(["app/api/mcp/route.ts", "app/api/prepared-jobs/route.ts"]);
  /* lib/auth.ts reads only those two options for a prepare token (readOnlyPostTransport is the read token's, as before). */
  expect(readFileSync("lib/auth.ts", "utf8")).toContain("store.token?.scope==='prepare'&&!(req.method==='POST'&&(options.mcpTransport||options.preparedJobs))");
  /* The MCP transport forwards each tool to the app's own routes with the same bearer, so a tool can do no more than the token. */
  expect(readFileSync("lib/mcp.ts", "utf8")).toContain("Authorization: authorization");
});

async function preparedRoutes(who: Who) {
  const auth = await authAs(who);
  const lib = await import("../../lib/security/prepared-jobs");
  return {
    list: load<typeof import("../../app/api/prepared-jobs/route")>("app/api/prepared-jobs/route.ts", { "@/lib/auth": auth, "@/lib/security/prepared-jobs": lib }),
    one: load<typeof import("../../app/api/prepared-jobs/[id]/route")>("app/api/prepared-jobs/[id]/route.ts", { "@/lib/auth": auth, "@/lib/security/prepared-jobs": lib }),
  };
}

test("a prepare token files a job, which prices, holds and sends nothing; only a person opens or dismisses it", async () => {
  const shot = { prompt: "A slow push on a quiet street at dawn", duration: 5, resolution: "1080p", ratio: "16:9", model: "2.5" };
  const prep = asToken(TOKENS[1].raw);
  const r = await preparedRoutes(prep);
  const made = await r.list.POST(scoped(prep, "http://localhost/api/prepared-jobs", { method: "POST", body: JSON.stringify(shot) }), undefined as never);
  expect(made.status).toBe(201);
  const { job } = await made.json();
  expect(job).toMatchObject({ state: "waiting", tokenId: "tok_prep", model: "2.5", duration: 5 });
  expect(JSON.stringify(job)).not.toMatch(/credit|cost|price|usd/i);
  expect((await r.list.POST(scoped(prep, "http://localhost/api/prepared-jobs", { method: "POST", body: JSON.stringify({ ...shot, duration: 99 }) }), undefined as never)).status).toBe(400);
  /* Nothing paid exists: no take was written. */
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  expect((await runInTenant(A, () => db().execute("SELECT COUNT(*) AS n FROM generations"))).rows[0].n).toBe(0);

  /* A token can't decide on it, even the one that made it. */
  expect((await r.one.PATCH(scoped(prep, `http://localhost/api/prepared-jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ state: "opened" }) }), { params: Promise.resolve({ id: job.id }) })).status).toBe(403);
  /* Read and render tokens don't prepare; a person uses Make. */
  for (const t of [TOKENS[0], TOKENS[2]]) {
    const who = asToken(t.raw);
    const rr = await preparedRoutes(who);
    expect((await rr.list.POST(scoped(who, "http://localhost/api/prepared-jobs", { method: "POST", body: JSON.stringify(shot) }), undefined as never)).status, t.scope).toBe(403);
  }
  const owner = asOwner();
  const ro = await preparedRoutes(owner);
  expect((await ro.list.POST(scoped(owner, "http://localhost/api/prepared-jobs", { method: "POST", body: JSON.stringify(shot) }), undefined as never)).status).toBe(403);
  const waiting = await (await ro.list.GET(scoped(owner, "http://localhost/api/prepared-jobs"), undefined as never)).json();
  expect(waiting.jobs.map((j: { id: string; tokenName: string }) => [j.id, j.tokenName])).toEqual([[job.id, "token prepare"]]);
  expect((await (await ro.one.PATCH(scoped(owner, `http://localhost/api/prepared-jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ state: "dismissed" }) }), { params: Promise.resolve({ id: job.id }) })).json()).ok).toBe(true);
  /* Dismissed, not erased; and it can't be reopened. */
  expect((await (await ro.one.PATCH(scoped(owner, `http://localhost/api/prepared-jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ state: "opened" }) }), { params: Promise.resolve({ id: job.id }) })).json()).ok).toBe(false);
  const all = await import("../../lib/security/prepared-jobs").then((m) => runInTenant(A, () => m.preparedJobs({ id: job.id })));
  expect(all[0].state).toBe("dismissed");
});

test("tokens are made only by a person; a token can't make, list or revoke tokens; a new one can prepare; its secret is never stored", async () => {
  const owner = asOwner();
  const auth = await authAs(owner);
  const deps = {
    "@/lib/auth": auth, "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
    "@/lib/credits": await import("../../lib/credits"), "@/lib/cycle": await import("../../lib/cycle"), "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
    "@/lib/tokenUsage": await import("../../lib/tokenUsage"), "@/lib/securityAudit": await import("../../lib/securityAudit"),
  };
  const route = load<typeof import("../../app/api/tokens/route")>("app/api/tokens/route.ts", deps);
  const made = await route.POST(scoped(owner, "http://localhost/api/tokens", { method: "POST", body: JSON.stringify({ name: "Studio script", scope: "prepare", capCredits: 500 }) }), undefined as never);
  expect(made.status).toBe(200);
  const body = await made.json();
  expect(body).toMatchObject({ scope: "prepare", capCredits: null });
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const stored = await runInTenant(A, () => db().execute({ sql: "SELECT * FROM api_tokens WHERE id = ?", args: [body.id] }));
  expect(JSON.stringify(stored.rows)).not.toContain(body.token);
  const audit = await runInTenant(A, () => db().execute({ sql: "SELECT details FROM security_audit WHERE target_id = ?", args: [body.id] }));
  expect(String(audit.rows[0].details)).toBe('{"scope":"prepare"}');
  expect(String(audit.rows[0].details)).not.toContain(body.token);
  const minted = await auth.callerFromToken(body.token);
  expect(minted?.token?.scope).toBe("prepare");

  for (const t of TOKENS) {
    const who = asToken(t.raw);
    const tauth = await authAs(who);
    const troute = load<typeof import("../../app/api/tokens/route")>("app/api/tokens/route.ts", { ...deps, "@/lib/auth": tauth });
    expect((await troute.POST(scoped(who, "http://localhost/api/tokens", { method: "POST", body: JSON.stringify({ name: "x", scope: "render" }) }), undefined as never)).status, t.scope).toBe(403);
    expect((await troute.GET(scoped(who, "http://localhost/api/tokens"), undefined as never)).status, t.scope).toBe(403);
  }
});

test("releasing a held take and claiming an Atomik step approve spend: people only, every token refused", async () => {
  const route = (file: string, auth: unknown, extra: Record<string, unknown>) => load<{ POST: (req: Request, ctx: unknown) => Promise<Response> }>(file, { "@/lib/auth": auth, "@/lib/security/people-only": undefined, ...extra });
  const peopleOnly = await import("../../lib/security/people-only");
  let released = 0, claimed = 0;
  for (const t of TOKENS) {
    const who = asToken(t.raw);
    const auth = await authAs(who);
    const release = route("app/api/jobs/[id]/release/route.ts", auth, {
      "@/lib/security/people-only": peopleOnly,
      "@/lib/jobs": { getGeneration: async () => { released++; return null; } }, "@/lib/held": { releaseHeldJobs: async () => { released++; return { released: [] }; } },
      "@/lib/workspace/release": { mayRelease: () => true },
    });
    const claim = route("app/api/atomik/steps/[id]/claim/route.ts", auth, {
      "@/lib/security/people-only": peopleOnly,
      "@/lib/atomik": { claimStep: async () => { claimed++; return null; }, getStep: async () => { claimed++; return null; }, reconcileRunningSteps: async () => {}, stepForBrowser: (x: unknown) => x },
      "@/lib/atomikAccountStep": { ACCOUNT_STEP_NOTE: "", isAccountStep: () => false }, "@/lib/atomikThreads": { ARCHIVED_NOTE: "", threadArchived: async () => false },
    });
    expect((await release.POST(scoped(who, "http://localhost/api/jobs/g1/release", { method: "POST", body: JSON.stringify({ credits: 43 }) }), { params: Promise.resolve({ id: "g1" }) })).status, `${t.scope} release`).toBe(403);
    expect((await claim.POST(scoped(who, "http://localhost/api/atomik/steps/s1/claim", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "s1" }) })).status, `${t.scope} claim`).toBe(403);
  }
  expect([released, claimed]).toEqual([0, 0]);
  expect(peopleOnly.isPerson({ user: { id: "agent:run_1" } })).toBe(false);
  expect(peopleOnly.isPerson({ user: { id: "owner" } })).toBe(true);
});

test("Team security: two-factor per person from the account's own record, and only owner, admin and member", async () => {
  const { ROLES, roleCounts, twoFactorWords, memberLine } = await import("../../components/graphite/settings/model");
  expect(ROLES.map((r) => r.id)).toEqual(["owner", "admin", "member"]);
  expect(JSON.stringify(ROLES)).not.toMatch(/producer|editor|viewer|limit of|up to \d/i);
  expect(twoFactorWords({ twoStep: true })).toBe("two-factor on");
  expect(twoFactorWords({ twoStep: false })).toBe("two-factor off");
  expect(twoFactorWords({})).toBeNull();
  const base = { id: "u", email: "u@example.test", name: "U", disabled: false, locked: false, lastSeen: null, clips: 0 };
  expect(memberLine({ ...base, twoStep: false })).toBe("u@example.test · two-factor off · last seen never");
  expect(roleCounts({ canSeeRoles: true, invites: [], users: [{ ...base, standing: "owner", role: "admin" }, { ...base, id: "a", role: "admin", standing: "admin" }, { ...base, id: "m", role: "member", standing: "member" }, { ...base, id: "d", role: "member", disabled: true }] })).toEqual({ owner: 1, admin: 1, member: 1 });
  expect(roleCounts({ canSeeRoles: false, invites: [], users: [] })).toBeNull();

  /* The roster route reads the factor from account_security: on for one person, off for the other, nothing else of it. */
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().batch([
    { sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,0,1,'owner',0,0)", args: [A.id, A.id, "Team", A.dbUrl] },
    "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('owner','owner@example.invalid','Owner','x',0)",
    "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('member','member@example.invalid','Member','x',0)",
    { sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,created_at) VALUES(?, 'owner','owner',0)", args: [A.id] },
    { sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,created_at) VALUES(?, 'member','member',1)", args: [A.id] },
    "INSERT OR IGNORE INTO account_security(account_id,secret_enc,enabled_at) VALUES('owner','sealed-fixture',5)",
  ], "write");
  const owner = asOwner();
  const auth = await authAs(owner);
  const route = load<typeof import("../../app/api/team/route")>("app/api/team/route.ts", {
    "@/lib/auth": { ...auth, isPlatformOwner: async () => false }, "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
    "@/lib/platform": await import("../../lib/platform"), "@/lib/credits": await import("../../lib/credits"),
    "@/lib/mail": { mailConfigured: () => false, mailFrom: () => null, sendMail: async () => {}, inviteEmail: () => ({}), inviteOrigin: () => "" },
    "@/lib/accountDb": { accountFailure: () => new Response(null, { status: 500 }), AccountError: class extends Error {} },
    "@/lib/teamInvitations": { createWorkspaceInvite: async () => {}, mailWorkspaceInvite: async () => {} },
  });
  const res = await route.GET(scoped(owner, "http://localhost/api/team"), undefined as never);
  expect(res.status).toBe(200);
  const team = await res.json();
  expect(team.users.map((u: { id: string; twoStep: boolean }) => [u.id, u.twoStep])).toEqual([["owner", true], ["member", false]]);
  expect(JSON.stringify(team)).not.toContain("sealed-fixture");
  /* A token can't read the roster. */
  const tok = asToken(TOKENS[2].raw);
  const tauth = await authAs(tok);
  const troute = load<typeof import("../../app/api/team/route")>("app/api/team/route.ts", {
    "@/lib/auth": { ...tauth, isPlatformOwner: async () => false }, "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
    "@/lib/platform": await import("../../lib/platform"), "@/lib/credits": await import("../../lib/credits"),
    "@/lib/mail": {}, "@/lib/accountDb": {}, "@/lib/teamInvitations": {},
  });
  expect((await troute.GET(scoped(tok, "http://localhost/api/team"), undefined as never)).status).toBe(403);
});
