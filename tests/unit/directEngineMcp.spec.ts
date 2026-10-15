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

test("a call asks the route for the price and sends the job with that price as its ceiling; the caller cannot write the approval; a retry key is the Idempotency-Key", async () => {
  const { runDirectEngineTool } = await import("../../lib/directEngineMcp");
  process.env.SYNC_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await inTenant(tenant("ws_legacy"), async () => {
    const { calls, call } = recorder({ estimatedCredits: 7, price: 0.7, unit: "usd" });
    const text = await runDirectEngineTool("lip_sync", { ...ARGS, model: "sync-3", request_id: "req-1" }, call);
    expect(text).toMatch(/^Lip-sync started\.\n\nid: gen_mcp_1\nprice: \$0\.70/);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ path: "/api/lipsync", body: { quoteOnly: true, model: "sync-3", clipUploadId: "up_clip", audioUploadId: "up_voice", castMemberId: "cast_a", faceFrameUploadId: "up_face", projectId: "prod_a", use: "production" } });
    expect(calls[0].body).not.toHaveProperty("maxCredits");
    expect(calls[1]).toMatchObject({ path: "/api/lipsync", body: { model: "sync-3", maxCredits: 7 }, headers: { "Idempotency-Key": "mcp-lip_sync:req-1" } });
    expect(calls[1].body).not.toHaveProperty("quoteOnly");
    /* The approval is never the caller's, under either spelling; a bad retry key is refused; an unpriced job starts nothing. */
    for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) { const r = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, ...bad }, r.call)).rejects.toThrow(/not yours to approve/); expect(r.calls).toEqual([]); }
    const r2 = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, request_id: "bad id!" }, r2.call)).rejects.toThrow(/request_id/); expect(r2.calls).toEqual([]);
    const r3 = recorder({ price: 1 }); await expect(runDirectEngineTool("lip_sync", ARGS, r3.call)).rejects.toThrow(/could not be priced/); expect(r3.calls).toHaveLength(1);
    /* A refusal from the route (the consent gate, the cap, a token that may not spend) reaches the agent as it is. */
    const refuse = async () => { throw new Error("This person's consent has no face reference yet."); };
    await expect(runDirectEngineTool("lip_sync", ARGS, refuse)).rejects.toThrow("no face reference yet");
    expect(await runDirectEngineTool("render_shot", ARGS, recorder().call)).toBeNull();
  });
});

test("the MCP endpoint lists and calls them through the same module, and says nothing else about spending", () => {
  const route = readFileSync("app/api/mcp/route.ts", "utf8");
  expect(route).toContain("tools: [...TOOLS, ...(await directEngineMcpTools())]");
  expect(route).toContain("(await runDirectEngineTool(name, args, call)) ??");
  const source = readFileSync("lib/directEngineMcp.ts", "utf8");
  expect(source).toContain("body: { ...clean, maxCredits: quote.estimatedCredits }");
  expect(source).not.toMatch(/args\.maxCredits|args\.max_credits|a\.max/);
});
