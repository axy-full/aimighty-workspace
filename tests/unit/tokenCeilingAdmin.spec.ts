import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/**
 * Owner, 20 Oct 2026, Q1 "B": "An admin sets a ceiling per token in credits per month." PATCH /api/tokens/[id]/ceiling, through the
 * real lib/auth.ts: an admin's signed-in session sets or clears the ceiling of any token of the workspace that can generate; a member,
 * any API token (an MCP client among them) and so any agent working through one are refused, and nothing changes. GET /api/tokens lists
 * the other members' generating tokens to an admin, so their ceilings can be set. Neutral names; every figure is synthetic.
 */
const dir = freshDatabases("token-ceiling-admin");
const A = workspace(dir, "ws_tcadm");
const ORIGIN = "http://localhost";
test.describe.configure({ mode: "serial" });

const OWNER_RENDER = rawToken(A, "1"), MEMBER_RENDER = rawToken(A, "2"), PREP = rawToken(A, "3"), READ = rawToken(A, "4");
const admin = (): Who => ({ mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "admin", bearer: "" });
const member = (): Who => ({ mode: "session", ws: A, userId: "member", name: "Member Person", role: "member", bearer: "" });
const bearer = (raw: string, role: Who["role"] = "admin"): Who => ({ mode: "token", ws: A, userId: "owner", name: "Owner Person", role, bearer: raw });

test.beforeAll(async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,0,1,'owner',0,0)", args: [A.id, A.id, "Studio", A.dbUrl] });
  await seedPeople(A, [{ id: "owner", name: "Owner Person" }, { id: "member", name: "Member Person" }], [
    { id: "tok_owner_render", userId: "owner", scope: "render", raw: OWNER_RENDER },
    { id: "tok_member_render", userId: "member", scope: "render", raw: MEMBER_RENDER },
    { id: "tok_member_prep", userId: "member", scope: "prepare", raw: PREP },
    { id: "tok_member_read", userId: "member", scope: "read", raw: READ },
  ]);
});

async function ceilingRoute(who: Who) {
  return load<typeof import("../../app/api/tokens/[id]/ceiling/route")>("app/api/tokens/[id]/ceiling/route.ts", {
    "@/lib/auth": await authAs(who), "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
    "@/lib/securityAudit": await import("../../lib/securityAudit"), "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
  });
}
async function patch(who: Who, id: string, body: unknown) {
  const route = await ceilingRoute(who);
  const res = await route.PATCH(scoped(who, `${ORIGIN}/api/tokens/${id}/ceiling`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}
async function stored(id: string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  return runInTenant(A, async () => {
    const row = (await db().execute({ sql: "SELECT cap_credits, cap_usd FROM api_tokens WHERE id=?", args: [id] })).rows[0];
    return { capCredits: row.cap_credits == null ? null : Number(row.cap_credits), capUsd: row.cap_usd == null ? null : Number(row.cap_usd) };
  });
}
async function audits() {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  return runInTenant(A, async () => (await db().execute("SELECT actor_id, action, target_id FROM security_audit WHERE action='api_token.ceiling_set' ORDER BY created_at")).rows.map((r) => ({ ...r })));
}

test("a member, and every API token (an MCP client is one), is refused: nobody but an admin sets a ceiling, and nothing changes", async () => {
  const asMember = await patch(member(), "tok_member_render", { capCredits: 500 });
  expect(asMember.status).toBe(403);
  for (const raw of [OWNER_RENDER, MEMBER_RENDER]) {
    /* A token cannot raise its own ceiling, nor a sibling's, even one carrying an admin's identity. */
    for (const id of ["tok_owner_render", "tok_member_render"]) {
      const asToken = await patch(bearer(raw), id, { capCredits: 999_999 });
      expect(asToken.status, `${raw.slice(-4)} on ${id}`).toBe(403);
      expect(String(asToken.body.error)).toMatch(/signed-in browser session/);
    }
  }
  /* A prepare or read-only token is refused before its scope is even asked about (a write it may not make). */
  for (const raw of [PREP, READ]) expect((await patch(bearer(raw), "tok_member_render", { capCredits: 999_999 })).status).toBe(403);
  expect(await stored("tok_member_render")).toEqual({ capCredits: null, capUsd: null });
  expect(await stored("tok_owner_render")).toEqual({ capCredits: null, capUsd: null });
  expect(await audits()).toEqual([]);
});

test("an admin sets a member's token's ceiling in credits, recorded in the security history; the token then spends inside it", async () => {
  const set = await patch(admin(), "tok_member_render", { capCredits: "300 cr" });
  expect(set).toEqual({ status: 200, body: { id: "tok_member_render", capCredits: 300 } });
  expect(await stored("tok_member_render")).toEqual({ capCredits: 300, capUsd: null });
  expect(await audits()).toEqual([{ actor_id: "owner", action: "api_token.ceiling_set", target_id: "tok_member_render" }]);
  expect(await lastAudit("tok_member_render")).toEqual({ ceilingUnit: "cr", ceilingBefore: null, ceilingAfter: 300 });
  /* The token as every request reads it: the ceiling, and so it may spend. */
  const auth = await authAs(bearer(MEMBER_RENDER, "member"));
  const caller = await auth.callerFromToken(MEMBER_RENDER);
  expect(caller?.token).toMatchObject({ id: "tok_member_render", scope: "render", capCredits: 300 });
  const { runInTenant } = await import("../../lib/tenant");
  const { tokenMaySpend } = await import("../../lib/tokenSpend");
  expect(await runInTenant(A, async () => tokenMaySpend(caller?.token))).toBe(true);
  /* Blank clears it: the token only prepares and prices again. */
  expect(await patch(admin(), "tok_member_render", { capCredits: "" })).toEqual({ status: 200, body: { id: "tok_member_render", capCredits: null } });
  expect(await stored("tok_member_render")).toEqual({ capCredits: null, capUsd: null });
  expect(await runInTenant(A, async () => tokenMaySpend((await auth.callerFromToken(MEMBER_RENDER))?.token))).toBe(false);
});

test("an admin's figure is read strictly, in the workspace's unit, and only a token that can generate takes one", async () => {
  for (const body of [{}, { capCredits: "lots" }, { capCredits: 0 }, { capCredits: 2.5 }, { capUsd: 20 }]) {
    const refused = await patch(admin(), "tok_owner_render", body);
    expect(refused.status, JSON.stringify(body)).toBe(400);
  }
  for (const id of ["tok_member_prep", "tok_member_read"]) {
    const refused = await patch(admin(), id, { capCredits: 300 });
    expect(refused.status, id).toBe(400);
    expect(String(refused.body.error)).toMatch(/Only a token that can generate takes a ceiling/);
  }
  expect((await patch(admin(), "tok_nobody", { capCredits: 300 })).status).toBe(404);
  expect(await stored("tok_owner_render")).toEqual({ capCredits: null, capUsd: null });
});

/* Must-fix of the money review: the admin's figure is the token's one ceiling. A dollar ceiling left from before credits (credits workspace)
   is replaced when the admin sets a credit ceiling, and cleared with it, so the page's "prepares and prices only" is true. */
const LEGACY_A = rawToken(A, "5"), LEGACY_B = rawToken(A, "6");
async function seedLegacy(id: string, raw: string, capUsd: number) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { tokenHash } = await import("../../lib/auth");
  await runInTenant(A, () => db().execute({ sql: "INSERT OR IGNORE INTO api_tokens(id,token_hash,name,user_id,scope,cap_usd,created_at) VALUES(?,?,?,'member','render',?,0)", args: [id, tokenHash(raw), `legacy ${id}`, capUsd] }));
}
/** The token as a request reads it, and a reservation of one job it would start, under its own store. */
async function asToken(raw: string) {
  const auth = await authAs(bearer(raw, "member"));
  const caller = await auth.callerFromToken(raw);
  if (!caller?.token || !caller.user) throw new Error("the token did not read");
  return caller;
}
async function reserveAs(raw: string, jobId: string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const caller = await asToken(raw);
  return runInTenant(A, () => reserveGenerationSpend({ id: jobId, kind: "video", engine: "byteplus", model: "dreamina-seedance-2-0-260128", status: "running", engineCostUsd: 1, createdBy: "member" }, { token: caller.token }),
    { user: caller.user, token: caller.token }).then(() => null, (error: { status?: number; message?: string }) => error);
}
async function metered(jobId: string) {
  const { platformDb } = await import("../../lib/platform");
  return Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE id=?", args: [jobId] })).rows[0].n);
}
async function lastAudit(target: string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  return runInTenant(A, async () => JSON.parse(String((await db().execute({ sql: "SELECT details FROM security_audit WHERE action='api_token.ceiling_set' AND target_id=? ORDER BY created_at DESC LIMIT 1", args: [target] })).rows[0]?.details ?? "null")));
}

test("clearing a token whose only ceiling is a dollar one from before credits makes it prepare-only: its paid work is refused, nothing reserved", async () => {
  const { grantCredits } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await alignLedgerUnit();
  await grantCredits(A.id, 10_000, "Test", "owner", "manual");
  await seedLegacy("tok_legacy_a", LEGACY_A, 20);
  const { runInTenant } = await import("../../lib/tenant");
  const { tokenMaySpend, tokenSpendRefusal } = await import("../../lib/tokenSpend");
  expect(await runInTenant(A, async () => tokenMaySpend((await asToken(LEGACY_A)).token))).toBe(true);
  const cleared = await patch(admin(), "tok_legacy_a", { capCredits: "" });
  expect(cleared).toEqual({ status: 200, body: { id: "tok_legacy_a", capCredits: null } });
  expect(await stored("tok_legacy_a")).toEqual({ capCredits: null, capUsd: null });
  expect(await lastAudit("tok_legacy_a")).toEqual({ ceilingUnit: "cr", ceilingBefore: null, ceilingAfter: null, legacyCleared: true });
  /* Prepare-only now: the route's gate and the spend gate both refuse it, and nothing is reserved. */
  const caller = await asToken(LEGACY_A);
  const refused = await runInTenant(A, async () => tokenSpendRefusal({ maxCredits: 50 }, caller.token));
  expect(refused?.status).toBe(403);
  expect(await refused?.json()).toMatchObject({ code: "token_no_ceiling", charged: 0 });
  const gate = await reserveAs(LEGACY_A, "gen_legacy_cleared");
  expect(gate).toMatchObject({ status: 403, message: expect.stringContaining("can only prepare and price") });
  expect(await metered("gen_legacy_cleared")).toBe(0);
});

test("setting 5,000 cr on a token with a dollar ceiling from before credits replaces it: a job past the old figure, within 5,000 cr, reserves", async () => {
  await seedLegacy("tok_legacy_b", LEGACY_B, 0.01);
  /* The old figure is under any job: refused at the reservation. */
  const before = await reserveAs(LEGACY_B, "gen_legacy_before");
  expect(before).toMatchObject({ status: 429, message: expect.stringContaining("monthly spending ceiling") });
  expect(await metered("gen_legacy_before")).toBe(0);
  const set = await patch(admin(), "tok_legacy_b", { capCredits: 5000 });
  expect(set).toEqual({ status: 200, body: { id: "tok_legacy_b", capCredits: 5000 } });
  expect(await stored("tok_legacy_b")).toEqual({ capCredits: 5000, capUsd: null });
  expect(await lastAudit("tok_legacy_b")).toEqual({ ceilingUnit: "cr", ceilingBefore: null, ceilingAfter: 5000, legacyCleared: true });
  expect(await reserveAs(LEGACY_B, "gen_legacy_after")).toBeNull();
  expect(await metered("gen_legacy_after")).toBe(1);
});

test("GET /api/tokens shows an admin the other members' tokens that can generate, never their secrets; a member sees only their own", async () => {
  const listed = async (who: Who) => {
    const route = load<typeof import("../../app/api/tokens/route")>("app/api/tokens/route.ts", {
      "@/lib/auth": await authAs(who), "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
      "@/lib/credits": await import("../../lib/credits"), "@/lib/cycle": await import("../../lib/cycle"), "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
      "@/lib/tokenUsage": await import("../../lib/tokenUsage"), "@/lib/securityAudit": await import("../../lib/securityAudit"),
      "@/lib/security/token-grants": await import("../../lib/security/token-grants"),
    });
    return (await route.GET(scoped(who, `${ORIGIN}/api/tokens`), undefined as never)).json();
  };
  const forAdmin = await listed(admin());
  expect(forAdmin.tokens.map((t: { id: string }) => t.id)).toEqual(["tok_owner_render"]);
  expect(forAdmin.others).toContainEqual(expect.objectContaining({ id: "tok_member_render", scope: "render", owner: "Member Person", capCredits: null }));
  /* Exactly the other members' tokens that can generate: never a prepare or read-only one, never the admin's own. */
  expect(forAdmin.others.map((t: { id: string }) => t.id).sort()).toEqual(["tok_legacy_a", "tok_legacy_b", "tok_member_render"]);
  expect(forAdmin.others.map((t: { id: string }) => t.id)).not.toContain("tok_owner_render");
  expect(forAdmin.others.every((t: { scope: string }) => t.scope === "render")).toBe(true);
  expect(JSON.stringify(forAdmin)).not.toMatch(/token_hash|pk_|capUsd/);
  const forMember = await listed(member());
  expect(forMember.others).toBeUndefined();
  /* Exactly the member's own tokens: never another person's. */
  expect(forMember.tokens.map((t: { id: string }) => t.id).sort()).toEqual(["tok_legacy_a", "tok_legacy_b", "tok_member_prep", "tok_member_read", "tok_member_render"]);
});

test("no agent path can set a ceiling: the route is an admin's session alone, and no MCP tool takes a ceiling", async () => {
  const source = readFileSync("app/api/tokens/[id]/ceiling/route.ts", "utf8");
  expect(source).toContain("const got = await requireAdmin();");
  const { TOOLS } = await import("../../lib/mcp");
  for (const tool of TOOLS) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/cap_?credits|cap_?usd|ceiling/i);
  /* POST /api/tokens names a ceiling only for an admin, too. */
  expect(readFileSync("app/api/tokens/route.ts", "utf8")).toContain('if ((capUsd != null || capCredits != null) && got.user.role !== "admin")');
});

/* The house pays its engines in dollars (lib/houseWorkspace.ts): its token ceilings are dollars, and an admin's figure replaces a leftover credit
   ceiling the same way a credit figure replaces a dollar one, recorded alike (whole cents, and legacyCleared). */
const H = workspace(dir, "ws_legacy");
const HOUSE_RENDER = rawToken(H, "7");
const houseAdmin = (): Who => ({ mode: "session", ws: H, userId: "owner", name: "Owner Person", role: "admin", bearer: "" });
test("in the house (dollars), an admin's dollar ceiling replaces a leftover credit one, recorded in whole cents with legacyCleared; clearing leaves none", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,1,'owner',0,0)", args: [H.id, "house", "House", H.dbUrl] });
  await seedPeople(H, [{ id: "owner", name: "Owner Person" }, { id: "member", name: "Member Person" }], [{ id: "tok_house_render", userId: "member", scope: "render", raw: HOUSE_RENDER }]);
  await runInTenant(H, () => db().execute("UPDATE api_tokens SET cap_credits = 300 WHERE id = 'tok_house_render'"));
  const read = async () => runInTenant(H, async () => {
    const row = (await db().execute("SELECT cap_credits, cap_usd FROM api_tokens WHERE id='tok_house_render'")).rows[0];
    const audit = (await db().execute("SELECT details FROM security_audit WHERE action='api_token.ceiling_set' AND target_id='tok_house_render' ORDER BY created_at DESC, rowid DESC LIMIT 1")).rows[0];
    return { capCredits: row.cap_credits == null ? null : Number(row.cap_credits), capUsd: row.cap_usd == null ? null : Number(row.cap_usd), audit: audit ? JSON.parse(String(audit.details)) : null };
  });
  /* A credit figure is refused here: the house counts in dollars. */
  expect((await patch(houseAdmin(), "tok_house_render", { capCredits: 500 })).status).toBe(400);
  /* Refused: nothing changed, and nothing was recorded. */
  expect(await read()).toEqual({ capCredits: 300, capUsd: null, audit: null });
  expect(await patch(houseAdmin(), "tok_house_render", { capUsd: "20.50" })).toEqual({ status: 200, body: { id: "tok_house_render", capUsd: 20.5 } });
  expect(await read()).toEqual({ capCredits: null, capUsd: 20.5, audit: { ceilingUnit: "usd_cents", ceilingBefore: null, ceilingAfter: 2050, legacyCleared: true } });
  expect(await patch(houseAdmin(), "tok_house_render", { capUsd: "" })).toEqual({ status: 200, body: { id: "tok_house_render", capUsd: null } });
  expect(await read()).toEqual({ capCredits: null, capUsd: null, audit: { ceilingUnit: "usd_cents", ceilingBefore: 2050, ceilingAfter: null } });
});
