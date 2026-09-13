import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The meter against a throwaway file database: the same id written twice
 * is one row, the balance only counts what the platform paid for, and a
 * completion without a cost keeps the estimate it started with.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-meter-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";

const workspace = (over: Partial<TenantWorkspace>): TenantWorkspace => ({
  id: "ws_unit",
  slug: "unit",
  name: "Unit",
  legacy: false,
  dbUrl: process.env.TURSO_DATABASE_URL!,
  dbToken: null,
  keys: {},
  usesPlatformKeys: true,
  allowanceUsd: null,
  gatewayKeyId: null,
  ownerId: "u_unit",
  createdAt: 0,
  suspendedAt: null,
  suspendedReason: null,
  flaggedAt: null,
  flagNote: null,
  concurrency: null,
  rendersPerHour: null,
  storageQuotaBytes: null,
  deletedAt: null,
  ...over,
});

test.beforeAll(async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute(
    "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('meter_test_funds','ws_unit',250,'manual',0)",
  );
});

test("one id, one row: the completion updates the running event", async () => {
  const { meter, creditsUsed, meterSummary } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const ws = workspace({});
  await runInTenant(ws, () =>
    meter({
      id: "gen_a",
      kind: "video",
      engine: "byteplus",
      model: "dreamina-seedance-2-5-260628",
      status: "running",
      engineCostUsd: 2.864,
      projectId: "p1",
    }),
  );
  await runInTenant(ws, () =>
    meter({
      id: "gen_a",
      kind: "video",
      engine: "byteplus",
      model: "dreamina-seedance-2-5-260628",
      status: "succeeded",
      engineCostUsd: 2.9,
      durationMs: 40_000,
    }),
  );
  const rows = await platformDb().execute({
    sql: "SELECT * FROM meter_events WHERE id = ?",
    args: ["gen_a"],
  });
  expect(rows.rows.length).toBe(1);
  const r = rows.rows[0] as Record<string, unknown>;
  expect(r.status).toBe("succeeded");
  expect(Number(r.engine_cost_usd)).toBeCloseTo(2.9, 6);
  expect(Number(r.billed_credits)).toBe(44);
  expect(r.project_id).toBe("p1");
  expect(Number(r.duration_ms)).toBe(40_000);
  expect(await creditsUsed("ws_unit")).toBe(44);
  const s = await meterSummary("ws_unit");
  expect(s.jobs).toBe(1);
  expect(s.byEngine[0].engine).toBe("byteplus");
});

test("a completion without a cost keeps the estimate's billing", async () => {
  const { meter, creditsUsed } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = workspace({});
  const before = await creditsUsed("ws_unit");
  await runInTenant(ws, () =>
    meter({
      id: "id_train",
      kind: "training",
      engine: "fal",
      model: "trainer",
      status: "running",
      engineCostUsd: 3.6,
    }),
  );
  await runInTenant(ws, () =>
    meter(
      {
        id: "id_train",
        kind: "training",
        engine: "fal",
        model: "trainer",
        status: "succeeded",
      },
      { critical: false },
    ),
  );
  expect((await creditsUsed("ws_unit")) - before).toBe(54);
});

test("a workspace on its own key is metered at zero credits", async () => {
  const { meter, creditsUsed } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = workspace({
    id: "ws_own",
    usesPlatformKeys: false,
    keys: { ark: "own-key" },
  });
  await runInTenant(ws, () =>
    meter({
      id: "gen_own",
      kind: "video",
      engine: "byteplus",
      model: "dreamina-seedance-2-5-260628",
      status: "succeeded",
      engineCostUsd: 2.864,
    }),
  );
  expect(await creditsUsed("ws_own")).toBe(0);
});

test("changing vendor keys while a job runs cannot change who funds its completed bill", async () => {
  const { meter } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const paid = workspace({});
  const own = workspace({ keys: { ark: "own-key" } });
  const event = {
    kind: "video" as const,
    engine: "byteplus",
    model: "dreamina-seedance-2-5-260628",
    engineCostUsd: 1,
  };
  await runInTenant(paid, () =>
    meter({ ...event, id: "key_added", status: "running" }),
  );
  await runInTenant(own, () =>
    meter({
      ...event,
      id: "key_added",
      status: "succeeded",
      engineCostUsd: 1.1,
    }),
  );
  await runInTenant(own, () =>
    meter({ ...event, id: "key_removed", status: "running" }),
  );
  await runInTenant(paid, () =>
    meter({
      ...event,
      id: "key_removed",
      status: "succeeded",
      engineCostUsd: 1.1,
    }),
  );
  const rows = (
    await platformDb().execute(
      "SELECT id,paid_by_platform,billed_credits FROM meter_events WHERE id IN ('key_added','key_removed') ORDER BY id",
    )
  ).rows;
  expect(
    rows.map((r) => [
      r.id,
      Number(r.paid_by_platform),
      Number(r.billed_credits),
    ]),
  ).toEqual([
    ["key_added", 1, 17],
    ["key_removed", 0, 0],
  ]);
});
