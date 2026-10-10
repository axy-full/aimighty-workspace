import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import * as siteModel from "../../lib/site/settings";
import { INVITE_ONLY, DEFAULT_SITE, type SiteSettings } from "../../lib/site/settings";
import { mailLinkOrigin } from "../../lib/site";

/**
 * Sign-up is by invitation link unless the platform owner opens it in /admin (lead decision 36), and the SERVER
 * enforces it: the routes run in-process with their stores stubbed, so each case shows exactly what was called.
 */
class AccountError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
type Calls = string[];
type Route = { POST?: (req: Request) => Promise<Response>; GET?: (req: Request) => Promise<Response> };
/** The origin each verification link was built on. */
const origins: string[] = [];

function load(file: string, site: SiteSettings, calls: Calls, env: { configured?: boolean; limited?: boolean } = {}): Route {
  const readiness = () => (env.configured
    ? { mode: "self-serve", open: true, verificationRequired: true }
    : { mode: "self-serve", open: false, verificationRequired: true, reason: "Email verification is being configured." });
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "next/headers": { cookies: async () => ({ get: () => undefined, set: () => calls.push("cookie.set") }) },
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/auth": { SESSION_COOKIE: "aw_session", currentContext: async () => null, sourceKey: () => "source-1" },
    "@/lib/accountInvitationSession": { accountInvitationSession: async () => { calls.push("session"); return { session: "s", created: true }; } },
    "@/lib/platform": {
      platformDb: () => ({ execute: async () => { calls.push("invite.lookup"); return { rows: [{ email: "invited@example.test", name: "Invited", used_at: null, expires_at: Date.now() + 60_000 }] }; } }),
      platformReady: async () => {},
      now: () => Date.now(),
      switchSessionWorkspace: async () => { calls.push("workspace.switch"); },
    },
    "@/lib/policyAccept": { policyAccepted: () => true },
    "@/lib/accountDb": {
      accountFailure: (error: unknown) => error instanceof AccountError ? Response.json({ error: error.message }, { status: error.status }) : Response.json({ error: "failed" }, { status: 503 }),
      accountJson: async (req: Request) => req.json(),
      AccountError,
      sameOriginProblem: () => false,
      takeAccountLimit: async (key: string) => { calls.push("limit:" + key); if (env.limited) throw new AccountError("Too many requests. Wait a while before trying again.", 429); },
    },
    "@/lib/signupRegistration": {
      beginSignup: async () => { calls.push("registration.begin"); return { email: "someone@example.test" }; },
      deliverSignupVerification: async (_registration: unknown, origin: string) => { calls.push("verification.mail"); origins.push(origin); },
      signupReadiness: readiness,
      acceptSignupInvitation: async () => { calls.push("invitation.accept"); return { owner: { id: "owner" }, requestId: "req" }; },
      resendSignup: async () => { calls.push("registration.resend"); return { email: "someone@example.test" }; },
      verifySignup: async () => { calls.push("registration.verify"); return { owner: { id: "owner" }, requestId: "req", planId: "studio", cadence: "monthly" }; },
      signupNext: () => "/billing",
    },
    "@/lib/workspaceProvisioning": {
      resumeWorkspace: async () => { calls.push("workspace.resume"); return { workspace: { id: "ws_new", name: "New", slug: "new" } }; },
      workspaceCreationReadiness: () => ({ canCreate: true }),
    },
    "@/lib/site/settings": siteModel,
    /* The real link-origin rule (lib/site.ts); lib/mail.ts only adds a log line to it. */
    "@/lib/mail": { inviteOrigin: (req: Request) => mailLinkOrigin(req) },
    "@/lib/site/settings.server": { readSite: async () => { calls.push("site.read"); return site; } },
  };
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Route };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in mocks)) throw new Error("Unexpected route dependency " + name);
    return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}

const closed: SiteSettings = { ...DEFAULT_SITE };
const open: SiteSettings = { ...DEFAULT_SITE, openSignup: true };
const post = (body: Record<string, unknown>) => new Request("http://localhost/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const form = { name: "Someone", email: "someone@example.test", workspace: "Studio", password: "a long passphrase 42", accept: true };

test("closed (the default): a sign-up with no invitation code is refused before anything is created, even fully configured", async () => {
  const calls: Calls = [];
  const res = await load("app/api/auth/signup/route.ts", closed, calls, { configured: true }).POST!(post(form));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: INVITE_ONLY, inviteOnly: true });
  expect(calls).toEqual(["site.read", "limit:signup-closed:source-1"]);
});

test("closed: refusals are rate-limited per source", async () => {
  const calls: Calls = [];
  const res = await load("app/api/auth/signup/route.ts", closed, calls, { limited: true }).POST!(post(form));
  expect(res.status).toBe(429);
  expect(calls).not.toContain("registration.begin");
});

test("closed: an invitation code still signs up, unchanged", async () => {
  const calls: Calls = [];
  const res = await load("app/api/auth/signup/route.ts", closed, calls).POST!(post({ ...form, code: "invite-code-123" }));
  expect(res.status).toBe(200);
  expect(calls).toEqual(["invitation.accept", "session", "cookie.set", "workspace.resume", "workspace.switch"]);
});

test("open: a sign-up with no code takes today's self-serve path", async () => {
  const calls: Calls = [];
  const res = await load("app/api/auth/signup/route.ts", open, calls, { configured: true }).POST!(post(form));
  expect(res.status).toBe(202);
  expect(calls).toEqual(["site.read", "registration.begin", "verification.mail"]);
  /* …and an unconfigured environment still answers its own reason, not the invite line. */
  const unconfigured = await load("app/api/auth/signup/route.ts", open, []).POST!(post(form));
  expect(unconfigured.status).toBe(503);
  expect((await unconfigured.json()).error).not.toBe(INVITE_ONLY);
});

test("GET says invite-only while closed, and checks an invitation as before", async () => {
  const closedGet = await load("app/api/auth/signup/route.ts", closed, []).GET!(new Request("http://localhost/api/auth/signup"));
  const body = await closedGet.json();
  expect(body).toMatchObject({ open: false, inviteOnly: true, reason: INVITE_ONLY });
  const openGet = await load("app/api/auth/signup/route.ts", open, [], { configured: true }).GET!(new Request("http://localhost/api/auth/signup"));
  const openBody = await openGet.json();
  expect(openBody).toMatchObject({ open: true });
  expect(openBody.inviteOnly).toBeUndefined();
  const calls: Calls = [];
  const invited = await load("app/api/auth/signup/route.ts", closed, calls).GET!(new Request("http://localhost/api/auth/signup?code=invite-code-123"));
  expect(await invited.json()).toMatchObject({ ok: true, email: "invited@example.test" });
  expect(calls).toEqual(["invite.lookup"]);
});

test("closed: resending a self-serve verification and verifying a self-serve registration are refused", async () => {
  const calls: Calls = [];
  const resend = await load("app/api/auth/signup/resend/route.ts", closed, calls, { configured: true }).POST!(new Request("http://localhost/api/auth/signup/resend", { method: "POST", body: JSON.stringify({ email: "someone@example.test" }) }));
  expect(resend.status).toBe(403);
  const verify = await load("app/api/auth/verify/route.ts", closed, calls, { configured: true }).POST!(new Request("http://localhost/api/auth/verify", { method: "POST", body: JSON.stringify({ token: "x".repeat(48) }) }));
  expect(verify.status).toBe(403);
  /* The page reads the flag and offers Request access instead of an error (lead decision 41). */
  expect(await verify.json()).toEqual({ error: INVITE_ONLY, inviteOnly: true });
  expect(await resend.json()).toEqual({ error: INVITE_ONLY, inviteOnly: true });
  expect(calls.filter((c) => c.startsWith("registration."))).toEqual([]);
  /* Open, both run as before. */
  const openCalls: Calls = [];
  await load("app/api/auth/signup/resend/route.ts", open, openCalls, { configured: true }).POST!(new Request("http://localhost/api/auth/signup/resend", { method: "POST", body: JSON.stringify({ email: "someone@example.test" }) }));
  await load("app/api/auth/verify/route.ts", open, openCalls, { configured: true }).POST!(new Request("http://localhost/api/auth/verify", { method: "POST", body: JSON.stringify({ token: "x".repeat(48) }) }));
  expect(openCalls).toContain("registration.resend");
  expect(openCalls).toContain("registration.verify");
});

test("open: on a self-hosted production server without APP_ORIGIN no verification is begun or resent; with it the link is on APP_ORIGIN", async () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { APP_ORIGIN: env.APP_ORIGIN, VERCEL: env.VERCEL, NODE_ENV: env.NODE_ENV };
  const spoof = { "Content-Type": "application/json", Host: "attacker.test", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https" };
  const signup = () => new Request("http://localhost:3000/api/auth/signup", { method: "POST", headers: spoof, body: JSON.stringify(form) });
  const resend = () => new Request("http://localhost:3000/api/auth/signup/resend", { method: "POST", headers: spoof, body: JSON.stringify({ email: "someone@example.test" }) });
  delete env.APP_ORIGIN; delete env.VERCEL; env.NODE_ENV = "production";
  try {
    const calls: Calls = [];
    const refused = await load("app/api/auth/signup/route.ts", open, calls, { configured: true }).POST!(signup());
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toMatch(/Email verification is being configured/);
    expect((await load("app/api/auth/signup/resend/route.ts", open, calls, { configured: true }).POST!(resend())).status).toBe(503);
    expect(calls.filter((c) => c.startsWith("registration.") || c === "verification.mail")).toEqual([]);

    env.APP_ORIGIN = "https://app.example.test/";
    origins.length = 0;
    const sent: Calls = [];
    expect((await load("app/api/auth/signup/route.ts", open, sent, { configured: true }).POST!(signup())).status).toBe(202);
    expect((await load("app/api/auth/signup/resend/route.ts", open, sent, { configured: true }).POST!(resend())).status).toBe(202);
    expect(sent.filter((c) => c === "verification.mail")).toHaveLength(2);
    expect(origins).toEqual(["https://app.example.test", "https://app.example.test"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete env[key]; else env[key] = value; }
  }
});
