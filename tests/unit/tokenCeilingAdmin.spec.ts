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
  expect(forAdmin.others).toEqual([expect.objectContaining({ id: "tok_member_render", scope: "render", owner: "Member Person", capCredits: null })]);
  expect(JSON.stringify(forAdmin)).not.toMatch(/token_hash|pk_|capUsd/);
  const forMember = await listed(member());
  expect(forMember.others).toBeUndefined();
  expect(forMember.tokens.map((t: { id: string }) => t.id).sort()).toEqual(["tok_member_prep", "tok_member_read", "tok_member_render"]);
});

test("no agent path can set a ceiling: the route is an admin's session alone, and no MCP tool takes a ceiling", async () => {
  const source = readFileSync("app/api/tokens/[id]/ceiling/route.ts", "utf8");
  expect(source).toContain("const got = await requireAdmin();");
  const { TOOLS } = await import("../../lib/mcp");
  for (const tool of TOOLS) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/cap_?credits|cap_?usd|ceiling/i);
  /* POST /api/tokens names a ceiling only for an admin, too. */
  expect(readFileSync("app/api/tokens/route.ts", "utf8")).toContain('if ((capUsd != null || capCredits != null) && got.user.role !== "admin")');
});
