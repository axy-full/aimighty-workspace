import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The direct engines' tools over MCP (lib/directEngineMcp.ts): listed and callable only behind the engine gate, the same route and price as the button, and
 * the caller never writes the approval. A token with no monthly ceiling only prepares; a token with one an admin set starts lip_sync at its quote, whatever
 * the workspace's old spending setting says (owner, 20 Oct 2026: "A capped token spends inside its ceiling whatever the workspace's Ask setting (ceiling =
 * standing approval). lip_sync follows the same rule once Auto goes."). Mocked: the "call" is a recorder standing in for the workspace's own API. Local temporary databases only.
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

/* The route is mocked: every price it answers here is a SYNTHETIC PLACEHOLDER (repeated digits), not a vendor's price. */
const PLACEHOLDER_PRICE_USD = 1.11;
const PLACEHOLDER_PRICE_B_USD = 3.33;
const PLACEHOLDER_PRICE_D_USD = 99.99;
const recorder = (quote: Record<string, unknown> = { estimatedCredits: 5, price: PLACEHOLDER_PRICE_USD, unit: "usd" }, door: { prepare?: "ok" | "refused" | "no-quote" } = {}) => {
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

/** Sets the workspace's old spending setting. Since 20 Oct 2026 it is not read: no value lets a call start ("auto" included), and none stops a capped token's. */
async function setSpend(value: string | null) {
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  await ready();
  if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin");
  invalidateSettings();
}

test("a token with no monthly ceiling: every call returns the priced, prepared job and starts nothing, whatever the stored setting says (\"auto\" included: no Auto since 20 Oct 2026), whatever the model and price; the caller cannot write the approval", async () => {
  const { runDirectEngineTool } = await import("../../lib/directEngineMcp");
  process.env.SYNC_ENABLED = "1";
  await inTenant(tenant("ws_legacy"), async () => {
    const prepared = /^Priced and prepared, not started\.\n\nprice: \$3\.33[\s\S]*needs a person's approval: nothing was started or spent/;
    /* Every stored value of the old setting, "auto" exactly included: the setting is no longer read, and with no ceiling (`spends` absent or false,
       as POST /api/mcp passes it from the bearer) nothing starts. */
    for (const options of [undefined, { spends: false }])
    for (const mode of [null, "ask", "auto", "AUTO", "auto ", "yes", "1", ""]) {
      await setSpend(mode);
      const r = recorder({ estimatedCredits: 7, price: PLACEHOLDER_PRICE_B_USD, unit: "usd" });
      const text = await runDirectEngineTool("lip_sync", { ...ARGS, model: "sync-3", request_id: "req-1" }, r.call, options);
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
    /* Stored "auto", a draft model (lipsync-2) and any price, small or large (the old Auto line was 200 cr): prepared for a person, never started. */
    await setSpend("auto");
    for (const model of [undefined, "lipsync-2", "lipsync-2-pro", "sync-3"])
      for (const credits of [1, 7, 200, 201, 5000]) {
        const r = recorder({ estimatedCredits: credits, price: PLACEHOLDER_PRICE_D_USD, unit: "usd" });
        const text = await runDirectEngineTool("lip_sync", { ...ARGS, ...(model ? { model } : {}), request_id: "req-2" }, r.call);
        expect(text, `${model} ${credits}`).toMatch(/not started[\s\S]*prepared job: prep_1[\s\S]*needs a person's approval/);
        expect(text).not.toMatch(/Lip-sync started/);
        expect(r.calls.map((c) => c.path)).toEqual(["/api/lipsync", "/api/prepared-jobs"]);
        expect(r.calls.some((c) => "maxCredits" in c.body)).toBe(false);
      }
    /* The caller never writes the approval, whatever the old setting holds, with a ceiling or without, under either spelling; a bad retry key is refused; an unpriced job starts nothing. */
    for (const mode of ["ask", "auto"]) {
      await setSpend(mode);
      for (const options of [undefined, { spends: true }])
        for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) { const r = recorder(); await expect(runDirectEngineTool("lip_sync", { ...ARGS, ...bad }, r.call, options)).rejects.toThrow(/only a person approves/); expect(r.calls).toEqual([]); }
    }
    /* A render token cannot file a prepared job (refused by design): the answer is in words only and nothing starts. A prepare token cannot even ask for a price: its call is filed unpriced. */
    await setSpend("ask");
    const refused = recorder({ estimatedCredits: 7, price: PLACEHOLDER_PRICE_B_USD, unit: "usd" }, { prepare: "refused" });
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
    /* No confirmed price on this server (the route's 503 "unpriced", lib/vendorPriceFile.ts): the agent is told, and nothing is filed or started. */
    const unpricedCalls: string[] = [];
    const noPrice = async (p: string) => { unpricedCalls.push(p); throw new Error("This engine has no confirmed price."); };
    await expect(runDirectEngineTool("lip_sync", ARGS, noPrice)).rejects.toThrow("This engine has no confirmed price.");
    expect(unpricedCalls).toEqual(["/api/lipsync"]);
    expect(await runDirectEngineTool("render_shot", ARGS, recorder().call)).toBeNull();
    await setSpend(null);
  });
});

test("a token with a monthly ceiling an admin set: lip_sync is priced, then started at exactly that quote as its maxCredits, whatever the old setting says (\"ask\" included), the model and the price; a retry key rides along; a stale or refused start reaches the agent", async () => {
  const { runDirectEngineTool } = await import("../../lib/directEngineMcp");
  process.env.SYNC_ENABLED = "1";
  await inTenant(tenant("ws_legacy"), async () => {
    for (const mode of [null, "ask", "auto", "no"])
      for (const model of [undefined, "lipsync-2", "lipsync-2-pro", "sync-3"])
        for (const credits of [1, 7, 200, 201, 5000]) {
          await setSpend(mode);
          const r = recorder({ estimatedCredits: credits, price: PLACEHOLDER_PRICE_D_USD, unit: "cr" });
          const text = await runDirectEngineTool("lip_sync", { ...ARGS, ...(model ? { model } : {}), request_id: "req-3" }, r.call, { spends: true });
          const label = `${mode} ${model} ${credits}`;
          expect(text, label).toBe(`Lip-sync started.\n\nid: gen_mcp_1\nprice: ${credits} cr\n\nCall get_render with this id to collect it.`);
          /* The quote, then the job at that quote: nothing filed for a person, nothing more than the quote approved. */
          expect(r.calls.map((c) => c.path), label).toEqual(["/api/lipsync", "/api/lipsync"]);
          expect(r.calls[0].body, label).toMatchObject({ quoteOnly: true, clipUploadId: "up_clip", audioUploadId: "up_voice", projectId: "prod_a" });
          expect(r.calls[0].body, label).not.toHaveProperty("maxCredits");
          expect(r.calls[1].body, label).toEqual({ ...r.calls[0].body, quoteOnly: undefined, maxCredits: credits });
          expect(r.calls[1].headers, label).toEqual({ "Idempotency-Key": "mcp-lip_sync:req-3" });
        }
    /* No retry key: none is sent. */
    const plain = recorder({ estimatedCredits: 9, price: 9, unit: "cr" });
    await runDirectEngineTool("lip_sync", ARGS, plain.call, { spends: true });
    expect(plain.calls[1].headers).toBeUndefined();
    /* An unpriced answer starts nothing, with a ceiling too. */
    const unpriced = recorder({ price: 1 });
    await expect(runDirectEngineTool("lip_sync", ARGS, unpriced.call, { spends: true })).rejects.toThrow(/could not be priced/);
    expect(unpriced.calls).toHaveLength(1);
    /* The route's own refusal of the start (past the token's ceiling at the reservation, a stale quote) reaches the agent as it is. */
    const past = async (p: string, init: { body?: unknown } = {}) => {
      if ((init.body as Record<string, unknown>).quoteOnly === true) return { estimatedCredits: 9, price: 9, unit: "cr" };
      void p; throw new Error("This job and the reserved jobs would pass this token's 100 cr monthly ceiling.");
    };
    await expect(runDirectEngineTool("lip_sync", ARGS, past, { spends: true })).rejects.toThrow(/monthly ceiling/);
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

test("the MCP endpoint lists and calls them through the same module, and passes only whether the bearer has a ceiling, for a tool started inside one", () => {
  const route = readFileSync("app/api/mcp/route.ts", "utf8");
  expect(route).toContain("tools: [...TOOLS, ...(await directEngineMcpTools())]");
  expect(route).toContain("(await runDirectEngineTool(name, args, call, { spends: directToolStartsInsideCeiling(name) ? await bearerMaySpend(req) : false })) ??");
  const source = readFileSync("lib/directEngineMcp.ts", "utf8");
  /* No Auto (owner, 20 Oct 2026): this module never reads the old spend-without-asking setting. It writes one approval only, the quote the route just
     gave, and only inside a capped token's ceiling (`spends`) on a tool declared to start there. */
  expect(source.match(/maxCredits:/g)).toEqual(["maxCredits:"]);
  expect(source).toContain("if (options.spends === true && tool.startsInsideCeiling && tool.describe) {");
  expect(source).toContain("body: { ...clean, maxCredits: quote.estimatedCredits }");
  expect(source).not.toMatch(/allSettings|spendsWithoutAsking|autoLineCredits|rigJobCeiling/);
  expect(source).not.toMatch(/args\.maxCredits|args\.max_credits|a\.max/);
});
