import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The house workspace's take, from reservation to settlement, on the real ledger: the dollars the hold shows are the dollars the meter
 * reserved, and the dollars it settles at are what the meter and the take record. Nothing here is the estimate read twice: the settled
 * figure is read back from `meter_events` and `generations` after `deliverGenerationSettlement`.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-house-at-cost-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });

const house = (): TenantWorkspace => ({
  id: "ws_legacy", slug: "house", name: "House", legacy: true, dbUrl: `file:${path.join(dir, "house.db")}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  /* Room for other spec files' jobs in the same worker: they share this platform database and the house's id. */ concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
} as TenantWorkspace);

test("house: the hold is the engine's dollars with no credits, and the settled charge is what the meter and the take record", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  const { estimateImageCostUsd } = await import("../../lib/vendorPricing");
  await platformReady();
  const model = "gemini-3.1-flash-image";
  const estimate = estimateImageCostUsd(model, "512", 0)!.net;
  await runInTenant(house(), async () => {
    await ready();
    await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES('gen_house_at_cost','image','google',?,'a still','{}','running',?,?)`, args: [model, Date.now(), Date.now()] });
    const event = { id: "gen_house_at_cost", kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: estimate };
    await reserveGenerationSpend(event);
    /* The hold: what the meter reserved, in dollars; the house is billed no credits. */
    const held = (await platformDb().execute("SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id='gen_house_at_cost'")).rows[0];
    expect(held.status).toBe("running");
    expect(Number(held.engine_cost_usd)).toBe(estimate);
    expect(Number(held.billed_credits ?? 0)).toBe(0);
    /* Settles at what the engine charged (here a little under its estimate, as a real take can). */
    const charged = Math.round(estimate * 0.9 * 1e6) / 1e6;
    await writeGenerationOutcome({ sql: "UPDATE generations SET status='succeeded',cost_usd=?,stored_url='local-master' WHERE id='gen_house_at_cost'", args: [charged] }, { ...event, status: "succeeded", engineCostUsd: charged });
    await deliverGenerationSettlement("gen_house_at_cost");
    const settledMeter = (await platformDb().execute("SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id='gen_house_at_cost'")).rows[0];
    const settledTake = (await db().execute("SELECT cost_usd FROM generations WHERE id='gen_house_at_cost'")).rows[0];
    expect(settledMeter.status).toBe("succeeded");
    expect(Number(settledMeter.engine_cost_usd)).toBe(charged);
    expect(Number(settledMeter.billed_credits ?? 0)).toBe(0);
    expect(Number(settledTake.cost_usd)).toBe(charged);
    /* The settled figure is the recorded one, not the estimate. */
    expect(Number(held.engine_cost_usd)).not.toBe(Number(settledMeter.engine_cost_usd));
  });
});

/* Moved here when the prototype-12 build was deleted (23 Oct 2026; docs/old-shells.md): the hold's and the settled charge's words were that
   build's render card (lib/v12/renderState.ts), which went with it. */
test.fixme("house: the hold and the settled charge are said in the same words, the hold as \"$… held · charged only when it's ready\" — no home: the prototype-12 render card is deleted (23 Oct 2026); owner question: does v31.16's take card carry it?", () => {});
