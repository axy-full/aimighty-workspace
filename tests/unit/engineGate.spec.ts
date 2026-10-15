import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zod from "zod";
import type { TenantWorkspace } from "../../lib/tenant";
import { DEFAULT_SITE, cleanSite, sitePatch } from "../../lib/site/settings";
import { engineEnabled, engineSwitchOn, switchOn, workspaceMayUseEngines } from "../../lib/engineGate";

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

test("the switch value: only 1, on, true or yes (any case) is on", () => {
  expect([undefined, null, "", "0", "off", "false", "no", "2", "enabled", " "].map(switchOn)).toEqual(Array(10).fill(false));
  expect(["1", "on", "ON", "true", "True", " yes "].map(switchOn)).toEqual(Array(6).fill(true));
  expect(engineSwitchOn("remotion", {})).toBe(false);
  expect(engineSwitchOn("remotion", { REMOTION_EXPORTS: "1" })).toBe(true);
});

test("who may use engines: the house workspace and a listed one; a customer workspace and no workspace may not", () => {
  expect(workspaceMayUseEngines({ id: "ws_legacy" })).toBe(true);
  expect(workspaceMayUseEngines({ id: "ws_customer" })).toBe(false);
  expect(workspaceMayUseEngines({ id: "ws_customer" }, ["ws_other"])).toBe(false);
  expect(workspaceMayUseEngines({ id: "ws_customer" }, ["ws_other", "ws_customer"])).toBe(true);
  expect(workspaceMayUseEngines(null, ["ws_customer"])).toBe(false);
  expect(workspaceMayUseEngines(undefined)).toBe(false);
});

test("the whole rule is both halves: the engine's switch AND the house or a listed workspace", () => {
  const on = { REMOTION_EXPORTS: "1" };
  const off = {};
  expect(engineEnabled("remotion", { id: "ws_legacy" }, [], on)).toBe(true);
  expect(engineEnabled("remotion", { id: "ws_customer" }, ["ws_customer"], on)).toBe(true);
  expect(engineEnabled("remotion", { id: "ws_customer" }, [], on)).toBe(false);
  /* The global switch is a kill switch for everyone, the house and listed workspaces included. */
  expect(engineEnabled("remotion", { id: "ws_legacy" }, ["ws_legacy"], off)).toBe(false);
  expect(engineEnabled("remotion", { id: "ws_customer" }, ["ws_customer"], off)).toBe(false);
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
  const { engineEnabledFor } = await import("../../lib/engineGate.server");
  const on = { REMOTION_EXPORTS: "1" };
  await listSite([]);
  expect(await engineEnabledFor("remotion", { id: "ws_legacy" }, on)).toBe(true);
  expect(await engineEnabledFor("remotion", { id: "ws_customer" }, on)).toBe(false);
  await listSite(["ws_customer"]);
  expect(await engineEnabledFor("remotion", { id: "ws_customer" }, on)).toBe(true);
  expect(await engineEnabledFor("remotion", { id: "ws_other" }, on)).toBe(false);
  expect(await engineEnabledFor("remotion", { id: "ws_customer" }, {})).toBe(false);
  expect(await engineEnabledFor("remotion", { id: "ws_legacy" }, {})).toBe(false);
  expect(await engineEnabledFor("remotion", null, on)).toBe(false);
  /* A row that can't be read means off for every customer workspace (the house still follows its own rule). */
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: `UPDATE platform_layer SET value='{not json' WHERE key='site'`, args: [] });
  expect(await engineEnabledFor("remotion", { id: "ws_customer" }, on)).toBe(false);
  expect(await engineEnabledFor("remotion", { id: "ws_legacy" }, on)).toBe(true);
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
  const on = { REMOTION_EXPORTS: "1" };
  await listSite(["ws_cust"]);
  expect(names(await toolsOfferedFor({ id: "ws_legacy" }, on))).toEqual([...names(TOOLS), "export_video", "get_export", "cancel_export"]);
  expect(names(await toolsOfferedFor({ id: "ws_cust" }, on))).toContain("export_video");
  expect(await toolsOfferedFor({ id: "ws_other" }, on)).toBe(TOOLS);
  expect(await toolsOfferedFor({ id: "ws_legacy" }, {})).toBe(TOOLS);
  expect(await toolsOfferedFor(null, on)).toBe(TOOLS);
  const { exportToolAvailabilityFor } = await import("../../lib/exports/tool");
  const full = { ...on, REMOTION_WORKER_URLS: "http://remotion-1:8790", REMOTION_WORKER_SECRETS: "s".repeat(40) };
  expect(await exportToolAvailabilityFor({ id: "ws_other" }, full)).toEqual({ available: false, reason: "Exports are not switched on for this workspace." });
  expect(await exportToolAvailabilityFor({ id: "ws_cust" }, full)).toEqual({ available: true, reason: null });
});
