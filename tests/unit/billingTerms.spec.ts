import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

const directory = mkdtempSync(path.join(tmpdir(), "particl-billing-terms-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "legacy.db")}`;
process.env.KEYRING_SECRET = "mock-billing-terms-keyring-secret-for-tests";
const previousRate = process.env.CREDIT_USD;

const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null,
  legacy: false, usesPlatformKeys: true, keys: {}, ownerId: "tester", createdAt: 0,
  allowanceUsd: null, gatewayKeyId: null, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
});

test.beforeEach(async () => { process.env.CREDIT_USD = "0.20"; await alignLedgerUnit(); });
test.afterAll(async () => { if (previousRate === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = previousRate; await alignLedgerUnit(); });
test.beforeAll(async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  for (const id of ["studio_a", "studio_b"]) await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,1000,'manual',0)",
    args: [`grant-${id}`, id],
  });
});

test("a reservation settles on its admitted terms after configuration changes", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { meter } = await import("../../lib/meter");
  const { platformDb } = await import("../../lib/platform");
  const event = { id: "reserved", kind: "video" as const, engine: "byteplus", model: "fixture-engine", status: "running" as const, engineCostUsd: 0.4 };
  await runInTenant(workspace("studio_a"), () => reserveGenerationSpend(event));
  /* The price moves; the record does not (no conversion ran): the job settles in its own terms. */
  process.env.CREDIT_USD = "0.40";
  await runInTenant(workspace("studio_a"), () => reserveGenerationSpend(event));
  await runInTenant(workspace("studio_a"), () => meter({ ...event, status: "succeeded", engineCostUsd: 0.8 }));
  const row = (await platformDb().execute("SELECT * FROM meter_events WHERE id='reserved'")).rows[0];
  expect(Number(row.credit_usd)).toBe(0.2);
  expect(Number(row.credit_margin)).toBe((await import("../../lib/creditTerms")).marginFor("fixture-engine"));
  expect(Number(row.billed_credits)).toBe(6);
  const debit = (await platformDb().execute("SELECT credits FROM billing_debits WHERE event_id='reserved'")).rows[0];
  expect(Number(debit.credits)).toBe(6);
  await alignLedgerUnit(); // a job first metered after the record follows the price is charged in it
  await runInTenant(workspace("studio_b"), () => meter({ ...event, id: "new-terms", status: "succeeded" }));
  const fresh = (await platformDb().execute("SELECT billed_credits,credit_usd FROM meter_events WHERE id='new-terms'")).rows[0];
  expect(Number(fresh.credit_usd)).toBe(0.4);
  expect(Number(fresh.billed_credits)).toBe(2);
});

test("direct meter starts also freeze terms, and duplicate completions preserve their receipt", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { meter } = await import("../../lib/meter");
  const { platformDb } = await import("../../lib/platform");
  const event = { id: "direct", kind: "text" as const, engine: "openai", model: "fixture-model", engineCostUsd: 0.4 };
  await runInTenant(workspace("studio_a"), () => meter({ ...event, status: "running" }));
  process.env.CREDIT_USD = "0.05";
  await runInTenant(workspace("studio_a"), () => meter({ ...event, status: "succeeded" }));
  await runInTenant(workspace("studio_a"), () => meter({ ...event, status: "succeeded" }));
  const row = (await platformDb().execute("SELECT billed_credits FROM meter_events WHERE id='direct'")).rows[0];
  expect(Number(row.billed_credits)).toBe(3);
});

test("pre-snapshot completed receipts stay unchanged when reconciled", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { meter } = await import("../../lib/meter");
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute("INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('historical','studio_a','video','byteplus','fixture-model','succeeded',1,7,1,0,0)");
  await runInTenant(workspace("studio_a"), () => meter({ id: "historical", kind: "video", engine: "byteplus", model: "fixture-model", status: "succeeded", engineCostUsd: 1 }));
  expect(Number((await platformDb().execute("SELECT billed_credits FROM meter_events WHERE id='historical'")).rows[0].billed_credits)).toBe(7);
});

test("a reservation cannot be reassigned to another organisation or funding source", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const event = { id: "scope", kind: "video" as const, engine: "byteplus", model: "fixture-model", status: "running" as const, engineCostUsd: 1 };
  await runInTenant(workspace("studio_a"), () => reserveGenerationSpend(event));
  await expect(runInTenant(workspace("studio_b"), () => reserveGenerationSpend(event))).rejects.toThrow("another workspace");
  await expect(runInTenant(workspace("studio_a"), () => reserveGenerationSpend({ ...event, engine: "fal" }))).rejects.toThrow("funding or engine changed");
});
