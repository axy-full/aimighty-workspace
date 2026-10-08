import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";
import { freshDatabases, load } from "./demo-gaps-l5-harness";
import { configuredOrigin, linkOrigin, mailLinkOrigin, siteOrigin } from "../../lib/site";
import { proxiedPublicOrigin } from "../../lib/requestOrigin";

/**
 * Where a link points. An emailed link (password reset, invitation, sign-up verification, the top-up desk) carries a
 * one-time secret, so its host is never read from the request's Host or X-Forwarded-* headers: it is APP_ORIGIN, and a
 * production server without APP_ORIGIN sends nothing rather than guess. A link handed back to the person who asked for
 * it (review, share, MCP, the API description) is APP_ORIGIN, else the request's own origin, never the proxy's
 * internal listen address when APP_ORIGIN is set. One reading of APP_ORIGIN serves all of them.
 */
freshDatabases("public-link-origin");
test.describe.configure({ mode: "serial" });

const PUBLIC = "https://app.example.test";
const LISTEN = "http://localhost:3000";
/* What a client can put on a request; none of it may ever reach a link. */
const SPOOF = { Host: "attacker.test", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https", Forwarded: "host=attacker.test;proto=https" };
const spoofed = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { ...SPOOF, ...(init.headers as Record<string, string> | undefined) } });

type Env = Record<string, string | undefined>;
/** Runs `fn` with process.env patched (undefined deletes), restoring every key after. */
async function withEnv<T>(patch: Env, fn: () => Promise<T> | T): Promise<T> {
  const env = process.env as Env, saved: Env = {};
  for (const key of Object.keys(patch)) { saved[key] = env[key]; if (patch[key] === undefined) delete env[key]; else env[key] = patch[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete env[key]; else env[key] = saved[key]; } }
}
/** A self-hosted production server: no Vercel, NODE_ENV=production. */
const SELF_HOSTED = { VERCEL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined, NODE_ENV: "production" };

function logged() {
  const lines: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.error = original; } };
}

test("one normaliser: APP_ORIGIN becomes scheme://host[:port] the same way for links, link previews and the proxy origin check", () => {
  const table: [string | undefined, string | null][] = [
    ["https://app.example.test", PUBLIC],
    ["https://app.example.test/", PUBLIC],
    ["  https://app.example.test/  ", PUBLIC],
    ["https://APP.Example.TEST", PUBLIC],
    ["https://app.example.test:443/some/path?q=1#h", PUBLIC],
    ["http://localhost:4551/", "http://localhost:4551"],
    ["https://app.example.test:8443", "https://app.example.test:8443"],
    ["app.example.test", null],
    ["javascript:alert(1)", null],
    ["file:///etc/passwd", null],
    ["", null],
    ["   ", null],
    [undefined, null],
  ];
  const req = new Request(`${LISTEN}/api/x`);
  for (const [raw, want] of table) {
    const env = { APP_ORIGIN: raw, NODE_ENV: "production" };
    expect(configuredOrigin(env), String(raw)).toBe(want);
    expect(siteOrigin(env), String(raw)).toBe(want);
    expect(proxiedPublicOrigin({ ...env, SELFHOST_BEHIND_PROXY: "1" }), String(raw)).toBe(want);
    expect(mailLinkOrigin(req, env), String(raw)).toBe(want);
    expect(linkOrigin(req, env), String(raw)).toBe(want ?? LISTEN);
  }
});

test("a link handed back to the person: APP_ORIGIN when set, else the request's own origin; headers are never read", () => {
  expect(linkOrigin(spoofed(`${LISTEN}/api/shares`), { APP_ORIGIN: `${PUBLIC}/` })).toBe(PUBLIC);
  expect(linkOrigin(spoofed("https://particl.test/api/shares"), {})).toBe("https://particl.test");
  expect(linkOrigin(spoofed(`${LISTEN}/api/shares`), { NODE_ENV: "production" })).toBe(LISTEN);
  /* Unlike siteOrigin, the production deployment's URL never stands in: a preview's link stays on the preview. */
  expect(linkOrigin(new Request("https://particl-git-x.vercel.app/api/shares"), { VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "particl.test" })).toBe("https://particl-git-x.vercel.app");
});

test("an emailed link: APP_ORIGIN; on Vercel or outside production the request's own origin; a self-hosted production server without APP_ORIGIN gets none", () => {
  const req = spoofed(`${LISTEN}/api/auth/reset`, { method: "POST" });
  expect(mailLinkOrigin(req, { ...SELF_HOSTED, APP_ORIGIN: `${PUBLIC}/` })).toBe(PUBLIC);
  expect(mailLinkOrigin(req, { VERCEL: "1", NODE_ENV: "production", APP_ORIGIN: PUBLIC })).toBe(PUBLIC);
  /* Vercel routes only this project's own domains to the function, so the request's own origin is one of ours. */
  expect(mailLinkOrigin(spoofed("https://particl-git-x.vercel.app/api/auth/reset"), { VERCEL: "1", NODE_ENV: "production" })).toBe("https://particl-git-x.vercel.app");
  expect(mailLinkOrigin(spoofed("https://particl-git-x.vercel.app/api/auth/reset"), { VERCEL: "1", NODE_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "particl.test" })).toBe("https://particl-git-x.vercel.app");
  for (const NODE_ENV of ["development", "test", undefined]) expect(mailLinkOrigin(req, { NODE_ENV })).toBe(LISTEN);
  /* Self-hosted production: neither the listen address nor any header is a link origin. */
  expect(mailLinkOrigin(req, SELF_HOSTED)).toBeNull();
  expect(mailLinkOrigin(req, { ...SELF_HOSTED, APP_ORIGIN: "not a url" })).toBeNull();
  expect(mailLinkOrigin(req, { ...SELF_HOSTED, VERCEL_PROJECT_PRODUCTION_URL: "particl.test" })).toBeNull();
  expect(mailLinkOrigin(req, { ...SELF_HOSTED, SELFHOST_BEHIND_PROXY: "1" })).toBeNull();
});

test("lib/mail › inviteOrigin reads the process's APP_ORIGIN, never the headers, and logs when it refuses", async () => {
  const { inviteOrigin } = await import("../../lib/mail");
  const req = spoofed(`${LISTEN}/api/team`, { method: "POST" });
  await withEnv({ ...SELF_HOSTED, APP_ORIGIN: `${PUBLIC}/` }, () => expect(inviteOrigin(req)).toBe(PUBLIC));
  const log = logged();
  try {
    await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined }, () => expect(inviteOrigin(req)).toBeNull());
  } finally { log.restore(); }
  expect(log.lines.join("\n")).toMatch(/APP_ORIGIN is not set/);
  await withEnv({ APP_ORIGIN: undefined, VERCEL: undefined, NODE_ENV: "development" }, () => expect(inviteOrigin(req)).toBe(LISTEN));
});

/* ── The password reset, through the real route, mail templates, accounts and platform database ─────────────── */

async function resetRoute() {
  const sent: { to: string; text: string; html: string }[] = [];
  const later: (() => Promise<unknown>)[] = [];
  const mail = await import("../../lib/mail");
  const route = load<typeof import("../../app/api/auth/reset/route")>("app/api/auth/reset/route.ts", {
    "@/lib/recovery": {
      recoveryRoute: (handler: unknown) => handler,
      reserveRecoveryContinuation: async (_kind: string, run: () => Promise<unknown>) => run,
    },
    "next/server": { ...createRequire(path.resolve("package.json"))("next/server"), after: (run: () => Promise<unknown>) => { later.push(run); } },
    "@/lib/mail": {
      ...mail, mailConfigured: () => true,
      sendMail: async (msg: { to: string; text: string; html: string }) => { sent.push(msg); return { id: "mail" }; },
    },
  });
  const ask = async (email: string) => {
    const res = await route.POST(spoofed(`${LISTEN}/api/auth/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }));
    for (const run of later.splice(0)) await run();
    return res;
  };
  return { sent, ask };
}
async function account(id: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)", args: [id, `${id}@example.test`, "Person", "x", Date.now()] });
  const rows = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM password_resets WHERE user_id=?", args: [id] })).rows[0].n);
  return { email: `${id}@example.test`, rows };
}

test("password reset on a self-hosted production server without APP_ORIGIN: refused, nothing written, nothing sent, the reason logged", async () => {
  const { email, rows } = await account("reset_unset");
  const { sent, ask } = await resetRoute();
  const log = logged();
  let res: Response;
  try { res = await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined }, () => ask(email)); }
  finally { log.restore(); }
  expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/Email isn't set up on this deployment yet/);
  expect(await rows()).toBe(0);
  expect(sent).toHaveLength(0);
  expect(log.lines.join("\n")).toMatch(/APP_ORIGIN is not set/);
});

test("password reset with APP_ORIGIN: the link is on APP_ORIGIN whatever Host and X-Forwarded-Host say", async () => {
  const { email, rows } = await account("reset_set");
  const { sent, ask } = await resetRoute();
  const res = await withEnv({ ...SELF_HOSTED, APP_ORIGIN: `${PUBLIC}/` }, () => ask(email));
  expect(res.status).toBe(200);
  expect(await rows()).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toMatch(new RegExp(`${PUBLIC.replace(/\./g, "\\.")}/reset/[A-Za-z0-9_-]{43}`));
  expect(`${sent[0].text}${sent[0].html}`).not.toContain("attacker");
  expect(`${sent[0].text}${sent[0].html}`).not.toContain("localhost");
});

/* ── The platform's sign-up invitation and the top-up desk mail ─────────────────────────────────────────────── */

async function adminInvites(sent: unknown[], writes: string[]) {
  const mail = await import("../../lib/mail");
  return load<typeof import("../../app/api/admin/invites/route")>("app/api/admin/invites/route.ts", {
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/auth": { requireSuperAdmin: async () => ({ user: { id: "platform_owner" } }) },
    "@/lib/platform": {
      platformReady: async () => {}, now: () => 1, platformKeysByDefault: () => true, rowToWorkspace: () => null, grantsByKind: async () => new Map(), getPlatformLayer: async () => ({}),
      platformDb: () => ({ execute: async (q: { sql: string }) => { writes.push(q.sql); return { rows: [] }; } }),
    },
    "@/lib/mail": { ...mail, mailConfigured: () => true, sendMail: async (msg: unknown) => { sent.push(msg); return { id: "mail" }; } },
  });
}
const invitePost = () => spoofed(`${LISTEN}/api/admin/invites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "new@example.test", name: "New" }) });

test("sign-up invitation from the platform desk: on APP_ORIGIN when set; without it in production the invitation is kept and not mailed", async () => {
  const sent: { text: string }[] = [], writes: string[] = [];
  const route = await adminInvites(sent, writes);
  const ok = await (await withEnv({ ...SELF_HOSTED, APP_ORIGIN: PUBLIC }, () => route.POST(invitePost()))).json();
  expect(ok).toMatchObject({ sent: true, mailError: null });
  expect(ok.link).toMatch(new RegExp(`^${PUBLIC.replace(/\./g, "\\.")}/signup\\?invite=`));
  expect(sent[0].text).toContain(ok.link);

  sent.length = 0;
  const log = logged();
  let refused: Record<string, unknown>;
  try { refused = await (await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined }, () => route.POST(invitePost()))).json(); }
  finally { log.restore(); }
  expect(refused).toMatchObject({ sent: false });
  expect(String(refused.mailError)).toMatch(/Email isn't set up on this deployment yet/);
  expect(String(refused.link)).not.toContain("attacker");
  expect(sent).toHaveLength(0);
  expect(writes.filter((sql) => /INSERT INTO signup_invites/.test(sql))).toHaveLength(2);
});

async function topups(sent: { to: string; text: string }[]) {
  const mail = await import("../../lib/mail");
  const ws = { id: "ws_topup", name: "Studio T" };
  return load<typeof import("../../app/api/workspaces/topups/route")>("app/api/workspaces/topups/route.ts", {
    "@/lib/auth": { requireUser: async () => ({ user: { id: "owner", role: "admin" }, token: null }), withTenant: (handler: unknown) => handler },
    "@/lib/security/people-only": { PEOPLE_ONLY: "people only", isPerson: () => true },
    "@/lib/tenant": { requireTenant: () => ws },
    "@/lib/credits": { creditState: async () => ({}), creditsApply: () => true },
    "@/lib/payments": { checkoutReady: () => true, paymentProvider: () => "manual", startCheckout: async () => ({ kind: "queued" }) },
    "@/lib/topups": { listTopups: async () => [], cancelTopup: async () => true, OPEN_LIMIT: 3, requestTopup: async () => ({ id: "t1", label: "Starter", credits: 500, bonus: 0, usd: 50, note: "" }) },
    "@/lib/platform": { listGrants: async () => [], SUPER_ADMIN_EMAIL: "desk@example.test" },
    "@/lib/mail": { ...mail, mailConfigured: () => true, sendMail: async (msg: { to: string; text: string }) => { sent.push(msg); return { id: "mail" }; } },
  });
}

test("top-up desk mail: its link is on APP_ORIGIN; without it in production the request stands and no mail goes", async () => {
  const sent: { to: string; text: string }[] = [];
  const route = await topups(sent);
  const ask = () => route.POST(spoofed(`${LISTEN}/api/workspaces/topups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packId: "starter" }) }), undefined as never);
  const ok = await withEnv({ ...SELF_HOSTED, APP_ORIGIN: PUBLIC }, ask);
  expect(ok.status).toBe(201);
  expect((await ok.json()).emailed).toBe(true);
  expect(sent[0].text).toContain(`${PUBLIC}/admin`);
  expect(sent[0].text).not.toContain("attacker");

  sent.length = 0;
  const log = logged();
  let unset: Response;
  try { unset = await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined }, ask); }
  finally { log.restore(); }
  expect(unset.status).toBe(201);
  expect((await unset.json()).emailed).toBe(false);
  expect(sent).toHaveLength(0);
});

/* ── Links handed back to the person who asked: MCP tool results and the API description ──────────────────── */

test("MCP: the tools call this server at its own address (the bearer stays here); the links they return use APP_ORIGIN", async () => {
  const seen: { caller: string; links: string }[] = [];
  const route = load<typeof import("../../app/api/mcp/route")>("app/api/mcp/route.ts", {
    "@/lib/crew/mcp": { isCrewMcpRequest: () => false, handleCrewMcp: async () => new Response(null) },
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/auth": { requireUser: async () => ({ user: { id: "u" } }), withTenant: (handler: unknown) => handler },
    "@/lib/credits": { creditsApply: () => true },
    "@/lib/tenant": { currentTenant: () => null },
    "@/lib/mcp": {
      TOOLS: [],
      makeCaller: (origin: string) => origin,
      runTool: async (_name: string, _args: unknown, caller: string, links: string) => { seen.push({ caller, links }); return "ok"; },
    },
  });
  const call = () => route.POST(spoofed(`${LISTEN}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer aw_x" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_renders" } }) }), undefined);
  await withEnv({ ...SELF_HOSTED, APP_ORIGIN: PUBLIC }, call);
  await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined }, call);
  expect(seen).toEqual([{ caller: LISTEN, links: PUBLIC }, { caller: LISTEN, links: LISTEN }]);
});

test("OpenAPI: the server it names is APP_ORIGIN, else the request's own origin", async () => {
  const route = load<typeof import("../../app/api/openapi/route")>("app/api/openapi/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler },
  });
  const servers = async () => (await (await route.GET(spoofed(`${LISTEN}/api/openapi`), undefined as never)).json()).servers;
  expect(await withEnv({ ...SELF_HOSTED, APP_ORIGIN: `${PUBLIC}/` }, servers)).toEqual([{ url: PUBLIC }]);
  expect(await withEnv({ APP_ORIGIN: undefined }, servers)).toEqual([{ url: LISTEN }]);
});
