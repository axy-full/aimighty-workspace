import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * The 18+ confirmation at sign-up (lib/ageConfirm.ts; owner, 15 Oct 2026, 20:45: "an 18+ confirmation at sign-up (a required tick: "I'm 18 or older and agree to the Terms"), stored with the date,
 * on every sign-up path"). Every path that creates an account refuses without the tick, on the server, and writes one history line with the account's id and the moment. Real local platform
 * database; nothing is sent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-age-confirm-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;
const password = "Unique-studio-password-43";
/* Unit specs share one worker, and the platform client is cached by whichever spec loads it first, so every code and address here is unique to this run. */
const tag = randomUUID().slice(0, 8);
const mail = (local: string) => `${local}-${tag}@example.test`;
const REFUSAL = /18 or older and agree to the Terms/;

async function lines(accountId: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT * FROM security_audit WHERE action = 'account.age_confirmed' AND target_id = ?", args: [accountId] })).rows;
}
async function accountOf(email: string) {
  const { findAccountByEmail } = await import("../../lib/platform");
  return (await findAccountByEmail(email)) as { id: string; accepted_policy_at: number | null } | null;
}
/** What one confirmation line holds: the account's id twice, the account's kind, an empty details object, no workspace, and a moment inside the window. */
function expectLine(rows: Record<string, unknown>[], accountId: string, from: number, to: number) {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row).toMatchObject({ actor_id: accountId, target_id: accountId, target_type: "account", action: "account.age_confirmed", workspace_id: null, details: "{}" });
  expect(Number(row.created_at)).toBeGreaterThanOrEqual(from);
  expect(Number(row.created_at)).toBeLessThanOrEqual(to);
  /* Ids and a moment only: no address, name or text anywhere in the line. */
  expect(JSON.stringify(row)).not.toMatch(/@example|Customer|Approved|newcomer|google/i);
}
async function workspaceFixture(label: string) {
  const { createAccount } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const user = await createAccount(mail(label), label, hashPassword(password));
  const result = await resumeWorkspace(await requestWorkspace({ owner: user, name: label }), user.id);
  expect(result.workspace, result.provisioning?.error ?? "ready").toBeTruthy();
  return result.workspace!;
}

test("email sign-up: the registration is refused without the tick, and the verified account gets its line", async () => {
  const { beginSignup, verifySignup } = await import("../../lib/signupRegistration");
  const form = { name: "Customer", email: mail("customer"), workspace: "Customer house", password };
  for (const ageConfirmed of [undefined, false]) await expect(beginSignup({ ...form, ageConfirmed }, "age-source"), String(ageConfirmed)).rejects.toThrow(REFUSAL);
  expect(await accountOf(form.email), "nothing was made").toBeNull();
  const started = await beginSignup({ ...form, ageConfirmed: true }, "age-source");
  const from = Date.now();
  const verified = await verifySignup(started.token);
  const account = await accountOf(form.email);
  expect(account?.id).toBe(verified.owner.id);
  expect(Number(account?.accepted_policy_at), "the older date is still written").toBeGreaterThan(0);
  expectLine(await lines(verified.owner.id), verified.owner.id, from - 5_000, Date.now() + 5_000);
});

test("sign-up by invitation: refused without the tick, and the new account gets its line; a signed-in existing account adds none", async () => {
  const { acceptSignupInvitation } = await import("../../lib/signupRegistration");
  const { platformDb } = await import("../../lib/platform");
  const email = mail("approved"), code = `age-signup-${tag}`;
  await platformDb().execute({ sql: "INSERT INTO signup_invites(code,email,name,created_at,expires_at) VALUES(?,?,?,?,?)", args: [code, email, "Approved", Date.now(), Date.now() + 3_600_000] });
  const input = { code, name: "Approved", email, workspace: "Approved studio", password };
  for (const ageConfirmed of [undefined, false]) await expect(acceptSignupInvitation({ ...input, ageConfirmed }), String(ageConfirmed)).rejects.toThrow(REFUSAL);
  expect(await accountOf(email), "nothing was made").toBeNull();
  const from = Date.now();
  const accepted = await acceptSignupInvitation({ ...input, ageConfirmed: true });
  expectLine(await lines(accepted.owner.id), accepted.owner.id, from - 5_000, Date.now() + 5_000);
  const { createPlatformSession } = await import("../../lib/platform");
  await acceptSignupInvitation({ ...input, ageConfirmed: true }, accepted.owner.id, await createPlatformSession(accepted.owner.id, null));
  expect(await lines(accepted.owner.id), "the second visit made no account and no line").toHaveLength(1);
});

test("a team invitation for a new person: refused without the tick, and the new account gets its line", async () => {
  const { acceptWorkspaceInvitation } = await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const ws = await workspaceFixture("Team house");
  const email = mail("newcomer"), code = `age-team-${tag}`;
  await platformDb().execute({ sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,'Team','member',?,?)", args: [code, ws.id, email, Date.now(), Date.now() + 3_600_000] });
  for (const acceptedPolicy of [undefined, false]) await expect(acceptWorkspaceInvitation({ code, password, acceptedPolicy }), String(acceptedPolicy)).rejects.toThrow(REFUSAL);
  expect(await accountOf(email), "nothing was made").toBeNull();
  const from = Date.now();
  const joined = await acceptWorkspaceInvitation({ code, password, acceptedPolicy: true });
  expectLine(await lines(joined.accountId), joined.accountId, from - 5_000, Date.now() + 5_000);
});

test("Google: a new person is refused without the tick, and with it the account gets its line", async () => {
  const { signInWithVerifiedEmail, GoogleRefused } = await import("../../lib/googleSignIn");
  const { platformDb } = await import("../../lib/platform");
  const ws = await workspaceFixture("Google house");
  const email = mail("googler"), code = `age-google-${tag}`;
  await platformDb().execute({ sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,'Team','member',?,?)", args: [code, ws.id, email, Date.now(), Date.now() + 3_600_000] });
  await expect(signInWithVerifiedEmail({ email, name: "G", invite: code, accepted: false })).rejects.toBeInstanceOf(GoogleRefused);
  expect(await accountOf(email), "nothing was made").toBeNull();
  const from = Date.now();
  const signedIn = await signInWithVerifiedEmail({ email, name: "G", invite: code, accepted: true });
  expect(signedIn.joined).toBe(true);
  const account = await accountOf(email);
  expectLine(await lines(account!.id), account!.id, from - 5_000, Date.now() + 5_000);
});

test("first-run setup: refused without the tick (the account function and the route)", async () => {
  const { createFirstAdmin } = await import("../../lib/auth");
  for (const ageConfirmed of [undefined, false]) await expect(createFirstAdmin(mail("first"), "First", password, ageConfirmed as never), String(ageConfirmed)).rejects.toThrow(REFUSAL);
  expect(await accountOf(mail("first"))).toBeNull();
  const calls: string[] = [];
  const mocks: Record<string, unknown> = {
    "@/lib/recovery": { recoveryRoute: (h: unknown) => h },
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "next/headers": { cookies: async () => ({ set: () => {} }) },
    "@/lib/auth": { SESSION_COOKIE: "s", createSession: async () => "t", passwordProblem: () => null, userCount: async () => 0,
      createFirstAdmin: async (_e: string, _n: string, _p: string, ok: boolean) => { calls.push(`first:${ok}`); return { id: "u" }; } },
    "@/lib/accountDb": { accountJson: async (r: Request) => r.json(), accountFailure: () => Response.json({}, { status: 500 }), sameOriginProblem: () => false },
  };
  const source = ts.transpileModule(readFileSync("app/api/auth/setup/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { POST?: (r: Request) => Promise<Response> } };
  new Function("require", "module", "exports", source)((n: string) => { if (!(n in mocks)) throw new Error(`mock ${n}`); return mocks[n]; }, mod, mod.exports);
  const post = (accept: unknown) => mod.exports.POST!(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "First", email: "first@example.test", password, ...(accept === undefined ? {} : { accept }) }) }));
  for (const accept of [undefined, false, "yes"]) { const res = await post(accept); expect(res.status, String(accept)).toBe(400); expect((await res.json()).error).toMatch(REFUSAL); }
  expect(calls, "no account was asked for").toEqual([]);
  expect((await post(true)).status).toBe(200);
  expect(calls).toEqual(["first:true"]);
});

test("the sign-up route refuses without the tick and passes it down with it", async () => {
  const calls: string[] = [];
  const seen: unknown[] = [];
  class AccountError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "next/headers": { cookies: async () => ({ get: () => undefined, set: () => {} }) },
    "@/lib/recovery": { recoveryRoute: (h: unknown) => h },
    "@/lib/auth": { SESSION_COOKIE: "s", currentContext: async () => null, sourceKey: () => "src" },
    "@/lib/accountInvitationSession": { accountInvitationSession: async () => ({ session: "s", created: true }) },
    "@/lib/platform": { platformDb: () => ({ execute: async () => ({ rows: [] }) }), platformReady: async () => {}, now: () => Date.now(), switchSessionWorkspace: async () => {} },
    "@/lib/policyAccept": await import("../../lib/policyAccept"),
    "@/lib/accountDb": { accountFailure: (e: unknown) => (e instanceof AccountError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({}, { status: 503 })), accountJson: async (r: Request) => r.json(), AccountError, sameOriginProblem: () => false, takeAccountLimit: async () => {} },
    "@/lib/signupRegistration": { beginSignup: async (input: unknown) => { calls.push("begin"); seen.push(input); return { email: "a@example.test" }; }, deliverSignupVerification: async () => {}, signupReadiness: () => ({ open: true }),
      acceptSignupInvitation: async (input: unknown) => { calls.push("accept"); seen.push(input); return { owner: { id: "o" }, requestId: "r" }; }, resendSignup: async () => ({}), verifySignup: async () => ({}), signupNext: () => "/" },
    "@/lib/workspaceProvisioning": { resumeWorkspace: async () => ({ workspace: { id: "w", name: "W", slug: "w" } }), workspaceCreationReadiness: () => ({ canCreate: true }) },
    "@/lib/site/settings": await import("../../lib/site/settings"),
    "@/lib/mail": { inviteOrigin: () => "https://particl.test" },
    "@/lib/site/settings.server": { readSite: async () => ({ ...(await import("../../lib/site/settings")).DEFAULT_SITE, openSignup: true }) },
  };
  const source = ts.transpileModule(readFileSync("app/api/auth/signup/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { POST?: (r: Request) => Promise<Response> } };
  new Function("require", "module", "exports", source)((n: string) => { if (!(n in mocks)) throw new Error(`mock ${n}`); return mocks[n]; }, mod, mod.exports);
  const post = (body: Record<string, unknown>) => mod.exports.POST!(new Request("http://localhost/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "A", email: "a@example.test", workspace: "S", password, ...body }) }));
  for (const body of [{}, { accept: false }, { accept: "yes" }, { code: "an-invite-code-123" }, { code: "an-invite-code-123", accept: false }]) {
    const res = await post(body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect((await res.json()).error).toMatch(REFUSAL);
  }
  expect(calls, "nothing was begun or accepted").toEqual([]);
  expect((await post({ accept: true })).status).toBe(202);
  expect((await post({ accept: true, code: "an-invite-code-123" })).status).toBe(200);
  expect(calls).toEqual(["begin", "accept"]);
  for (const input of seen) expect(input).toMatchObject({ ageConfirmed: true });
});

test("every place that inserts an account either writes the confirmation beside it or is one of the two that are not sign-ups", () => {
  const files: string[] = [];
  const walk = (root: string) => { for (const name of readdirSync(root)) { const full = path.join(root, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|tsx)$/.test(name)) files.push(full); } };
  walk("lib"); walk("app");
  const NOT_SIGN_UPS = new Set(["lib/platform.ts", "lib/previewSeed.ts"]);
  const sites: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = file.split(path.sep).join("/");
    for (const match of text.matchAll(/INSERT (?:OR IGNORE |OR REPLACE )?INTO accounts\b/g)) {
      const window = text.slice(match.index!, match.index! + 900);
      sites.push(rel);
      if (!NOT_SIGN_UPS.has(rel)) expect(window, `${rel}: an account is made without the confirmation beside it`).toMatch(/ageConfirmedStatement/);
    }
  }
  /* The four sign-up sites and the two that are not. A new site fails this until it is listed or confirmed. */
  expect(sites.sort()).toEqual(["lib/platform.ts", "lib/platform.ts", "lib/signupRegistration.ts", "lib/signupRegistration.ts", "lib/teamInvitations.ts"]);
  expect(readFileSync("lib/auth.ts", "utf8")).toMatch(/createAccount\(.*\);\s*await platformDb\(\)\.execute\(ageConfirmedStatement\(account\.id\)\)/);
});
