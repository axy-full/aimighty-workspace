import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zod from "zod";
import type { TenantWorkspace } from "../../lib/tenant";
import { DEFAULT_SITE, cleanSite, sitePatch } from "../../lib/site/settings";

/* Owner, 15 Oct 2026, 22:15: "ON for the house workspace (ws_legacy) and any workspace I list in the site setting;
   OFF for customer workspaces until launch." An engine is offered only when its own switch is on AND the workspace is
   the house or listed in `enginesOnWorkspaces`. Exports are the first engine. No engine is called here. */
void zod;
const directory = mkdtempSync(path.join(tmpdir(), "engine-gate-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const saved = process.env.REMOTION_EXPORTS;
test.beforeEach(() => { delete process.env.REMOTION_EXPORTS; });
test.afterAll(() => { if (saved === undefined) delete process.env.REMOTION_EXPORTS; else process.env.REMOTION_EXPORTS = saved; });

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
const listSite = async (ids: string[]) => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: ids })] });
};

test("the engine's own switch is on only for exactly 1, read when asked", async () => {
  const { engineSwitchOn } = await import("../../lib/engineGate");
  for (const value of [undefined, "", "0", "off", "false", "no", "2", "on", "true", "yes", " 1", "1 "]) {
    if (value === undefined) delete process.env.REMOTION_EXPORTS; else process.env.REMOTION_EXPORTS = value;
    expect(engineSwitchOn("REMOTION_EXPORTS"), String(value)).toBe(false);
  }
  process.env.REMOTION_EXPORTS = "1";
  expect(engineSwitchOn("REMOTION_EXPORTS")).toBe(true);
});

test("the site setting enginesOnWorkspaces: empty by default, junk dropped, at most 50 well-formed distinct ids, refused with the reason otherwise", () => {
  expect(DEFAULT_SITE.enginesOnWorkspaces).toEqual([]);
  expect(cleanSite({ enginesOnWorkspaces: "ws_a" }).enginesOnWorkspaces).toEqual([]);
  expect(cleanSite({ enginesOnWorkspaces: ["ws_a", "ws_a", 3, "bad id; drop", "ws_b"] }).enginesOnWorkspaces).toEqual(["ws_a", "ws_b"]);
  expect(cleanSite({ enginesOnWorkspaces: Array.from({ length: 80 }, (_, i) => `ws_${i}`) }).enginesOnWorkspaces).toHaveLength(50);
  expect(sitePatch({ enginesOnWorkspaces: ["ws_a", "ws_a"] })).toEqual({ patch: { enginesOnWorkspaces: ["ws_a"] } });
  expect(sitePatch({ enginesOnWorkspaces: [] })).toEqual({ patch: { enginesOnWorkspaces: [] } });
  expect(sitePatch({ enginesOnWorkspaces: "ws_a" })).toHaveProperty("error");
  expect(sitePatch({ enginesOnWorkspaces: ["bad id; drop"] })).toHaveProperty("error");
  expect(sitePatch({ enginesOnWorkspaces: Array.from({ length: 51 }, (_, i) => `ws_${i}`) })).toHaveProperty("error");
  /* A separate list: listing a workspace for engines does not give it the new interface, and the other way round. */
  expect(cleanSite({ newInterfaceWorkspaces: ["ws_a"] }).enginesOnWorkspaces).toEqual([]);
  expect(cleanSite({ enginesOnWorkspaces: ["ws_a"] }).newInterfaceWorkspaces).toEqual([]);
});

test("read from the platform database: off for a customer, on for the house and a listed workspace, off for all when the switch is off", async () => {
  const { engineEnabled } = await import("../../lib/engineGate");
  process.env.REMOTION_EXPORTS = "1";
  await listSite([]);
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_legacy" })).toBe(true);
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_customer" })).toBe(false);
  await listSite(["ws_customer"]);
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_customer" })).toBe(true);
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_other" })).toBe(false);
  expect(await engineEnabled("REMOTION_EXPORTS", null)).toBe(false);
  /* The global switch is a kill switch for everyone, the house and listed workspaces included. */
  delete process.env.REMOTION_EXPORTS;
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_customer" })).toBe(false);
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_legacy" })).toBe(false);
  /* A row that can't be read means off for every customer workspace (the house still follows its own rule). */
  process.env.REMOTION_EXPORTS = "1";
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: `UPDATE platform_layer SET value='{not json' WHERE key='site'`, args: [] });
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_customer" })).toBe(false);
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_legacy" })).toBe(true);
  /* A row from before the list existed reads as an empty list. */
  await platformDb().execute({ sql: `UPDATE platform_layer SET value='{"openSignup":false}' WHERE key='site'`, args: [] });
  expect(await engineEnabled("REMOTION_EXPORTS", { id: "ws_customer" })).toBe(false);
});

test("exports follow it: the job functions refuse an unlisted customer workspace with a 404 and make no table; the house and a listed workspace pass the gate", async () => {
  process.env.REMOTION_EXPORTS = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const jobs = await import("../../lib/exports/jobs");
  await listSite([]);
  await runInTenant(workspace("cust"), async () => {
    await ready();
    await expect(jobs.listExports("u_test")).rejects.toMatchObject({ status: 404 });
    await expect(jobs.createExport({ requestId: "request-gate-0001", composition: "title-card", props: { aspect: "16:9", card: { title: "Hello" } } }, { id: "u_test" })).rejects.toMatchObject({ status: 404 });
    expect(await jobs.runExport("export_" + "a".repeat(32))).toBeUndefined();
    expect(await jobs.pendingExports()).toEqual([]);
    expect((await db().execute("SELECT name FROM sqlite_master WHERE name='export_jobs'")).rows).toEqual([]);
  });
  /* The house workspace passes with nobody listed. */
  await runInTenant(workspace("legacy"), async () => {
    await ready();
    expect(await jobs.listExports("u_test")).toEqual([]);
  });
  /* A listed workspace passes. */
  await listSite(["ws_cust"]);
  await runInTenant(workspace("cust"), async () => {
    await ready();
    expect(await jobs.listExports("u_test")).toEqual([]);
  });
  /* The global switch off ends it for everyone, the house included. */
  delete process.env.REMOTION_EXPORTS;
  await runInTenant(workspace("legacy"), async () => {
    await expect(jobs.listExports("u_test")).rejects.toMatchObject({ status: 404 });
  });
});

test("the MCP tools follow it: the export tools are listed to the house and to a listed workspace, and to no one while the switch is off", async () => {
  const { TOOLS, toolsOfferedFor } = await import("../../lib/mcp");
  const names = (list: { name: string }[]) => list.map((tool) => tool.name);
  process.env.REMOTION_EXPORTS = "1";
  await listSite(["ws_cust"]);
  expect(names(await toolsOfferedFor({ id: "ws_legacy" }))).toEqual([...names(TOOLS), "export_video", "assemble_film", "export_film", "get_export", "cancel_export"]);
  expect(names(await toolsOfferedFor({ id: "ws_cust" }))).toContain("export_video");
  expect(await toolsOfferedFor({ id: "ws_other" })).toBe(TOOLS);
  expect(await toolsOfferedFor(null)).toBe(TOOLS);
  /* A call for a workspace that is not allowed is "Unknown tool", whatever the global switch says: the route says whether exports are on for it. */
  const { runTool } = await import("../../lib/mcp");
  const calls: string[] = [];
  const call = (async (pathname: string) => { calls.push(pathname); return { job: { id: "export_" + "b".repeat(32), status: "queued", queueLine: null, error: null, outputs: [] } }; }) as never;
  for (const tool of ["export_video", "assemble_film", "export_film", "get_export", "cancel_export"]) {
    await expect(runTool(tool, { composition: "title-card", props: {} as never, id: "x" }, call, "https://app.test", { exports: false })).rejects.toThrow("Unknown tool");
  }
  expect(calls).toEqual([]);
  await runTool("export_video", { composition: "title-card", props: {} as never }, call, "https://app.test", { exports: true });
  expect(calls).toEqual(["/api/exports"]);
  delete process.env.REMOTION_EXPORTS;
  expect(await toolsOfferedFor({ id: "ws_legacy" })).toBe(TOOLS);
});

test("recovery follows the GLOBAL switch only: a workspace taken off the list still has its stuck run ended and its worker session stopped, and a queued job says why it will not start", async () => {
  process.env.REMOTION_EXPORTS = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const jobs = await import("../../lib/exports/jobs");
  const { exportWorkerPool } = await import("./remotionWorkerFake");
  const resolver = { async video(handle: { take?: string; upload?: string }) { return { origin: "take" as const, id: handle.take ?? "x", ext: "mp4", storedUrl: "stored/x", bytes: 1000, durationSeconds: 10, width: 1920, height: 1080 }; }, async image() { throw new Error("no"); }, async audio() { throw new Error("no"); } };
  const pool = exportWorkerPool();
  const limits = { maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 20, runTimeoutMs: 200_000, queueExpiryMs: 30 * 60_000 };
  const base = { limits: () => limits, resolver: () => resolver, reach: async () => true, worker: { config: pool.config, fetch: pool.fetch } };
  const request = (id: string) => ({ requestId: id, composition: "captions" as const, props: { aspect: "9:16", scale: 0.25, captionStyle: "bold", clip: { source: { take: "t1", hasAudio: true }, cues: [{ startMs: 500, endMs: 2500, text: "hi" }] } } });
  await listSite(["ws_recover"]);
  await runInTenant(workspace("recover"), async () => {
    await ready();
    /* While listed: one job that is rendering and stuck, one that is queued. */
    const stuck = await jobs.createExport(request("request-recover-01"), { id: "u_test" }, base);
    const waiting = await jobs.createExport(request("request-recover-02"), { id: "u_test" }, base);
    const name = "remotion-export-" + "0123456789abcdef0123456789abcdef".replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    await db().execute({ sql: "UPDATE export_jobs SET status='rendering', runtime_id=?, claimed_at=? WHERE id=?", args: [name, 1_000, stuck.job.id] });
    await listSite([]);
    const before = pool.calls.length;
    const outcome = await jobs.recoverExports({ deadlineAt: Date.now() + 100_000 }, { ...base, clock: () => 10 * 60 * 60_000, enqueue: async () => true });
    expect(outcome.attempted).toBe(2);
    expect((await db().execute({ sql: "SELECT status, error FROM export_jobs WHERE id=?", args: [stuck.job.id] })).rows[0]).toMatchObject({ status: "failed", error: expect.stringContaining("did not finish") });
    expect(pool.calls.slice(before).some((c) => c.method === "DELETE" && c.path.endsWith(name))).toBe(true);
    expect((await db().execute({ sql: "SELECT status, error FROM export_jobs WHERE id=?", args: [waiting.job.id] })).rows[0]).toMatchObject({ status: "failed", error: expect.stringContaining("not switched on for this workspace any more") });
    /* New work is still refused for it. */
    await expect(jobs.createExport(request("request-recover-03"), { id: "u_test" }, { ...base })).rejects.toBeTruthy();
  });
  /* The global switch off ends recovery for everyone. */
  delete process.env.REMOTION_EXPORTS;
  await runInTenant(workspace("recover"), async () => {
    expect(await jobs.pendingExports()).toEqual([]);
  });
});

test.afterEach(() => { delete process.env.EXAMPLE_ENGINE_ENABLED; });

test("the engine gate: the engine's own switch AND (the house OR a listed workspace); the switch is the kill switch; fail closed", async () => {
  const { engineEnabled, enginesOnWorkspaces } = await import("../../lib/engineGate");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const customer = { id: "ws_gate_customer" };
  const setList = (value: unknown) => platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [typeof value === "string" ? value : JSON.stringify(value)],
  });
  const before = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await setList({ openSignup: false, enginesOnWorkspaces: [] });
    /* Switch unset or anything but "1": off for everyone, the house included. */
    for (const v of [undefined, "", "0", "true", "yes", "on"]) {
      if (v === undefined) delete process.env.EXAMPLE_ENGINE_ENABLED; else process.env.EXAMPLE_ENGINE_ENABLED = v;
      expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_legacy" }), String(v)).toBe(false);
    }
    process.env.EXAMPLE_ENGINE_ENABLED = "1";
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_legacy" })).toBe(true);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(false);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", null)).toBe(false);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", undefined)).toBe(false);
    /* Listed: on for that workspace and no other; and the list alone, with the switch off, is nothing. */
    await setList({ enginesOnWorkspaces: [customer.id, "bad id; drop", 7] });
    expect(await enginesOnWorkspaces()).toEqual([customer.id]);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(true);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_gate_other" })).toBe(false);
    delete process.env.EXAMPLE_ENGINE_ENABLED;
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(false);
    /* An unreadable row is nobody. */
    process.env.EXAMPLE_ENGINE_ENABLED = "1";
    await setList("{not json");
    expect(await enginesOnWorkspaces()).toEqual([]);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(false);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_legacy" })).toBe(true);
  } finally {
    if (typeof before === "string") await setList(before); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});
