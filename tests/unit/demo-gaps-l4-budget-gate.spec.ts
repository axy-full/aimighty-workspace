import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/*
 * The workspace's budget per production through the real reservation gate (lib/generationRequests.ts
 * reserveGenerationSpend): a production with no cap of its own is held to it, refused past it in the same words
 * the screens show; an admin's unlock lets it through; a new budget re-locks it. A production with its own cap
 * keeps it. Admission's pre-check (checkCap) reads the same figure.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-l4-budget-gate-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const ws: TenantWorkspace = {
  id: "ws_lfourgate", slug: "lfourgate", name: "Budget gate", legacy: false,
  dbUrl: `file:${path.join(dir, "gate.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};
const SEEDANCE = "dreamina-seedance-2-5-260628";

test("the workspace budget is enforced at the reservation gate, unlockable by an admin, re-locked by a new budget; an own cap wins", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { setSetting } = await import("../../lib/settings");
  const { projectCap, checkCap, resetCapLocks } = await import("../../lib/caps");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { billCredits } = await import("../../lib/creditTerms");
  await platformReady();
  await alignLedgerUnit();
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('grant_lfour',?,5000,'manual',0)`, args: [ws.id] });
  await runInTenant(ws, async () => {
    await ready();
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_credits) VALUES('follows','Follows the budget',0,NULL),('own','Own cap',0,1000)`);
    const usd = 0.5;
    const credits = billCredits(usd, SEEDANCE);
    expect(credits).toBeGreaterThan(1);
    const job = (id: string, projectId: string) => reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: usd, projectId, createdBy: "owner" })
      .then(() => null, (error: unknown) => error);

    /* No budget: nothing caps the production. */
    expect(await job("g_free", "follows")).toBeNull();
    /* A budget of one job, already used by the first: the gate refuses the next, in the words the pre-check and screens use. */
    await setSetting("productionBudgetCredits", String(credits), "owner");
    expect(await projectCap("follows")).toMatchObject({ cap: credits, from: "workspace" });
    const pre = await checkCap("follows", usd, SEEDANCE);
    expect(pre.allow).toBe(false);
    const refused = await job("g_over", "follows");
    expect(refused).toBeInstanceOf(SpendReservationError);
    expect((refused as Error).message).toBe(pre.error);
    expect((refused as Error).message).toContain(`cap of ${credits} cr`);
    /* A production with its own cap is not held to the budget. */
    expect(await job("g_own", "own")).toBeNull();

    /* An admin unlocks it: through. */
    await db().execute("UPDATE projects SET cap_unlocked=1 WHERE id='follows'");
    expect(await job("g_unlocked", "follows")).toBeNull();
    /* A new budget re-locks every production that follows it (the settings route does this on a change): refused again. */
    await resetCapLocks({ budget: true });
    expect((await db().execute("SELECT id,cap_unlocked FROM projects ORDER BY id")).rows.map((r) => [r.id, Number(r.cap_unlocked)])).toEqual([["follows", 0], ["own", 0]]);
    expect(await job("g_relocked", "follows")).toBeInstanceOf(SpendReservationError);
    /* Cleared: no budget, nothing caps it. */
    await setSetting("productionBudgetCredits", "", "owner");
    expect(await job("g_cleared", "follows")).toBeNull();
  });
});
