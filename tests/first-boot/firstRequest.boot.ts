import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The merge deploy of the conversion (owner, 5 October 2026): CREDIT_USD is already 0.10, the record
 * was written by the $0.80 build, and no ledger row exists yet. CASE=window: something was written
 * in the $0.80 days (a desk grant, no job): the very first paid request is paused and nothing is
 * reserved. CASE=none: nothing was written since; the first paid request is admitted at $0.10.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-first-boot-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const DAY = 86_400_000;
const CUTOVER = Date.UTC(2026, 9, 3, 14, 39);

test("the first paid request after the merge deploy", async () => {
  const mode = process.env.CASE;
  expect(["window", "none"]).toContain(mode);
  // The record as the $0.80 build left it: platform tables, no ledger row.
  const { platformDb, platformReady, getWorkspace } = await import("../../lib/platform");
  await platformReady();
  const p = platformDb();
  expect((await p.execute(`SELECT name FROM sqlite_master WHERE name='billing_unit'`)).rows).toHaveLength(0);
  const born = CUTOVER - 10 * DAY;
  await p.execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at) VALUES('ws_boot','ws_boot','ws_boot',?,'owner',1,?,?)`,
    args: [`file:${path.join(dir, "ws_boot.db")}`, born, born],
  });
  await p.execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('boot_welcome','ws_boot',250,'welcome',?)`, args: [born] });
  if (mode === "window")
    await p.execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('boot_desk','ws_boot',100,'manual',?)`, args: [CUTOVER + DAY] });

  // The deploy: CREDIT_USD is 0.10, and the first thing anyone does is a paid job.
  process.env.CREDIT_USD = "0.10";
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { LEDGER_UNIT_PAUSED, ledgerUnitTx, pausedSinceTx } = await import("../../lib/ledgerUnit");
  const ws = (await getWorkspace("ws_boot"))!;
  const first = await runInTenant(ws, () => reserveGenerationSpend({ id: "boot_job", kind: "video", engine: "byteplus", model: "fixture", status: "running", engineCostUsd: 0.4 }))
    .then(() => null, (e: { status?: number; message?: string }) => e);
  const row = (await p.execute(`SELECT billed_credits,credit_usd FROM meter_events WHERE id='boot_job'`)).rows[0];
  if (mode === "window") {
    expect(first?.status).toBe(503);
    expect(first?.message).toBe(LEDGER_UNIT_PAUSED);
    expect(row).toBeUndefined();
    expect(await ledgerUnitTx(p)).toBe(0.8);
    expect(await pausedSinceTx(p)).toBeGreaterThan(0);
    // A direct paid start is refused the same way.
    const { meter } = await import("../../lib/meter");
    const direct = await runInTenant(ws, () => meter({ id: "boot_direct", kind: "image", engine: "fal", model: "fixture", status: "running", engineCostUsd: 0.1 }))
      .then(() => null, (e: Error) => e);
    expect(direct?.message).toBe(LEDGER_UNIT_PAUSED);
  } else {
    expect(first).toBeNull();
    expect(Number(row.credit_usd)).toBe(0.1);
    expect(await ledgerUnitTx(p)).toBe(0.1);
    expect(await pausedSinceTx(p)).toBeNull();
  }
});
