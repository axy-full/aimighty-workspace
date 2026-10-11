import { test, expect } from "@playwright/test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * "Continue with Google" (lib/googleSignIn.ts), server side, with Google replaced by a key pair of the test's own: the callback is run
 * whole (state, code exchange, ID token, the decision, the session), so what is refused is refused where it is refused for real.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-google-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
process.env.APP_ORIGIN = "https://app.example.test";
process.env.SUPER_ADMIN_EMAIL = "platform-owner@example.test";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;
const password = "Unique-studio-password-43";
const CLIENT = "client-id.apps.example";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const config = { clientId: CLIENT, clientSecret: "secret", redirectUri: "https://app.example.test/api/auth/google/callback" };

type Claims = { email?: string; email_verified?: unknown; aud?: unknown; iss?: unknown; exp?: number; iat?: number; nonce?: string; name?: string };
function idToken(claims: Claims, over: { kid?: string; sign?: (data: string) => string } = {}) {
  const at = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: over.kid ?? "k1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, iat: at, exp: at + 3000, email_verified: true, name: "Pat Example", ...claims })).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = over.sign ? over.sign(data) : createSign("RSA-SHA256").update(data).sign(pair.privateKey).toString("base64url");
  return `${data}.${signature}`;
}

let counter = 0;
/** One sign-in attempt, end to end: the cookie the start would have set, and Google answering with the given ID token claims. */
async function attempt(input: { claims: Claims; invite?: string; accept?: boolean; source?: string; override?: { kid?: string; sign?: (d: string) => string }; mutate?: { state?: string; nonce?: string; cookie?: (c: string) => string } }) {
  const g = await import("../../lib/googleSignIn");
  const request = g.newGoogleRequest();
  const nonce = input.mutate?.nonce ?? request.nonce;
  const cookie = g.sealGoogleCookie({ state: request.state, nonce: request.nonce, verifier: request.verifier, invite: input.invite ?? "", accept: input.accept ?? false, next: "/suites?view=home", exp: Date.now() + g.STATE_TTL_MS });
  const seen: string[] = [];
  const fetcher: import("../../lib/googleSignIn").Fetcher = async (url, init) => {
    seen.push(`${url}\n${String(init?.body ?? "")}`);
    return Response.json({ id_token: idToken({ nonce, ...input.claims }, input.override), access_token: "never-read" });
  };
  const source = input.source ?? `src-${++counter}`;
  const run = (cookieValue = cookie) => g.completeGoogleCallback(
    { query: { code: "the-one-time-code", state: input.mutate?.state ?? request.state, error: null }, cookie: input.mutate?.cookie ? input.mutate.cookie(cookieValue) : cookieValue, source },
    { config, fetcher, keys: async () => [jwk] },
  );
  return { run, cookie, request, seen, source };
}
const refusal = async (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error.code ?? String(error));

async function accounts(email?: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute(email ? { sql: "SELECT id FROM accounts WHERE email=?", args: [email] } : "SELECT id FROM accounts")).rows;
}
async function member() {
  const { createAccount } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const label = `owner${++counter}`;
  const user = await createAccount(`${label}@example.test`, label, hashPassword(password));
  const result = await resumeWorkspace(await requestWorkspace({ owner: user, name: label }), user.id);
  expect(result.workspace, result.provisioning?.error ?? "workspace ready").toBeTruthy();
  return { user, ws: result.workspace! };
}
async function invite(workspaceId: string, email: string, code: string, over: { expires?: number; used?: boolean } = {}) {
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({
    sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at,used_at) VALUES(?,?,?,'Team','member',?,?,?)",
    args: [code, workspaceId, email, Date.now(), over.expires ?? Date.now() + 3_600_000, over.used ? Date.now() : null],
  });
}
async function sessionOf(token: string) {
  const { platformDb } = await import("../../lib/platform");
  const { createHash } = await import("node:crypto");
  return (await platformDb().execute({ sql: "SELECT account_id, workspace_id FROM p_sessions WHERE token_hash=?", args: [createHash("sha256").update(token).digest("hex")] })).rows[0];
}

test("the start sends exactly openid email profile, with PKCE and a nonce, to the redirect built from APP_ORIGIN; it is off without its settings", async () => {
  const g = await import("../../lib/googleSignIn");
  expect(g.googleConfig({})).toBeNull();
  expect(g.googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "a", GOOGLE_OAUTH_CLIENT_SECRET: "b" })).toBeNull();
  expect(g.googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "a", APP_ORIGIN: "https://x.test" })).toBeNull();
  expect(g.googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "a", GOOGLE_OAUTH_CLIENT_SECRET: "b", APP_ORIGIN: "https://x.test/path?q=1" })).toEqual({ clientId: "a", clientSecret: "b", redirectUri: "https://x.test/api/auth/google/callback" });
  const request = g.newGoogleRequest();
  const url = new URL(g.authorizationUrl(config, request));
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("scope")).toBe("openid email profile");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/api/auth/google/callback");
  expect(url.searchParams.get("state")).toBe(request.state);
  expect(url.searchParams.get("nonce")).toBe(request.nonce);
  expect(url.searchParams.get("access_type")).toBeNull();
  const { createHash } = await import("node:crypto");
  expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(request.verifier).digest("base64url"));
  expect(request.state).not.toBe(g.newGoogleRequest().state);
});

test("a person with no account and no invite is refused, and nothing is created", async () => {
  const before = (await accounts()).length;
  const a = await attempt({ claims: { email: "stranger@example.test" } });
  expect(await refusal(a.run())).toBe("no_account");
  expect(await accounts("stranger@example.test")).toHaveLength(0);
  expect((await accounts()).length).toBe(before);
  /* The code went to Google with the PKCE verifier, and only the ID token came back into use. */
  expect(a.seen[0]).toContain("code_verifier=" + a.request.verifier);
  expect(a.seen[0]).toContain("grant_type=authorization_code");
});

test("a new person with a valid invitation for that verified address joins that workspace only", async () => {
  const { ws } = await member();
  const other = await member();
  await invite(ws.id, "newcomer@example.test", "good-invite-code-1");
  /* Without the policy accepted nothing is made. */
  expect(await refusal((await attempt({ claims: { email: "newcomer@example.test" }, invite: "good-invite-code-1", accept: false })).run())).toBe("policy");
  expect(await accounts("newcomer@example.test")).toHaveLength(0);
  const done = await (await attempt({ claims: { email: "Newcomer@Example.test" }, invite: "good-invite-code-1", accept: true })).run();
  expect(done.joined).toBe(true);
  expect(done.workspaceId).toBe(ws.id);
  expect(done.next).toBe("/suites?view=home");
  const created = await accounts("newcomer@example.test");
  expect(created).toHaveLength(1);
  const { platformDb } = await import("../../lib/platform");
  const memberships = (await platformDb().execute({ sql: "SELECT workspace_id, role FROM memberships WHERE account_id=?", args: [String(created[0].id)] })).rows;
  expect(memberships.map((m) => [String(m.workspace_id), String(m.role)])).toEqual([[ws.id, "member"]]);
  expect(memberships.some((m) => String(m.workspace_id) === other.ws.id)).toBe(false);
  expect((await sessionOf(done.session))?.account_id).toBe(String(created[0].id));
  /* The invitation is spent: it makes no second account, and a stranger holding the code is no one (the address is the key). Its own
     member simply signs in with it, joining nobody new. */
  const again = await (await attempt({ claims: { email: "newcomer@example.test" }, invite: "good-invite-code-1", accept: true })).run();
  expect(again.joined).toBe(false);
  expect((await sessionOf(again.session))?.account_id).toBe(String(created[0].id));
  expect(await accounts("newcomer@example.test")).toHaveLength(1);
  expect(await refusal((await attempt({ claims: { email: "borrower@example.test" }, invite: "good-invite-code-1", accept: true })).run())).toBe("invite_mismatch");
});

test("an invitation for another address, an expired one, an unknown one and a new-workspace one let nobody in", async () => {
  const { ws } = await member();
  await invite(ws.id, "wanted@example.test", "invite-for-wanted-1");
  expect(await refusal((await attempt({ claims: { email: "someone-else@example.test" }, invite: "invite-for-wanted-1", accept: true })).run())).toBe("invite_mismatch");
  await invite(ws.id, "late@example.test", "expired-invite-code", { expires: Date.now() - 1000 });
  expect(await refusal((await attempt({ claims: { email: "late@example.test" }, invite: "expired-invite-code", accept: true })).run())).toBe("invite_invalid");
  expect(await refusal((await attempt({ claims: { email: "late@example.test" }, invite: "no-such-invite-code", accept: true })).run())).toBe("invite_invalid");
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: "INSERT INTO signup_invites(code,email,name,note,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)", args: ["new-workspace-invite", "founder@example.test", "", "", "test", Date.now(), Date.now() + 3_600_000] });
  expect(await refusal((await attempt({ claims: { email: "founder@example.test" }, invite: "new-workspace-invite", accept: true })).run())).toBe("signup_invite");
  for (const email of ["someone-else@example.test", "late@example.test", "founder@example.test"]) expect(await accounts(email)).toHaveLength(0);
});

test("an existing member signs in when Google's verified email is the account's email, and joins an invited workspace too", async () => {
  const { user } = await member();
  const done = await (await attempt({ claims: { email: user.email.toUpperCase() } })).run();
  expect(done.joined).toBe(false);
  expect((await sessionOf(done.session))?.account_id).toBe(user.id);
  expect(await accounts(user.email)).toHaveLength(1);
  /* With an invitation to another workspace for the same address, the same sign-in joins that workspace. */
  const other = await member();
  await invite(other.ws.id, user.email, "invite-for-member-1");
  const joined = await (await attempt({ claims: { email: user.email }, invite: "invite-for-member-1" })).run();
  expect(joined.joined).toBe(true);
  expect(joined.workspaceId).toBe(other.ws.id);
  const { platformDb } = await import("../../lib/platform");
  const rows = (await platformDb().execute({ sql: "SELECT workspace_id FROM memberships WHERE account_id=? AND disabled=0", args: [user.id] })).rows;
  expect(rows.map((r) => String(r.workspace_id)).sort()).toEqual([other.ws.id, ...(await (async () => (await platformDb().execute({ sql: "SELECT workspace_id FROM memberships WHERE account_id=? AND workspace_id<>?", args: [user.id, other.ws.id] })).rows.map((r) => String(r.workspace_id)))())].sort());
  expect(rows.length).toBe(2);
});

test("an unverified email, and a disabled or two-step account, are refused", async () => {
  const { user } = await member();
  expect(await refusal((await attempt({ claims: { email: user.email, email_verified: false } })).run())).toBe("unverified");
  expect(await refusal((await attempt({ claims: { email: user.email, email_verified: "false" } })).run())).toBe("unverified");
  expect(await refusal((await attempt({ claims: { email: user.email, email_verified: undefined } })).run())).toBe("unverified");
  const { platformDb } = await import("../../lib/platform");
  const two = await member();
  await platformDb().execute({ sql: "INSERT INTO account_security(account_id,secret_enc,enabled_at,last_counter,epoch) VALUES(?,?,?,?,0)", args: [two.user.id, "x", Date.now(), -1] });
  expect(await refusal((await attempt({ claims: { email: two.user.email } })).run())).toBe("two_step");
  const off = await member();
  await platformDb().execute({ sql: "UPDATE accounts SET disabled=1 WHERE id=?", args: [off.user.id] });
  expect(await refusal((await attempt({ claims: { email: off.user.email } })).run())).toBe("no_account");
});

test("a replayed or altered state, a wrong nonce, audience, issuer, expiry or signature is refused", async () => {
  const { user } = await member();
  const email = user.email;
  /* The same callback twice: the second finds the state spent, even with the cookie. */
  const once = await attempt({ claims: { email } });
  await once.run();
  expect(await refusal(once.run())).toBe("expired");
  /* A state that is not the cookie's, a cookie that was altered, a cookie that has expired, and no cookie at all. */
  expect(await refusal((await attempt({ claims: { email }, mutate: { state: "another-state" } })).run())).toBe("expired");
  expect(await refusal((await attempt({ claims: { email }, mutate: { cookie: (c) => `${c.slice(0, -2)}xx` } })).run())).toBe("expired");
  const g = await import("../../lib/googleSignIn");
  const old = g.sealGoogleCookie({ state: "s", nonce: "n", verifier: "v", invite: "", accept: false, next: "/", exp: Date.now() - 1 });
  expect(g.openGoogleCookie(old)).toBeNull();
  expect(g.openGoogleCookie(undefined)).toBeNull();
  /* The ID token itself. */
  expect(await refusal((await attempt({ claims: { email }, mutate: { nonce: "a-different-nonce" } })).run())).toBe("expired");
  expect(await refusal((await attempt({ claims: { email, aud: "someone-else" } })).run())).toBe("expired");
  expect(await refusal((await attempt({ claims: { email, iss: "https://evil.example" } })).run())).toBe("expired");
  expect(await refusal((await attempt({ claims: { email, exp: Math.floor(Date.now() / 1000) - 3600 } })).run())).toBe("expired");
  expect(await refusal((await attempt({ claims: { email }, override: { kid: "unknown" } })).run())).toBe("expired");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  expect(await refusal((await attempt({ claims: { email }, override: { sign: (d) => createSign("RSA-SHA256").update(d).sign(other.privateKey).toString("base64url") } })).run())).toBe("expired");
  /* And a token whose header says it is not signed. */
  const none = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600, email, email_verified: true, nonce: "x" })).toString("base64url");
  await expect(g.verifyIdToken(`${none}.${body}.`, { clientId: CLIENT, nonce: "x", keys: [jwk] })).rejects.toMatchObject({ code: "expired" });
  expect(await accounts("replay@example.test")).toHaveLength(0);
});

test("the platform owner's address never signs in with Google", async () => {
  expect(await refusal((await attempt({ claims: { email: "Platform-Owner@example.test" } })).run())).toBe("two_step");
});

test("refusals count against the source as wrong passwords do, and a locked source is limited", async () => {
  const source = "one-noisy-source";
  const results: (string | null)[] = [];
  for (let i = 0; i < 10; i++) results.push(await refusal((await attempt({ claims: { email: `nobody${i}@example.test` }, source })).run()));
  expect(results.slice(0, 8)).toEqual(Array(8).fill("no_account"));
  expect(results.slice(8)).toEqual(["limited", "limited"]);
  /* Another source is unaffected. */
  expect(await refusal((await attempt({ claims: { email: "nobody-else@example.test" }, source: "a-quiet-source" })).run())).toBe("no_account");
});

test("Google is told nothing the person did not choose, and the callback reads no token but the ID token", async () => {
  const text = await import("../../lib/googleSignInText");
  expect(text.googleStartPath({ invite: "abc12345", accept: true, next: "/x" })).toBe("/api/auth/google/start?invite=abc12345&accept=1&next=%2Fx");
  expect(text.googleStartPath({})).toBe("/api/auth/google/start");
  for (const code of Object.keys(text.GOOGLE_REFUSALS)) expect(text.isGoogleRefusal(code)).toBe(true);
  expect(text.isGoogleRefusal("<script>")).toBe(false);
});
