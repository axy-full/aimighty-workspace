import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-crew-mcp-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "crew-mcp-unit-keyring-32-characters";
process.env.ENGINE_MOCK = "1";

async function fixture() {
  const { platformReady, platformDb, getWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { createSession, claimRound, listMembers } = await import("../../lib/crew/store");
  const { DEFAULT_CONTEXT } = await import("../../lib/crew/room");
  await platformReady();
  const id = `crew_mcp_${randomUUID()}`, owner = `owner_${id}`;
  await platformDb().batch([
    { sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,'unused',0)", args: [owner, `${owner}@example.test`, "Crew fixture"] },
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at,uses_platform_keys) VALUES(?,?,?,?,?,0,0,1)", args: [id, id, id, `file:${path.join(dir, id + '.db')}`, owner] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',0)", args: [id, owner] },
  ], "write");
  const workspace = (await getWorkspace(id)) as TenantWorkspace;
  const session = await runInTenant(workspace, async () => {
    await listMembers(owner, "same-project-id");
    const session = await createSession(owner, { projectId: "same-project-id", goal: "Find the ending", context: DEFAULT_CONTEXT, model: "grok-4.6" });
    expect(await claimRound(owner, session.id, 1)).toBe(true);
    return session;
  });
  return { workspace, owner, session };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const { handleCrewMcp } = await import("../../lib/crew/mcp");
  return handleCrewMcp(new Request("https://studio.example.test/api/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
}

test("shared studios read only recorded Crew credits, including legacy rooms, without rewriting settlement", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { readSession, listSessions, releaseRound } = await import("../../lib/crew/store");
  const a = await fixture(), b = await fixture();
  await runInTenant(a.workspace, async () => {
    await releaseRound(a.owner, a.session.id, { spendUsd: 7.25, spendCr: null });
    const legacy = await readSession(a.owner, a.session.id);
    expect(legacy?.spendCr).toBeNull();
    expect(legacy).not.toHaveProperty("spendUsd");
    expect((await listSessions(a.owner, "same-project-id"))[0]).not.toHaveProperty("spendUsd");
    const before = (await db().execute({ sql: "SELECT spend_usd,spend_cr FROM crew_sessions WHERE id=?", args: [a.session.id] })).rows[0];
    expect(before).toMatchObject({ spend_usd: 7.25, spend_cr: null });
    await releaseRound(a.owner, a.session.id, { spendUsd: .75, spendCr: 12 });
    expect(await readSession(a.owner, a.session.id)).toMatchObject({ spendCr: 12, roundsRun: 2 });
    expect(await readSession(a.owner, a.session.id)).not.toHaveProperty("spendUsd");
    expect((await db().execute({ sql: "SELECT spend_usd,spend_cr FROM crew_sessions WHERE id=?", args: [a.session.id] })).rows[0]).toMatchObject({ spend_usd: 8, spend_cr: 12 });
  });
  await runInTenant(b.workspace, async () => {
    expect(await readSession(a.owner, a.session.id)).toBeNull();
    expect(await listSessions(a.owner, "same-project-id")).toEqual([]);
  });
});

test("Crew MCP binds immutable context to one room and exposes no paid or cross-workspace tools", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { issueCrewMcp } = await import("../../lib/crew/mcp");
  const { platformDb } = await import("../../lib/platform");
  const original = process.env.APP_ORIGIN; process.env.APP_ORIGIN = "https://studio.example.test";
  try {
    const a = await fixture(), b = await fixture();
    const one = await runInTenant(a.workspace, () => issueCrewMcp(a.owner, a.session.id, "Project A: private selected brief"));
    const two = await runInTenant(b.workspace, () => issueCrewMcp(b.owner, b.session.id, "Project B: different selected brief"));
    expect(one.url).toBe("https://studio.example.test/api/mcp");
    const tools = await (await rpc(one.token, "tools/list")).json();
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["crew_context"]);
    expect((await (await rpc(one.token, "tools/call", { name: "crew_context", arguments: {} })).json()).result.content[0].text).toBe("Project A: private selected brief");
    expect((await (await rpc(two.token, "tools/call", { name: "crew_context" })).json()).result.content[0].text).toBe("Project B: different selected brief");
    for (const params of [{ name: "render_shot" }, { name: "list_projects" }, { name: "crew_context", arguments: { workspaceId: b.workspace.id } }, { name: "crew_context", arguments: { sessionId: b.session.id } }])
      expect((await (await rpc(one.token, "tools/call", params)).json()).error.code).toBe(-32601);
    const rows = (await platformDb().execute("SELECT * FROM crew_mcp_capabilities")).rows;
    expect(JSON.stringify(rows)).not.toContain(one.token);
    expect(JSON.stringify(rows)).not.toContain("private selected brief");
    await one.revoke();
    expect((await rpc(one.token, "tools/list")).status).toBe(401);
    expect((await rpc(two.token, "tools/list")).status).toBe(200);
    await two.revoke();
  } finally { if (original === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = original; }
});

test("expiry, membership, suspension, account policy and a completed round revoke Crew context", async () => {
  const { issueCrewMcp } = await import("../../lib/crew/mcp");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { releaseRound } = await import("../../lib/crew/store");
  const original = process.env.APP_ORIGIN; process.env.APP_ORIGIN = "https://studio.example.test";
  try {
    const { workspace, owner, session } = await fixture();
    const access = await runInTenant(workspace, () => issueCrewMcp(owner, session.id, "Scoped context"));
    for (const [sql, values, restore] of [
      ["UPDATE memberships SET disabled=? WHERE workspace_id=?", [1, workspace.id], 0],
      ["UPDATE accounts SET disabled=? WHERE id=?", [1, owner], 0],
      ["UPDATE workspaces SET suspended_at=? WHERE id=?", [Date.now(), workspace.id], null],
      ["UPDATE workspaces SET requires_mfa=? WHERE id=?", [1, workspace.id], 0],
    ] as const) {
      await platformDb().execute({ sql, args: [...values] });
      expect((await rpc(access.token, "tools/list")).status).toBe(401);
      await platformDb().execute({ sql, args: [restore, values[1]] });
      expect((await rpc(access.token, "tools/list")).status).toBe(200);
    }
    await platformDb().execute({ sql: "UPDATE crew_mcp_capabilities SET expires_at=0 WHERE token_hash=?", args: [createHash("sha256").update(access.token).digest("hex")] });
    expect((await rpc(access.token, "tools/list")).status).toBe(401);
    const fresh = await runInTenant(workspace, () => issueCrewMcp(owner, session.id, "Scoped context"));
    expect((await rpc(fresh.token, "tools/list")).status).toBe(200);
    await runInTenant(workspace, () => releaseRound(owner, session.id));
    expect((await rpc(fresh.token, "tools/list")).status).toBe(401);
    expect((await rpc("crewmcp_" + "a".repeat(64), "tools/list")).status).toBe(401);
  } finally { if (original === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = original; }
});

test("Grok uses native effort and bounded MCP Responses once, never replays an uncertain paid call", async () => {
  const { askGrok } = await import("../../lib/crew/xai");
  const { CREW_OUTPUT_TOKENS, CREW_MAX_TURNS } = await import("../../lib/crew/room");
  const prior = { fetch: globalThis.fetch, key: process.env.XAI_API_KEY, mock: process.env.ENGINE_MOCK };
  process.env.XAI_API_KEY = "unit-only-never-sent"; process.env.ENGINE_MOCK = "0";
  let calls = 0;
  const input = { system: "Use selected context", user: "Find the ending", phase: "propose" as const, effort: "high" as const, mock: () => "", model: "grok-4.6", mcp: { url: "https://studio.example.test/api/mcp", token: "crewmcp_unit" } };
  try {
    globalThis.fetch = async (url, init) => {
      calls++; expect(url).toBe("https://api.x.ai/v1/responses");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "grok-4.6", reasoning: { effort: "high" }, max_output_tokens: CREW_OUTPUT_TOKENS.high, max_turns: CREW_MAX_TURNS, store: false,
        tools: [{ type: "mcp", allowed_tools: ["crew_context"], headers: { Authorization: "Bearer crewmcp_unit" } }] });
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "A held wide shot." }] }], usage: { input_tokens: 10, output_tokens: 20, cost_in_usd_ticks: 210000 } });
    };
    expect(await askGrok(input)).toMatchObject({ ok: true, text: "A held wide shot.", providerCostUsd: .000021 });
    expect(calls).toBe(1);
    for (const fail of [async () => new Response("private failure", { status: 503 }), async () => { throw new Error("lost response"); }, async () => Response.json({ status: "completed", output: [], usage: {} })]) {
      calls = 0; globalThis.fetch = async () => { calls++; return fail(); };
      const result = await askGrok(input); expect(result.ok).toBe(false); expect(calls).toBe(1);
      expect(JSON.stringify(result)).not.toMatch(/private failure|unit-only-never-sent|crewmcp_unit/);
    }
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.key === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prior.key;
    if (prior.mock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = prior.mock;
  }
});

test("a crashed or uncertain paid round stays fenced after its UI lease expires", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { claimRound, claimRoundDispatch, finishRoundDispatch, readSession, releaseRound } = await import("../../lib/crew/store");
  const { workspace, owner, session } = await fixture();
  await runInTenant(workspace, async () => {
    await claimRoundDispatch(session.id, 1);
    await db().execute({ sql: "UPDATE crew_sessions SET running_since=0 WHERE id=?", args: [session.id] });
    expect((await readSession(owner, session.id))?.needsReview).toBe(true);
    expect(await claimRound(owner, session.id, 1)).toBe(false);
    await expect(claimRoundDispatch(session.id, 1)).rejects.toThrow("already contacted");
    await finishRoundDispatch(session.id, 1, true);
    await releaseRound(owner, session.id);
    expect(await claimRound(owner, session.id, 1)).toBe(false);
    expect((await readSession(owner, session.id))?.needsReview).toBe(true);
  });
});


test("a complete Grok round reads its selected MCP context, settles once and revokes access", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { runRound, quoteRound } = await import("../../lib/crew/round");
  const { listMembers, listMessages, releaseRound, claimRound } = await import("../../lib/crew/store");
  const { newProject } = await import("../../lib/workbench/studio");
  const { platformDb, grantCredits } = await import("../../lib/platform");
  const { workspace, owner, session } = await fixture();
  await grantCredits(workspace.id, 10000, "Crew fixture", null, "manual");
  const prior = { fetch: globalThis.fetch, key: process.env.XAI_API_KEY, mock: process.env.ENGINE_MOCK, origin: process.env.APP_ORIGIN };
  process.env.XAI_API_KEY = "unit-only-never-sent"; process.env.ENGINE_MOCK = "0"; process.env.APP_ORIGIN = "https://studio.example.test";
  let calls = 0; const tokens = new Set<string>(); const events: unknown[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://api.x.ai/v1/responses"); calls++;
      const body = JSON.parse(String(init?.body));
      const token = body.tools[0].headers.Authorization.slice(7); tokens.add(token);
      const context = (await (await rpc(token, "tools/call", { name: "crew_context" })).json()).result.content[0].text;
      expect(context).toContain("This brief belongs only to this project");
      expect(context).not.toContain("Do not include this script");
      const chair = body.input[0].content.includes("PHASE: CONVERGE");
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: chair ? "1. Opening — Hold the wide shot.\n2. Detail — Show the bottle.\n3. Close — End on a glance." : "Start with a held wide shot." }] }], usage: { input_tokens: 10, output_tokens: 20, cost_in_usd_ticks: 210000 } });
    };
    await runInTenant(workspace, async () => {
      const active = (await listMembers(owner, session.projectId)).slice(0, 1).map(member => ({ ...member, isChair: true }));
      const project = { ...newProject("A private project"), brief: "This brief belongs only to this project", script: "Do not include this script" };
      const selected = { ...session, context: { ...session.context, script: false } };
      const rate = { inputUsdPerToken: .000001, outputUsdPerToken: .000003 };
      const quote = quoteRound({ session: selected, project, active, rate, transcriptChars: 0 });
      const result = await runRound({ session: selected, project, active, rate, ceilingUsd: quote.ceilingUsd, userId: owner, emit: event => events.push(event) });
      expect(result.billed, JSON.stringify(events)).toBe(true); expect(result.spendCr).toBeGreaterThan(0);
      expect((await listMessages(session.id)).length).toBe(2);
      await releaseRound(owner, session.id, result);
      expect(await claimRound(owner, session.id, 1)).toBe(false);
      const meter = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE workspace_id=?", args: [workspace.id] })).rows;
      expect(meter).toHaveLength(1); expect(Number(meter[0].billed_credits)).toBe(result.spendCr);
    });
    expect(calls).toBe(2); expect(tokens.size).toBe(1);
    for (const token of tokens) expect((await rpc(token, "tools/list")).status).toBe(401);
    expect(JSON.stringify(events)).not.toMatch(/cost_in_usd_ticks|engineCostUsd|unit-only-never-sent|crewmcp_/);
  } finally {
    globalThis.fetch = prior.fetch;
    for (const [key, value] of [["XAI_API_KEY", prior.key], ["ENGINE_MOCK", prior.mock], ["APP_ORIGIN", prior.origin]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
