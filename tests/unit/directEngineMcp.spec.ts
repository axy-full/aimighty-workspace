import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The direct engines' tools over MCP (lib/directEngineMcp.ts): listed and callable only behind the engine gate, the same route and price as the button, and
 * the caller never writes the approval. Mocked: the "call" is a recorder standing in for the workspace's own API. Local temporary databases only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-direct-mcp-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.afterEach(() => { delete process.env.SYNC_ENABLED; delete process.env.REKOGNITION_ENABLED; });

const tenant = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
} as TenantWorkspace);
const inTenant = async (ws: TenantWorkspace, fn: () => Promise<void>) => (await import("../../lib/tenant")).runInTenant(ws, fn);

const recorder = (quote: Record<string, unknown> = { estimatedCredits: 5, price: 0.42, unit: "usd" }) => {
  const calls: { path: string; body: Record<string, unknown>; headers?: Record<string, string> }[] = [];
  const call = async (p: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const body = init.body as Record<string, unknown>;
    calls.push({ path: p, body, headers: init.headers });
    return body.quoteOnly === true ? quote : { id: "gen_mcp_1", status: "running" };
  };
  return { calls, call };
};
const ARGS = { cast_member_id: "cast_a", face_frame_upload_id: "up_face", project_id: "prod_a", use: "production", clip_upload_id: "up_clip", audio_upload_id: "up_voice" };

test("lip_sync is in the list, and callable, only where the engine gate and the face gate let this workspace have it", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  await inTenant(tenant("ws_legacy"), async () => {
    delete process.env.SYNC_ENABLED;
    expect(await directEngineMcpTools()).toEqual([]);
    const off = recorder();
    await expect(runDirectEngineTool("lip_sync", ARGS, off.call)).rejects.toThrow("There is no such tool here.");
    expect(off.calls).toEqual([]);
    process.env.SYNC_ENABLED = "1";
    expect(await directEngineMcpTools()).toEqual([]);
    process.env.REKOGNITION_ENABLED = "1";
    const listed = await directEngineMcpTools();
    expect(listed.map((t) => t.name)).toEqual(["lip_sync"]);
    expect((listed[0].inputSchema as { required: string[] }).required).toEqual(["cast_member_id", "face_frame_upload_id", "project_id", "use"]);
  });
  /* A customer workspace: not the house, not on the list. */
  process.env.SYNC_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await inTenant(tenant("ws_mcp_customer"), async () => {
    expect(await directEngineMcpTools()).toEqual([]);
    await expect(runDirectEngineTool("lip_sync", ARGS, recorder().call)).rejects.toThrow("There is no such tool here.");
  });
});

/** Sets the workspace's spending setting ("auto" is the only value that lets a call start; any other is Ask). */
async function setSpend(value: string | null) {
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  await ready();
  if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin");
  invalidateSettings();
}

test("only a person approves spending: Ask (the default) returns the priced, prepared job and starts nothing; Auto starts it only at or under the per-job line, never above guardrail 4; the caller cannot write the approval", async () => {
  const { runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { jobApprovalLineCredits } = await import("../../lib/approvalRule");
  const { creditUsd } = await import("../../lib/creditTerms");
  const line = jobApprovalLineCredits(creditUsd());
  expect(line).toBe(200);
  process.env.SYNC_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await inTenant(tenant("ws_legacy"), async () => {
    const prepared = /^Priced and prepared, not started\.\n\nprice: \$0\.70[\s\S]*needs a person's approval: nothing was started or spent/;
    /* Ask: the default, and anything but an exact "auto". */
    for (const mode of [null, "ask", "AUTO", "auto ", "yes", "1", ""]) {
      await setSpend(mode);
      const r = recorder({ estimatedCredits: 7, price: 0.7, unit: "usd" });
      const text = await runDirectEngineTool("lip_sync", { ...ARGS, model: "sync-3", request_id: "req-1" }, r.call);
      expect(text, String(mode)).toMatch(prepared);
      expect(text).toContain("prepared: lip-sync (sync-3) of up_clip with up_voice for production prod_a");
      expect(r.calls, String(mode)).toHaveLength(1);
      expect(r.calls[0].body).toMatchObject({ quoteOnly: true, model: "sync-3", clipUploadId: "up_clip" });
      expect(r.calls.some((c) => "maxCredits" in c.body)).toBe(false);
    }
    /* Auto, at or under the line: it starts, at the price the server just gave, under the retry key. */
    await setSpend("auto");
    for (const credits of [1, 7, line]) {
      const r = recorder({ estimatedCredits: credits, price: 0.7, unit: "usd" });
      const text = await runDirectEngineTool("lip_sync", { ...ARGS, request_id: "req-2" }, r.call);
      expect(text, String(credits)).toMatch(/^Lip-sync started\.\n\nid: gen_mcp_1\nprice: \$0\.70/);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[1]).toMatchObject({ path: "/api/lipsync", body: { maxCredits: credits }, headers: { "Idempotency-Key": "mcp-lip_sync:req-2" } });
      expect(r.calls[1].body).not.toHaveProperty("quoteOnly");
    }
    /* Auto, above the line (and so above guardrail 4): prepared, and it asks a person. */
    for (const credits of [line + 1, 250, 5000]) {
      const r = recorder({ estimatedCredits: credits, price: 20.5, unit: "usd" });
      expect(await runDirectEngineTool("lip_sync", ARGS, r.call), String(credits)).toMatch(/not started[\s\S]*needs a person's approval/);
      expect(r.calls).toHaveLength(1);
    }
    /* The caller never writes the approval, in either mode and under either spelling; a bad retry key is refused; an unpriced job starts nothing. */
    for (const mode of ["ask", "auto"]) {
      await setSpend(mode);
      for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) { const r = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, ...bad }, r.call)).rejects.toThrow(/only a person approves/); expect(r.calls).toEqual([]); }
    }
    const r2 = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, request_id: "bad id!" }, r2.call)).rejects.toThrow(/request_id/); expect(r2.calls).toEqual([]);
    const r3 = recorder({ price: 1 }); await expect(runDirectEngineTool("lip_sync", ARGS, r3.call)).rejects.toThrow(/could not be priced/); expect(r3.calls).toHaveLength(1);
    /* A refusal from the route (the consent gate, the cap, a token that may not spend) reaches the agent as it is. */
    const refuse = async () => { throw new Error("This person's consent has no face reference yet."); };
    await expect(runDirectEngineTool("lip_sync", ARGS, refuse)).rejects.toThrow("no face reference yet");
    expect(await runDirectEngineTool("render_shot", ARGS, recorder().call)).toBeNull();
    await setSpend(null);
  });
});

test("the MCP endpoint lists and calls them through the same module, and says nothing else about spending", () => {
  const route = readFileSync("app/api/mcp/route.ts", "utf8");
  expect(route).toContain("tools: [...TOOLS, ...(await directEngineMcpTools())]");
  expect(route).toContain("(await runDirectEngineTool(name, args, call)) ??");
  const source = readFileSync("lib/directEngineMcp.ts", "utf8");
  expect(source).toContain("maxCredits: quote.estimatedCredits");
  expect(source).toContain("if (!(await spendsWithoutAsking()) || quote.estimatedCredits > (await autoLineCredits()))");
  expect(source).not.toMatch(/args\.maxCredits|args\.max_credits|a\.max/);
  /* The send is after the Ask return and after the line: the only place a maxCredits is written. */
  expect(source.indexOf("needs a person")).toBeLessThan(source.indexOf("maxCredits: quote.estimatedCredits"));
});
