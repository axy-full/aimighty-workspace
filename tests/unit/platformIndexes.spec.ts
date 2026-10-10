import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "particl-indexes-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

/* Two indexes on the platform database: billing_cycles by workspace (its reads all filter on it) and meter_events by date alone. */
test("billing_cycles(workspace_id) and meter_events(created_at) exist once the platform database is set up, and setting up again changes nothing", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  const columns = async (index: string) => (await platformDb().execute(`PRAGMA index_info(${index})`)).rows.map((r) => String(r.name));
  const table = async (index: string) => String((await platformDb().execute({ sql: `SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?`, args: [index] })).rows[0]?.tbl_name);
  await platformReady();
  await billingReady();
  expect(await table("billing_cycles_ws")).toBe("billing_cycles");
  expect(await columns("billing_cycles_ws")).toEqual(["workspace_id"]);
  expect(await table("meter_events_created")).toBe("meter_events");
  expect(await columns("meter_events_created")).toEqual(["created_at"]);
  /* The older index stays as it was. */
  expect(await columns("meter_events_ws")).toEqual(["workspace_id", "created_at"]);
  /* Idempotent: the same statements run again (a second start, or a database that already has them) fail on nothing and add nothing. */
  const count = async () => Number((await platformDb().execute(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name IN ('billing_cycles','meter_events')`)).rows[0].n);
  const before = await count();
  await platformDb().execute(`CREATE INDEX IF NOT EXISTS billing_cycles_ws ON billing_cycles(workspace_id)`);
  await platformDb().execute(`CREATE INDEX IF NOT EXISTS meter_events_created ON meter_events(created_at)`);
  expect(await count()).toBe(before);
});
