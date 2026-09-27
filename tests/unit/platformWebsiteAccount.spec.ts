import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { TenantStore } from "../../lib/tenant";
import { loadRoute } from "../helpers/routeModule";

/* The platform's designated website account (design A, step W1): designation,
   its locks and the desk's view. Local databases only; no account is read
   and nothing is sent anywhere. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-website-account-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-website-account-keyring-not-a-real-secret";
process.env.APP_ORIGIN ??= "https://particl.example";
process.env.ENGINE_MOCK = "1";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ACCESS = "website-access-private-token";
const REFRESH = "website-refresh-private-token";
let sequence = 0;
async function modules() {
  return {
    account: await import("../../lib/higgsfield-consumer/platform-account"),
    store: await import("../../lib/higgsfield-consumer/store"),
    oauth: await import("../../lib/higgsfield-consumer/oauth"),
    platform: await import("../../lib/platform"),
    tenant: await import("../../lib/tenant"),
    scope: await import("../../lib/workbench/request-scope"),
  };
}
type Identity = { workspaceId: string; userId: string };
/** Start a sign-in and return its one-use state (the callback's input). */
async function pendingSignIn(identity: Identity) {
  const { store } = await modules();
  const state = randomBytes(32).toString("base64url"), session = `session-${identity.userId}`;
  await store.storeAuthorization({
    ...identity, state, sessionHash: store.hashConsumerSecret(session), verifier: randomBytes(32).toString("base64url"),
    clientId: "https://particl.example/api/higgsfield/consumer/client", redirectUri: "https://particl.example/api/higgsfield/consumer/callback",
  });
  return { state, sessionHash: store.hashConsumerSecret(session) };
}
/** Sign `identity` in as the account `subject` (null: an answer that named no account). */
async function signIn(identity: Identity, subject: string | null, expiresAt = Date.now() + 3_600_000) {
  const { store } = await modules();
  const flow = await pendingSignIn(identity);
  const authorization = await store.consumeAuthorization(flow.state, { ...identity, sessionHash: flow.sessionHash });
  expect(authorization).toBeTruthy();
  expect(await store.completeAuthorization(authorization!, {
    accessToken: ACCESS, refreshToken: REFRESH, expiresAt, scope: "openid email offline_access",
    clientId: authorization!.clientId, redirectUri: authorization!.redirectUri,
  }, Date.now(), subject)).toBe(true);
}
/** A live workspace owned by a fresh account, whose owner has connected the account `subject`. */
async function host(options: { subject?: string | null; connected?: boolean; role?: "owner" | "member" } = {}): Promise<Identity & { subject: string | null }> {
  const { platform } = await modules();
  await platform.platformReady();
  const n = ++sequence, workspaceId = `ws_webacct${n}${randomBytes(3).toString("hex")}`, userId = `acct_webacct_${n}`;
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)",
      args: [workspaceId, workspaceId, `Host studio ${n}`, `file:${path.join(directory, `${workspaceId}.db`)}`, userId] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [workspaceId, userId, options.role ?? "owner"] },
  ], "write");
  const subject = options.subject === undefined ? sha(`issuer\nsubject-${n}`) : options.subject;
  const identity = { workspaceId, userId };
  if (options.connected !== false) await signIn(identity, subject);
  return { ...identity, subject };
}
const refusal = (code: string, status = 409) => expect.objectContaining({ code, status });
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("designation pins the owner's own connected account and fences a sign-in started before it", async () => {
  const { account, store, platform } = await modules();
  const owner = await host();
  const earlier = await pendingSignIn(owner);
  await account.designatePlatformAccount(owner, owner.userId);
  // A callback for a sign-in begun before the designation can no longer replace the grant.
  expect(await store.consumeAuthorization(earlier.state, { ...owner, sessionHash: earlier.sessionHash })).toBeNull();
  expect(await account.isDesignatedIdentity(owner)).toBe(true);
  expect(await account.isDesignatedWorkspace(owner.workspaceId)).toBe(true);
  expect(await account.isDesignatedIdentity({ ...owner, userId: "someone-else" })).toBe(false);
  const health = await account.platformAccountHealth();
  expect(health.reason).toBeNull();
  expect(health.designation).toEqual({ workspaceId: owner.workspaceId, userId: owner.userId, subjectHash: owner.subject, enabledTools: [], pausedAt: null, designatedBy: owner.userId, designatedAt: expect.any(Number) });
  const access = await account.platformAccountAccess();
  expect(access).toMatchObject({ accessToken: ACCESS, host: { workspaceId: owner.workspaceId, userId: owner.userId } });
  const audit = await platform.platformDb().execute({ sql: "SELECT action,target_type,actor_id FROM security_audit WHERE workspace_id=?", args: [owner.workspaceId] });
  expect(audit.rows.map((row) => ({ ...row }))).toEqual([{ action: "website_account.designated", target_type: "connection", actor_id: owner.userId }]);
});

test("only a live, connected, known account that the caller owns can be designated", async () => {
  const { account, platform } = await modules();
  const unconnected = await host({ connected: false });
  await expect(account.designatePlatformAccount(unconnected, unconnected.userId)).rejects.toEqual(refusal("not_connected"));
  const unknown = await host({ subject: null });
  await expect(account.designatePlatformAccount(unknown, unknown.userId)).rejects.toEqual(refusal("account_unknown"));
  const member = await host({ role: "member" });
  await expect(account.designatePlatformAccount(member, member.userId)).rejects.toEqual(refusal("not_owner", 403));
  const other = await host();
  // Never someone else's connection, even the platform owner's own request for it.
  await expect(account.designatePlatformAccount(other, "platform-owner")).rejects.toEqual(refusal("not_owner", 403));
  await platform.platformDb().execute({ sql: "UPDATE workspaces SET deleted_at=? WHERE id=?", args: [Date.now(), other.workspaceId] });
  await expect(account.designatePlatformAccount(other, other.userId)).rejects.toEqual(refusal("not_owner", 403));
  for (const refused of [unconnected, unknown, member, other]) expect(await account.isDesignatedIdentity(refused)).toBe(false);
});

test("a pause, another account, a disconnect, a refused grant or a lost host closes new work, and nothing is read", async () => {
  const { account, store, platform } = await modules();
  let reads = 0;
  const fetcher = (async () => { reads++; return Response.json({}); }) as typeof fetch;
  const closed = async (reason: string) => {
    expect((await account.platformAccountHealth()).reason).toBe(reason);
    const error = await account.platformAccountAccess({ fetch: fetcher }).catch((e) => e);
    expect(error).toBeInstanceOf(account.WebsiteToolsUnavailableError);
    expect(error).toMatchObject({ code: "website_unavailable", status: 503, paidAttempted: false, message: "Website tools are temporarily unavailable. Nothing was charged." });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(ACCESS);
  };

  const paused = await host();
  await account.designatePlatformAccount(paused, paused.userId);
  await account.setPlatformAccountPaused(true, paused.userId);
  await closed("paused");
  await account.setPlatformAccountPaused(false, paused.userId);
  expect((await account.platformAccountHealth()).reason).toBeNull();

  const replaced = await host();
  await account.designatePlatformAccount(replaced, replaced.userId);
  // Even a sign-in that slipped past the locks, by a different account, can never serve under the pin.
  await signIn(replaced, sha("issuer\nanother-account"));
  await closed("account_changed");
  expect(await store.claimConsumerAccess({ ...replaced, expectedSubjectHash: replaced.subject! })).toEqual({ kind: "changed" });

  const removed = await host();
  await account.designatePlatformAccount(removed, removed.userId);
  await store.disconnectConsumer(removed);
  await closed("disconnected");

  const refused = await host();
  await account.designatePlatformAccount(refused, refused.userId);
  await platform.platformDb().execute({ sql: "UPDATE higgsfield_consumer_connections SET status='reconnect_required' WHERE workspace_id=? AND user_id=?", args: [refused.workspaceId, refused.userId] });
  await closed("reconnect");

  const suspended = await host();
  await account.designatePlatformAccount(suspended, suspended.userId);
  await platform.platformDb().execute({ sql: "UPDATE workspaces SET suspended_at=? WHERE id=?", args: [Date.now(), suspended.workspaceId] });
  await closed("workspace_unavailable");

  const demoted = await host();
  await account.designatePlatformAccount(demoted, demoted.userId);
  await platform.platformDb().execute({ sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?", args: [demoted.workspaceId, demoted.userId] });
  await closed("workspace_unavailable");

  const released = await host();
  await account.designatePlatformAccount(released, released.userId);
  await account.releasePlatformAccount(released.userId);
  await closed("unset");
  expect(await account.isDesignatedIdentity(released)).toBe(false);
  expect(await account.isDesignatedWorkspace(released.workspaceId)).toBe(false);
  await expect(account.setPlatformAccountPaused(true, released.userId)).rejects.toEqual(refusal("not_designated"));
  expect(reads).toBe(0);
});

test("the same connection again keeps its tools and pause; another starts with every tool off", async () => {
  const { account } = await modules();
  const first = await host();
  await account.designatePlatformAccount(first, first.userId);
  await account.setPlatformAccountTools(["shorts", "marketing-video", "shorts"], first.userId);
  await account.setPlatformAccountPaused(true, first.userId);
  const before = (await account.readPlatformDesignation())!;
  expect(before.enabledTools).toEqual(["marketing-video", "shorts"]);
  await account.designatePlatformAccount(first, first.userId, before.designatedAt + 5_000);
  const again = (await account.readPlatformDesignation())!;
  expect(again).toMatchObject({ enabledTools: ["marketing-video", "shorts"], designatedAt: before.designatedAt });
  expect(again.pausedAt).not.toBeNull();
  const second = await host();
  await account.designatePlatformAccount(second, second.userId);
  expect(await account.readPlatformDesignation()).toMatchObject({ workspaceId: second.workspaceId, userId: second.userId, subjectHash: second.subject, enabledTools: [], pausedAt: null });
  // Moving on unlocks the first connection and its workspace.
  expect(await account.isDesignatedIdentity(first)).toBe(false);
  expect(await account.isDesignatedWorkspace(first.workspaceId)).toBe(false);
});

test("the allowlist refuses unknown tools, and a fixed-price tool needs its private price first", async () => {
  const { account } = await modules();
  const owner = await host();
  await account.designatePlatformAccount(owner, owner.userId);
  await expect(account.setPlatformAccountTools(["marketing-video", "genjutsu"], owner.userId)).rejects.toEqual(refusal("tool_unknown", 400));
  await expect(account.setPlatformAccountTools([{ id: "shorts" }], owner.userId)).rejects.toEqual(refusal("tool_unknown", 400));
  await withEnv({ HF_ACCOUNT_FIXED_CREDITS: undefined }, async () => {
    await expect(account.setPlatformAccountTools(["voice-change"], owner.userId)).rejects.toEqual(refusal("tool_unpriced"));
    expect((await account.readPlatformDesignation())!.enabledTools).toEqual([]);
  });
  await withEnv({ HF_ACCOUNT_FIXED_CREDITS: JSON.stringify({ "voice-change": 12, dubbing: -1, "element-build": "9", "soul-build": 9 }) }, async () => {
    await account.setPlatformAccountTools(["voice-change", "reframe"], owner.userId);
    expect((await account.readPlatformDesignation())!.enabledTools).toEqual(["reframe", "voice-change"]);
    await expect(account.setPlatformAccountTools(["dubbing"], owner.userId)).rejects.toEqual(refusal("tool_unpriced"));
    await expect(account.setPlatformAccountTools(["element-build"], owner.userId)).rejects.toEqual(refusal("tool_unpriced"));
    // Priced or not, a tool the commercial API serves never runs on the website account.
    await expect(account.setPlatformAccountTools(["soul-build"], owner.userId)).rejects.toEqual(refusal("tool_on_api"));
  });
});

test("the desk's view names states and tools, never a token, grant, account hash, wallet or rate", async () => {
  const { account, platform } = await modules();
  const owner = await host();
  const visitor = await host();
  await account.designatePlatformAccount(owner, owner.userId);
  const generation = String((await platform.platformDb().execute({ sql: "SELECT generation FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?", args: [owner.workspaceId, owner.userId] })).rows[0].generation);
  await withEnv({ HF_ACCOUNT_CREDIT_USD: "0.0123", HF_ACCOUNT_FIXED_CREDITS: JSON.stringify({ dubbing: 40 }) }, async () => {
    const mine = await account.platformAccountStatus(owner);
    expect(mine).toMatchObject({ state: "ready", reason: null, host: { workspaceName: expect.stringMatching(/^Host studio/), yours: true }, candidate: { eligible: true }, rateSet: true });
    expect(mine.tools.find((tool) => tool.id === "dubbing")).toEqual({ id: "dubbing", label: "Dub", pricing: "fixed", enabled: false, priceSet: true, onApi: false });
    // Identity builds run on the commercial API for every workspace: never switchable here.
    expect(mine.tools.find((tool) => tool.id === "soul-build")).toMatchObject({ onApi: true });
    expect(mine.tools.find((tool) => tool.id === "voice-change")).toMatchObject({ priceSet: false });
    const theirs = await account.platformAccountStatus(visitor);
    expect(theirs).toMatchObject({ host: { yours: false }, candidate: { eligible: true } });
    for (const view of [mine, theirs, await account.platformAccountStatus(null)]) {
      const text = JSON.stringify(view);
      for (const secret of [ACCESS, REFRESH, generation, owner.subject!, "0.0123", owner.userId, owner.workspaceId]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/"(credits|price|usd|balance|wallet|token|generation|subject\w*)":/i);
    }
  });
  expect((await account.platformAccountStatus(null)).rateSet).toBe(false);
});

/* ── Routes ─────────────────────────────────────────────────────────────── */

const nextServer = () => createRequire(path.resolve("package.json"))("next/server");
async function adminRoute(ctx: () => unknown) {
  const { account, scope } = await modules();
  const auth = await import("../../lib/auth");
  const accountDb = await import("../../lib/accountDb");
  const backfilled: unknown[] = [];
  const route = loadRoute<{ GET: () => Promise<Response>; POST: (req: Request) => Promise<Response> }>("app/api/admin/website-account/route.ts", {
    "next/server": nextServer(),
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/auth": { requireSuperAdmin: auth.requireSuperAdmin, currentContext: async () => ctx() },
    "@/lib/accountDb": { AccountError: accountDb.AccountError, sameOriginProblem: accountDb.sameOriginProblem, takeAccountLimit: async () => {} },
    "@/lib/workbench/request-scope": scope,
    "@/lib/higgsfield-consumer/oauth": { backfillConsumerSubject: async (identity: unknown) => { backfilled.push(identity); return true; } },
    "@/lib/higgsfield-consumer/platform-account": account,
  });
  return { route, backfilled };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://particl.example/api/admin/website-account", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the desk route opens to the platform owner's browser session alone, and designates only their own connection", async () => {
  const { tenant, scope } = await modules();
  const owner = await host();
  const admin = { id: owner.userId, email: "platform-owner@example.test", name: "Owner", role: "admin", owner: true } as TenantStore["user"];
  const workspace = { id: owner.workspaceId } as TenantStore["workspace"];
  let ctx: unknown = { user: admin, workspace, role: "owner", workspaces: [] };
  const { route, backfilled } = await adminRoute(() => ctx);
  await withEnv({ SUPER_ADMIN_EMAIL: "platform-owner@example.test" }, async () => {
    const as = (store: TenantStore, fn: () => Promise<Response>) => tenant.runWithStore(store, fn);
    const signedIn = { workspace, user: admin } as TenantStore;
    // Somebody who is not the platform owner; an API token of the platform owner.
    expect((await as({ workspace, user: { ...admin!, email: "member@example.test" } }, () => route.GET())).status).toBe(403);
    const token = { ...signedIn, token: { id: "t", name: "Render", scope: "render" as const, capUsd: null } };
    expect((await as(token, () => route.GET())).status).toBe(403);
    expect((await as(token, () => route.POST(post({ action: "designate" }, { "X-Workbench-Scope": scope.workbenchScopeFor(owner.workspaceId, owner.userId) })))).status).toBe(403);
    // Without the captured scope, or from another origin, nothing changes.
    expect((await as(signedIn, () => route.POST(post({ action: "designate" })))).status).toBe(409);
    expect((await as(signedIn, () => route.POST(post({ action: "designate" }, { "X-Workbench-Scope": scope.workbenchScopeFor(owner.workspaceId, owner.userId), Origin: "https://elsewhere.example" })))).status).toBe(403);
    expect(backfilled).toEqual([]);
    const scoped = { "X-Workbench-Scope": scope.workbenchScopeFor(owner.workspaceId, owner.userId) };
    expect((await as(signedIn, () => route.POST(post({ action: "rotate" }, scoped)))).status).toBe(400);
    const designated = await as(signedIn, () => route.POST(post({ action: "designate" }, scoped)));
    expect(designated.status).toBe(200);
    expect(designated.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await designated.json();
    expect(body).toMatchObject({ state: "ready", host: { yours: true } });
    expect(JSON.stringify(body)).not.toContain(ACCESS);
    expect(JSON.stringify(body)).not.toContain(owner.subject!);
    expect(backfilled).toEqual([{ workspaceId: owner.workspaceId, userId: owner.userId }]);
    const tools = await as(signedIn, () => route.POST(post({ action: "tools", tools: ["shorts"] }, scoped)));
    expect((await tools.json()).tools.find((tool: { id: string }) => tool.id === "shorts").enabled).toBe(true);
    expect((await as(signedIn, () => route.POST(post({ action: "tools", tools: ["voice-change"] }, scoped)))).status).toBe(409);
    // A workspace the platform owner does not own cannot host the designation.
    ctx = { user: admin, workspace, role: "admin", workspaces: [] };
    expect((await as(signedIn, () => route.POST(post({ action: "designate" }, scoped)))).status).toBe(403);
  });
});

test("while designated, the connection cannot be disconnected and its workspace cannot be deleted; a sign-in is still allowed", async () => {
  const { account, tenant, scope } = await modules();
  const owner = await host();
  const other = await host();
  await account.designatePlatformAccount(owner, owner.userId);
  const removed: unknown[] = [], begun: unknown[] = [], deleted: string[] = [];
  let identity: Identity = owner;
  const auth = {
    requireOwner: async () => ({ user: { id: identity.userId, owner: true } }),
    withTenant: (handler: unknown) => handler,
    SESSION_COOKIE: "session",
  };
  const tenantModule = { requireTenant: () => ({ id: identity.workspaceId }) };
  const accountDb = await import("../../lib/accountDb");
  const connection = loadRoute<{ DELETE: (req: Request) => Promise<Response> }>("app/api/higgsfield/consumer/connection/route.ts", {
    "@/lib/auth": auth, "@/lib/tenant": tenantModule, "@/lib/workbench/request-scope": scope,
    "@/lib/higgsfield-consumer/oauth": { backfillConsumerSubject: async () => true, getConsumerAccess: async () => null, getConsumerConnection: async () => ({}),
      removeConsumerConnection: async (id: unknown) => { removed.push(id); } },
    "@/lib/higgsfield-consumer/developer-api": {}, "@/lib/higgsfield-consumer/jobs": {},
    "@/lib/accountDb": { AccountError: accountDb.AccountError, takeAccountLimit: async () => {} },
    "@/lib/higgsfield-consumer/platform-account": account,
  });
  const connect = loadRoute<{ POST: (req: Request) => Promise<Response> }>("app/api/higgsfield/consumer/connect/route.ts", {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "browser-session" }) }) },
    "@/lib/auth": auth, "@/lib/tenant": tenantModule,
    "@/lib/accountDb": { AccountError: accountDb.AccountError, takeAccountLimit: async () => {} },
    "@/lib/higgsfield-consumer/oauth": { backfillConsumerSubject: async () => true, beginConsumerAuthorization: async (id: unknown) => { begun.push(id); return { url: "https://issuer.example/authorize" }; },
      ConsumerOAuthError: class extends Error {} },
    "@/lib/higgsfield-consumer/platform-account": account,
  });
  const workspaces = loadRoute<{ DELETE: (req: Request) => Promise<Response> }>("app/api/workspaces/route.ts", {
    "next/server": nextServer(), "next/headers": { cookies: async () => ({ get: () => undefined }) },
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/accountRequestScope": { accountRequestScopeMatches: () => true },
    "@/lib/workbench/request-scope": scope,
    "@/lib/auth": { currentContext: async () => ({ user: { id: identity.userId }, workspace: { id: identity.workspaceId, name: "Host", legacy: false }, role: "owner", workspaces: [{ id: identity.workspaceId }, { id: "elsewhere" }] }), requireOwner: auth.requireOwner, withTenant: auth.withTenant, SESSION_COOKIE: "session" },
    "@/lib/tenant": tenantModule, "@/lib/platform": {}, "@/lib/workspaceProvisioning": {},
    "@/lib/accountDb": { AccountError: accountDb.AccountError, sameOriginProblem: () => false, accountFailure: () => new Response(null, { status: 503 }) },
    "@/lib/deletion": { deletionAllowed: () => ({ ok: true }) },
    "@/lib/purge": { markWorkspaceDeleted: async (id: string) => { deleted.push(id); } },
    "@/lib/higgsfield-consumer/platform-account": account,
  });
  const request = (method: string, id: Identity) =>
    new Request("https://particl.example/api/any", { method, headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope.workbenchScopeFor(id.workspaceId, id.userId) }, body: JSON.stringify({ name: "Host" }) });
  await tenant.runWithStore({ workspace: null, user: null }, async () => {
    const locked = await connection.DELETE(request("DELETE", owner));
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: account.PLATFORM_ACCOUNT_LOCKED, code: "platform_account_locked" });
    const kept = await workspaces.DELETE(request("DELETE", owner));
    expect(kept.status).toBe(409);
    expect((await kept.json()).error).toMatch(/platform desk/);
    expect({ removed, deleted }).toEqual({ removed: [], deleted: [] });
    // A sign-in may start (the callback completes it only for the pinned account; see the next test).
    expect((await connect.POST(request("POST", owner))).status).toBe(200);
    expect(begun).toEqual([{ workspaceId: owner.workspaceId, userId: owner.userId }]);
    begun.length = 0;
    // Any other connection and workspace are untouched by the lock.
    identity = other;
    expect((await connection.DELETE(request("DELETE", other))).status).toBe(200);
    expect((await connect.POST(request("POST", other))).status).toBe(200);
    expect((await workspaces.DELETE(request("DELETE", other))).status).toBe(200);
    expect({ removed, begun, deleted }).toEqual({ removed: [{ workspaceId: other.workspaceId, userId: other.userId }], begun: [{ workspaceId: other.workspaceId, userId: other.userId }], deleted: [other.workspaceId] });
  });
});

test("the designated connection re-signs only with its own account; another account's sign-in leaves its grant untouched", async () => {
  const { account, oauth, store, platform, tenant } = await modules();
  await platform.platformReady();
  const n = ++sequence, identity = { workspaceId: `ws_webacct${n}${randomBytes(3).toString("hex")}`, userId: `acct_webacct_${n}` };
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)", args: [identity.workspaceId, identity.workspaceId, "Host", "file:unused.db", identity.userId] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,0)", args: [identity.workspaceId, identity.userId] },
  ], "write");
  const clientId = oauth.consumerConfiguration().clientId;
  const idToken = (sub: string) => ["e30", Buffer.from(JSON.stringify({ iss: oauth.CONSUMER_ISSUER, sub, aud: clientId })).toString("base64url"), "signature"].join(".");
  const signInAs = async (sub: string, options: { requiredSubjectHash?: string } = {}) => {
    const { url } = await oauth.beginConsumerAuthorization(identity, "browser-session");
    const params = new URLSearchParams({ state: new URL(url).searchParams.get("state")!, code: "authorization-code", iss: oauth.CONSUMER_ISSUER });
    return oauth.finishConsumerAuthorization(identity, "browser-session", params, (async () =>
      Response.json({ access_token: `access-${sub}`, refresh_token: "refresh-private", expires_in: 3600, token_type: "Bearer", id_token: idToken(sub) })) as typeof fetch, options);
  };
  await signInAs("owner-account");
  await account.designatePlatformAccount(identity, identity.userId);
  const pinned = (await account.readPlatformDesignation())!.subjectHash;
  const before = (await store.claimConsumerAccess(identity)) as { generation: string };
  // Another account: refused, and the grant, generation and account stay exactly as they were.
  await expect(signInAs("another-account", { requiredSubjectHash: pinned })).rejects.toMatchObject({ code: "account_pinned" });
  expect(await store.claimConsumerAccess(identity)).toMatchObject({ kind: "ready", token: "access-owner-account", generation: before.generation });
  expect((await account.platformAccountHealth()).reason).toBeNull();
  // The same account again: completes, same grant generation, still serving.
  await signInAs("owner-account", { requiredSubjectHash: pinned });
  expect(await store.claimConsumerAccess(identity)).toMatchObject({ kind: "ready", generation: before.generation });
  expect((await account.platformAccountHealth()).reason).toBeNull();

  // The callback route pins the designated connection, and only that one.
  const seen: unknown[] = [];
  let caller = identity;
  const callback = loadRoute<{ GET: (req: Request) => Promise<Response> }>("app/api/higgsfield/consumer/callback/route.ts", {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "browser-session" }) }) },
    "@/lib/auth": { requireOwner: async () => ({ user: { id: caller.userId, owner: true } }), SESSION_COOKIE: "session", withTenant: (handler: unknown) => handler },
    "@/lib/tenant": { requireTenant: () => ({ id: caller.workspaceId }) },
    "@/lib/higgsfield-consumer/oauth": {
      consumerCallbackLocation: oauth.consumerCallbackLocation, ConsumerOAuthError: oauth.ConsumerOAuthError,
      finishConsumerAuthorization: async (_id: unknown, _session: unknown, _params: unknown, _fetch: unknown, options: unknown) => { seen.push(options); },
    },
    "@/lib/higgsfield-consumer/platform-account": account,
  });
  const back = new Request("https://particl.example/api/higgsfield/consumer/callback?state=s&code=c");
  await tenant.runWithStore({ workspace: null, user: null }, async () => {
    expect((await callback.GET(back)).headers.get("Location")).toMatch(/higgsfield=connected$/);
    caller = { workspaceId: "ws_elsewhere", userId: "someone" };
    await callback.GET(back);
  });
  expect(seen).toEqual([{ requiredSubjectHash: pinned }, {}]);
  await account.releasePlatformAccount(identity.userId);
});
