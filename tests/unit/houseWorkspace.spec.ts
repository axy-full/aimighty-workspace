import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";

/* The house workspace (lib/houseWorkspace.ts) beside a member workspace and a
   new one, against real local databases: the house runs on the platform's
   engines unbilled and is never given credits; every other workspace pays in
   credits, whoever is in it. Provider calls never happen here: these are the
   walls and the meter, called directly. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-house-workspace-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

/* Unit specs share one worker and one platform database, so every id here is unique to this run. */
const run = randomUUID().slice(0, 8);
function workspace(id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace {
  return {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_studio_owner", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, ...over,
  };
}
/* The house as the platform record holds it: the studio's original workspace, on the primary database. */
const house = workspace("ws_legacy", { slug: "house", name: "House", legacy: true, dbUrl: `file:${path.join(dir, "house.db")}` });
/* A member workspace: a customer's, which the studio's own owner also belongs to. */
const member = workspace(`ws_member_${run}`);
/* The studio's owner, acting in either. The exemption is the workspace's, never the person's. */
const studioOwner: TenantUser = {
  id: "u_studio_owner", email: "studio-owner@example.test", name: "Studio owner", role: "admin", owner: true,
  disabled: false, lastSeen: null, createdAt: 0,
};
const job = (id: string, engineCostUsd: number) => ({ id, kind: "video" as const, engine: "byteplus", model: "mock", status: "running" as const, engineCostUsd });

async function meterRow(id: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const row = (await platformDb().execute({ sql: "SELECT workspace_id,status,engine_cost_usd,billed_credits,paid_by_platform FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { workspace: String(row.workspace_id), status: String(row.status), cost: Number(row.engine_cost_usd), credits: Number(row.billed_credits ?? 0), paid: Number(row.paid_by_platform) } : null;
}
async function debited(id: string): Promise<number> {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT credits FROM billing_debits WHERE event_id=?", args: [id] })).rows[0];
  return Number(row?.credits ?? 0);
}
async function grantsTo(workspaceId: string): Promise<number> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM credit_grants WHERE workspace_id=?", args: [workspaceId] })).rows[0].n);
}

test("one named rule: the house is the workspace with the house id, not whichever carries the legacy flag", async () => {
  const { HOUSE_WORKSPACE_ID, isHouseWorkspace } = await import("../../lib/houseWorkspace");
  const { creditsApply } = await import("../../lib/credits");
  expect(HOUSE_WORKSPACE_ID).toBe("ws_legacy");
  expect(isHouseWorkspace(house)).toBe(true);
  expect(isHouseWorkspace({ id: HOUSE_WORKSPACE_ID })).toBe(true);
  /* A legacy-flagged workspace under any other id pays in credits like the rest. */
  const flagged = workspace(`ws_flagged_${run}`, { legacy: true });
  for (const ws of [member, flagged, null, undefined]) expect(isHouseWorkspace(ws)).toBe(false);
  expect(creditsApply(house)).toBe(false);
  expect(creditsApply(member)).toBe(true);
  expect(creditsApply(flagged)).toBe(true);
  expect(creditsApply(null)).toBe(false);
});

test("the house workspace runs on the platform's engines unbilled: no credit wall, no allowance, metered at cost", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { creditCheck, creditState, quotedCredits } = await import("../../lib/credits");
  const { allowanceCheck, allowanceUsd } = await import("../../lib/allowance");
  const { paidByPlatform, paidByPlatformEngine } = await import("../../lib/platformSpend");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { meter, assertMeterFunding } = await import("../../lib/meter");
  const { vendorKey } = await import("../../lib/vendorKeys");
  const { billCreditsWith, creditUsd } = await import("../../lib/creditTerms");
  const previous = { allowance: process.env.PLATFORM_ALLOWANCE_USD, ark: process.env.ARK_API_KEY };
  /* A deployment-wide monthly cap, and a figure stored against the house itself: neither applies to it. */
  process.env.PLATFORM_ALLOWANCE_USD = "1";
  process.env.ARK_API_KEY = "deployment-ark-unit-key";
  const before = await grantsTo(house.id);
  try {
    await runInTenant({ ...house, allowanceUsd: 1 }, async () => {
      expect(vendorKey("ark")).toBe("deployment-ark-unit-key");
      expect(paidByPlatform("ark")).toBe(false);
      expect(paidByPlatformEngine("byteplus")).toBe(false);
      expect(paidByPlatformEngine("vercel-sandbox")).toBe(false);
      expect(allowanceUsd()).toBeNull();
      expect(await creditState()).toBeNull();
      expect(await creditCheck("ark", 50, "mock")).toEqual({ ok: true });
      expect(await allowanceCheck("ark", 50, "mock")).toEqual({ ok: true });
      /* Its approval counts the engines' dollars in whole credits at the price of a credit, with no margin. */
      expect(quotedCredits(1.339101, "mock")).toBe(billCreditsWith(1.339101, 1, creditUsd()));
      /* No credits at all, and still the job is admitted and metered: at cost, no credits, not platform-billed. */
      const id = `gen_house_${run}`;
      await reserveGenerationSpend(job(id, 2));
      expect(await meterRow(id)).toEqual({ workspace: house.id, status: "running", cost: 2, credits: 0, paid: 0 });
      await assertMeterFunding(id, "byteplus");
      await meter({ ...job(id, 2.5), status: "succeeded" });
      expect(await meterRow(id)).toEqual({ workspace: house.id, status: "succeeded", cost: 2.5, credits: 0, paid: 0 });
      expect(await debited(id)).toBe(0);
      /* Above the stored allowance as well: the house has none. */
      await reserveGenerationSpend(job(`gen_house_big_${run}`, 40));
      expect(await meterRow(`gen_house_big_${run}`)).toMatchObject({ cost: 40, credits: 0, paid: 0 });
    }, { user: studioOwner });
    expect(await grantsTo(house.id)).toBe(before);
  } finally {
    if (previous.allowance === undefined) delete process.env.PLATFORM_ALLOWANCE_USD; else process.env.PLATFORM_ALLOWANCE_USD = previous.allowance;
    if (previous.ark === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = previous.ark;
  }
});

test("the house workspace is never given credits: grants, packs and an allowance are refused before anything is written", async () => {
  const { HOUSE_NOT_BILLED } = await import("../../lib/houseWorkspace");
  const { grantCredits, grantCreditsBatch, setWorkspaceAllowance, platformDb, platformReady, now } = await import("../../lib/platform");
  const { requestTopup, decideTopupCredits } = await import("../../lib/topups");
  await platformReady();
  const before = { house: await grantsTo(house.id), member: await grantsTo(member.id) };
  await expect(grantCredits(house.id, 100, "Goodwill", "u_desk", "manual")).rejects.toThrow(HOUSE_NOT_BILLED);
  /* A batch naming the house is refused whole: the member's row in it is not written either. */
  await expect(grantCreditsBatch([
    { workspaceId: member.id, credits: 50, note: "Pack", by: "u_desk", kind: "purchase" },
    { workspaceId: house.id, credits: 5, note: "Bonus", by: "u_desk", kind: "bonus" },
  ])).rejects.toThrow(HOUSE_NOT_BILLED);
  await expect(requestTopup({ workspaceId: house.id, packId: "starter", requestedBy: "u_studio_owner" })).rejects.toThrow(HOUSE_NOT_BILLED);
  await expect(setWorkspaceAllowance(house.id, 25)).rejects.toThrow(HOUSE_NOT_BILLED);
  /* A request for the house that reached the desk some other way is never approved into credits; declining still works. */
  const id = `tu_house_${run}`;
  await platformDb().execute({
    sql: `INSERT INTO topup_requests (id, workspace_id, pack_id, label, credits, bonus_credits, usd, status, note, requested_by, created_at)
          VALUES (?,?,?,?,?,?,?,'requested','',?,?)`,
    args: [id, house.id, "starter", "Starter", 500, 0, 50, "u_studio_owner", now()],
  });
  await expect(decideTopupCredits({ id, action: "approve", by: "u_desk" })).rejects.toThrow(HOUSE_NOT_BILLED);
  expect((await decideTopupCredits({ id, action: "decline", by: "u_desk" })).request.status).toBe("declined");
  expect(await grantsTo(house.id)).toBe(before.house);
  expect(await grantsTo(member.id)).toBe(before.member);
});

test("a member workspace pays in credits, even with the studio's owner in it: refused at zero, charged at its terms once funded", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { creditsApply, creditState, creditCheck } = await import("../../lib/credits");
  const { paidByPlatform } = await import("../../lib/platformSpend");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { meter, creditsUsed } = await import("../../lib/meter");
  const { grantCredits } = await import("../../lib/platform");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  await runInTenant(member, async () => {
    expect(creditsApply(member)).toBe(true);
    expect(paidByPlatform("ark")).toBe(true);
    expect(await creditState()).toMatchObject({ balance: 0 });
    expect(await creditCheck("ark", 1, "mock")).toMatchObject({ ok: false, status: 402 });
    const refused = await reserveGenerationSpend(job(`gen_member_zero_${run}`, 1)).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(SpendReservationError);
    expect((refused as InstanceType<typeof SpendReservationError>).status).toBe(402);
  }, { user: studioOwner });
  await grantCredits(member.id, 100, "Unit grant", "u_desk", "manual");
  await runInTenant(member, async () => {
    const id = `gen_member_${run}`;
    await reserveGenerationSpend(job(id, 1));
    await meter({ ...job(id, 1), status: "succeeded" });
    const billed = creditsAtTerms(1, currentBillingTerms("video", "mock"));
    expect(billed).toBeGreaterThan(0);
    expect(await meterRow(id)).toEqual({ workspace: member.id, status: "succeeded", cost: 1, credits: billed, paid: 1 });
    expect(await debited(id)).toBe(billed);
    expect(await creditsUsed(member.id)).toBe(billed);
    expect(await creditState()).toMatchObject({ granted: 100, used: billed, balance: 100 - billed });
  }, { user: studioOwner });
});

test("a new workspace, made through the real provisioning path, pays in credits from its first job", async () => {
  const { createAccount } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const { isHouseWorkspace } = await import("../../lib/houseWorkspace");
  const { runInTenant } = await import("../../lib/tenant");
  const { creditsApply, creditState } = await import("../../lib/credits");
  const { paidByPlatform } = await import("../../lib/platformSpend");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const owner = await createAccount(`house-new-${run}@example.test`, "New studio", hashPassword("Unique-studio-password-43"));
  const made = await resumeWorkspace(await requestWorkspace({ owner, name: `New studio ${run}` }), owner.id);
  expect(made.workspace, made.provisioning?.error ?? "ready").toBeTruthy();
  const ws = made.workspace!;
  expect(isHouseWorkspace(ws)).toBe(false);
  expect(ws.legacy).toBe(false);
  expect(creditsApply(ws)).toBe(true);
  await runInTenant(ws, async () => {
    expect(paidByPlatform("ark")).toBe(true);
    /* A self-serve sign-up starts at zero, so its first paid job waits for credits. */
    expect(await creditState()).toMatchObject({ granted: 0, balance: 0 });
    await expect(reserveGenerationSpend(job(`gen_new_${run}`, 1))).rejects.toMatchObject({ status: 402 });
  });
});
