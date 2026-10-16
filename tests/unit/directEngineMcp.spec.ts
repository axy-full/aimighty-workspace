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
test.afterEach(() => { delete process.env.SYNC_ENABLED; });

const tenant = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
} as TenantWorkspace);
const inTenant = async (ws: TenantWorkspace, fn: () => Promise<void>) => (await import("../../lib/tenant")).runInTenant(ws, fn);

const recorder = (quote: Record<string, unknown> = { estimatedCredits: 5, price: 0.42, unit: "usd" }, door: { prepare?: "ok" | "refused" | "no-quote" } = {}) => {
  const calls: { path: string; body: Record<string, unknown>; headers?: Record<string, string> }[] = [];
  const call = async (p: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const body = init.body as Record<string, unknown>;
    calls.push({ path: p, body, headers: init.headers });
    /* The prepared-jobs door: a token made to prepare files the job; a render token is refused there by design (and, with "no-quote", a prepare token is refused at the paid door). */
    if (p === "/api/prepared-jobs") { if (door.prepare === "refused") throw new Error("Only a token made to prepare jobs files one; a person uses Make."); return { job: { id: "prep_1" } }; }
    if (door.prepare === "no-quote") throw new Error("This token prepares jobs; a person approves each in Particl.");
    return body.quoteOnly === true ? quote : { id: "gen_mcp_1", status: "running" };
  };
  return { calls, call };
};
const ARGS = { project_id: "prod_a", clip_upload_id: "up_clip", audio_upload_id: "up_voice" };

test("lip_sync is in the list, and callable, only where the engine gate and the house wall let this workspace have it (no face check, no consent record)", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  await inTenant(tenant("ws_legacy"), async () => {
    delete process.env.SYNC_ENABLED;
    expect(await directEngineMcpTools()).toEqual([]);
    const off = recorder();
    await expect(runDirectEngineTool("lip_sync", ARGS, off.call)).rejects.toThrow("There is no such tool here.");
    expect(off.calls).toEqual([]);
    process.env.SYNC_ENABLED = "1";
    const listed = await directEngineMcpTools();
    expect(listed.map((t) => t.name)).toEqual(["lip_sync"]);
    expect((listed[0].inputSchema as { required: string[] }).required).toEqual([]);
    expect(JSON.stringify(listed[0].inputSchema)).not.toMatch(/face|cast_member|consent/i);
  });
  /* A customer workspace: not the house (lip-sync is house-only until counsel answers). */
  process.env.SYNC_ENABLED = "1";
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
  await inTenant(tenant("ws_legacy"), async () => {
    const prepared = /^Priced and prepared, not started\.\n\nprice: \$0\.70[\s\S]*needs a person's approval: nothing was started or spent/;
    /* Ask: the default, and anything but an exact "auto". */
    for (const mode of [null, "ask", "AUTO", "auto ", "yes", "1", ""]) {
      await setSpend(mode);
      const r = recorder({ estimatedCredits: 7, price: 0.7, unit: "usd" });
      const text = await runDirectEngineTool("lip_sync", { ...ARGS, model: "sync-3", request_id: "req-1" }, r.call);
      expect(text, String(mode)).toMatch(prepared);
      expect(text).toContain("prepared: lip-sync (sync-3) of up_clip with up_voice for production prod_a");
      /* Filed for a person through the prepared-jobs door, and its id returned. */
      expect(text, String(mode)).toContain("prepared job: prep_1");
      expect(r.calls.map((c) => c.path), String(mode)).toEqual(["/api/lipsync", "/api/prepared-jobs"]);
      expect(r.calls[0].body).toMatchObject({ quoteOnly: true, model: "sync-3", clipUploadId: "up_clip" });
      expect(r.calls[1].body).toMatchObject({ engine: "lip_sync", prompt: "prepared: lip-sync (sync-3) of up_clip with up_voice for production prod_a", project: "prod_a", args: { model: "sync-3", clipUploadId: "up_clip", audioUploadId: "up_voice" } });
      /* No price, approval or quote flag rides in the filed job. */
      expect(JSON.stringify(r.calls[1].body)).not.toMatch(/maxCredits|quoteOnly|fingerprint/i);
      expect(r.calls.some((c) => "maxCredits" in c.body)).toBe(false);
    }
    /* Auto runs only a DRAFT (lipsync-2) at or under the line; the full-quality models (the default lipsync-2-pro, and sync-3) always ask, at any price. */
    await setSpend("auto");
    for (const model of [undefined, "lipsync-2-pro", "sync-3"]) {
      const r = recorder({ estimatedCredits: 1, price: 0.05, unit: "usd" });
      expect(await runDirectEngineTool("lip_sync", { ...ARGS, ...(model ? { model } : {}) }, r.call), String(model)).toMatch(/not started[\s\S]*prepared job: prep_1[\s\S]*needs a person's approval/);
      expect(r.calls.map((c) => c.path)).toEqual(["/api/lipsync", "/api/prepared-jobs"]);
      expect(r.calls.some((c) => "maxCredits" in c.body)).toBe(false);
    }
    /* A draft at or under the line: it starts, at the price the server just gave, under the retry key. */
    for (const credits of [1, 7, line]) {
      const r = recorder({ estimatedCredits: credits, price: 0.7, unit: "usd" });
      const text = await runDirectEngineTool("lip_sync", { ...ARGS, model: "lipsync-2", request_id: "req-2" }, r.call);
      expect(text, String(credits)).toMatch(/^Lip-sync started\.\n\nid: gen_mcp_1\nprice: \$0\.70/);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[1]).toMatchObject({ path: "/api/lipsync", body: { maxCredits: credits }, headers: { "Idempotency-Key": "mcp-lip_sync:req-2" } });
      expect(r.calls[1].body).not.toHaveProperty("quoteOnly");
    }
    /* Auto, above the line (and so above guardrail 4): prepared, and it asks a person. */
    for (const credits of [line + 1, 250, 5000]) {
      const r = recorder({ estimatedCredits: credits, price: 20.5, unit: "usd" });
      expect(await runDirectEngineTool("lip_sync", { ...ARGS, model: "lipsync-2" }, r.call), String(credits)).toMatch(/not started[\s\S]*needs a person's approval/);
      expect(r.calls.map((c) => c.path)).toEqual(["/api/lipsync", "/api/prepared-jobs"]);
    }
    /* The caller never writes the approval, in either mode and under either spelling; a bad retry key is refused; an unpriced job starts nothing. */
    for (const mode of ["ask", "auto"]) {
      await setSpend(mode);
      for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) { const r = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, ...bad }, r.call)).rejects.toThrow(/only a person approves/); expect(r.calls).toEqual([]); }
    }
    /* A render token cannot file a prepared job (refused by design): the answer is in words only and nothing starts. A prepare token cannot even ask for a price: its call is filed unpriced. */
    await setSpend("ask");
    const refused = recorder({ estimatedCredits: 7, price: 0.7, unit: "usd" }, { prepare: "refused" });
    const wordsOnly = await runDirectEngineTool("lip_sync", ARGS, refused.call);
    /* Never claims a job was filed when it was not: it says so plainly, gives the door's reason, and says what the person does instead. */
    expect(wordsOnly).toMatch(/^Priced, not started\.[\s\S]*Nothing was filed: Only a token made to prepare jobs files one[\s\S]*nothing was started or spent\. A person can make this themselves in Particl, where its price is shown/);
    expect(wordsOnly).not.toMatch(/prepared job:|waits in Particl|Priced and prepared/);
    const preparer = recorder({}, { prepare: "no-quote" });
    const unpriced = await runDirectEngineTool("lip_sync", ARGS, preparer.call);
    expect(unpriced).toMatch(/^Prepared, not started\.[\s\S]*prepared job: prep_1[\s\S]*nothing was started or spent/);
    expect(preparer.calls.map((c) => c.path)).toEqual(["/api/lipsync", "/api/prepared-jobs"]);
    /* Any other refusal at the paid door still reaches the agent. */
    const other = async () => { throw new Error("The cap was reached."); };
    await expect(runDirectEngineTool("lip_sync", ARGS, other)).rejects.toThrow("cap was reached");
    const r2 = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, request_id: "bad id!" }, r2.call)).rejects.toThrow(/request_id/); expect(r2.calls).toEqual([]);
    const r3 = recorder({ price: 1 }); await expect(runDirectEngineTool("lip_sync", ARGS, r3.call)).rejects.toThrow(/could not be priced/); expect(r3.calls).toHaveLength(1);
    /* A refusal from the route (the cap, a token that may not spend, the provider's own words) reaches the agent as it is. */
    const refuse = async () => { throw new Error("sync.so refused the request: the clip is too long"); };
    await expect(runDirectEngineTool("lip_sync", ARGS, refuse)).rejects.toThrow("the clip is too long");
    expect(await runDirectEngineTool("render_shot", ARGS, recorder().call)).toBeNull();
    await setSpend(null);
  });
});

test("an engine job in the prepared-jobs door: filed by a token made to prepare, with no price or approval in it, read back as words (never its arguments), refused to any other token, and never opened in Make", async () => {
  const jobs = await import("../../lib/security/prepared-jobs");
  const { preparedSpec } = await import("../../lib/security/prepared-words");
  const { db, ready } = await import("../../lib/db");
  await inTenant(tenant("ws_prepared_engine"), async () => {
    await ready();
    const token = { id: `tok_${Date.now().toString(36)}`, scope: "prepare" };
    const filed = await jobs.prepareJob({ engine: "lip_sync", prompt: "prepared: lip-sync (sync-3) of up_clip", project: "prod_a", args: { model: "sync-3", clipUploadId: "up_clip", audioUploadId: "up_voice", skipped: undefined } }, token);
    expect(filed).toMatchObject({ engine: { tool: "lip_sync" }, state: "waiting", project: "prod_a", prompt: "prepared: lip-sync (sync-3) of up_clip" });
    expect(JSON.stringify(filed)).not.toMatch(/clipUploadId|audioUploadId|args/);
    expect(preparedSpec(filed)).toBe("lip sync");
    /* The arguments are kept for the person's approval, in the workspace's own database. */
    const row = (await db().execute({ sql: "SELECT settings_json FROM prepared_jobs WHERE id=?", args: [filed.id] })).rows[0];
    expect(JSON.parse(String(row.settings_json))).toEqual({ engine: "lip_sync", args: { model: "sync-3", clipUploadId: "up_clip", audioUploadId: "up_voice" } });
    /* Lists and groups of ids are kept (an image call names its uploads and people), with no migration: the arguments are JSON in the row that is already there. */
    const nested = await jobs.prepareJob({ engine: "veo_video", prompt: "prepared: video", args: { prompt: "A crane at dawn, wide", references: [{ uploadId: "up_a" }, { uploadId: "up_b" }], firstFrame: { uploadId: "up_f" }, seconds: 8, audio: true } }, token);
    const nestedRow = (await db().execute({ sql: "SELECT settings_json FROM prepared_jobs WHERE id=?", args: [nested.id] })).rows[0];
    expect(JSON.parse(String(nestedRow.settings_json))).toEqual({ engine: "veo_video", args: { prompt: "A crane at dawn, wide", references: [{ uploadId: "up_a" }, { uploadId: "up_b" }], firstFrame: { uploadId: "up_f" }, seconds: 8, audio: true } });
    expect(JSON.stringify(nested)).not.toMatch(/up_a|up_f|references|firstFrame/);
    /* ...but bounded, ids only, and never an approval or file bytes: text or a data address inside a list, a price key at any depth, too deep, too many, too large. */
    const refuse = (args: Record<string, unknown>) => jobs.prepareJob({ engine: "veo_video", prompt: "x", args }, token);
    await expect(refuse({ references: [{ uploadId: "data:image/png;base64,AAAA" }] })).rejects.toThrow(/id, not text or a file/);
    await expect(refuse({ references: ["a long sentence with spaces"] })).rejects.toThrow(/id, not text or a file/);
    await expect(refuse({ references: [{ uploadId: "x".repeat(200) }] })).rejects.toThrow(/id, not text or a file/);
    await expect(refuse({ references: [{ maxCredits: 1 }] })).rejects.toThrow(/only a person approves/);
    await expect(refuse({ a: { b: { c: { d: "x" } } } })).rejects.toThrow(/too deep/);
    await expect(refuse({ references: Array.from({ length: 17 }, (_, i) => `up_${i}`) })).rejects.toThrow(/too many items/);
    await expect(refuse({ g: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) })).rejects.toThrow(/too many entries/);
    await expect(refuse(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "x".repeat(1900)])))).rejects.toThrow(/too large/);
    await expect(refuse({ f: () => 1 })).rejects.toThrow(/word, a number or yes\/no/);
    /* A render token, a read token and no token do not file one (as for a render). */
    for (const scope of ["render", "read"]) await expect(jobs.prepareJob({ engine: "lip_sync", prompt: "x", args: {} }, { id: "tok_x", scope })).rejects.toThrow(/Only a token made to prepare/);
    await expect(jobs.prepareJob({ engine: "lip_sync", prompt: "x", args: {} }, undefined)).rejects.toThrow(/Only a token made to prepare/);
    /* A price, an approval or a quote flag in the arguments is refused, under any spelling. */
    for (const key of ["maxCredits", "max_credits", "quoteOnly", "quoteFingerprint", "approved", "price", "estimatedCredits"])
      await expect(jobs.prepareJob({ engine: "lip_sync", prompt: "x", args: { [key]: 1 } }, token), key).rejects.toThrow(/only a person approves/);
    for (const bad of [{ engine: "Lip Sync", prompt: "x", args: {} }, { engine: "lip_sync", prompt: "", args: {} }, { engine: "lip_sync", prompt: "x", args: [] }, { engine: "lip_sync", prompt: "x", args: { a: { b: "has spaces" } } }, { engine: "lip_sync", prompt: "x", args: { "bad key": 1 } }])
      await expect(jobs.prepareJob(bad, token), JSON.stringify(bad)).rejects.toThrow();
    /* A person decides it (marked, never erased); a Seedance job is unchanged. */
    expect(await jobs.decidePrepared(filed.id, "dismissed", "u_person")).toBe(true);
    const seedance = await jobs.prepareJob({ prompt: "A crane at dawn", model: "2.5", duration: 5 }, token);
    expect(seedance.engine).toBeNull();
    expect(preparedSpec(seedance)).toMatch(/^Seedance 2\.5/);
  });
  /* Settings › Connections never offers "Open in Make" for an engine job (Make opens a Seedance render). */
  expect(readFileSync("components/graphite/settings/connections/ConnectionsSection.tsx", "utf8")).toContain("{job.engine ? null : <Btn");
});

test("the MCP endpoint lists and calls them through the same module, and says nothing else about spending", () => {
  const route = readFileSync("app/api/mcp/route.ts", "utf8");
  expect(route).toContain("tools: [...TOOLS, ...(await directEngineMcpTools())]");
  expect(route).toContain("(await runDirectEngineTool(name, args, call)) ??");
  const source = readFileSync("lib/directEngineMcp.ts", "utf8");
  expect(source).toContain("maxCredits: quote.estimatedCredits");
  expect(source).toContain("if (!(await spendsWithoutAsking()) || !(tool.draft?.(clean) ?? false) || quote.estimatedCredits > (await autoLineCredits()))");
  expect(source).not.toMatch(/args\.maxCredits|args\.max_credits|a\.max/);
  /* The send is after the Ask return and after the line: the only place a maxCredits is written. */
  expect(source.indexOf("needs a person")).toBeLessThan(source.indexOf("maxCredits: quote.estimatedCredits"));
});
