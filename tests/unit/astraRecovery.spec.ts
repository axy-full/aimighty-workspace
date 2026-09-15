import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { PollResult } from "../../lib/engines/types";

const dir = mkdtempSync(path.join(tmpdir(), "particl-astra-recovery-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
process.env.BLOB_READ_WRITE_TOKEN = "";
const MODEL = "topaz/upscale/video/creative";
const TIMEOUT = "The render never came back from fal.ai. Render again.";

async function workspace(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  const ws: TenantWorkspace = {
    id: `ws_${name}`, slug: name, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 1, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'test',?)", args: [`grant_${name}`, ws.id, Date.now()] });
  return ws;
}
async function seed(id: string, historical = false, age = 2 * 3600_000) {
  const { ready, db } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  await ready();
  const params = {
    falRequestId: `original_${id}`, falModel: MODEL, paidClaim: Date.now() - age,
    producedOutcome: { kind: "video", taskId: `original_${id}`, endpoint: MODEL, queueMs: 10, submitMs: 5 },
    duration: 1.5, ratio: "9:16", resolution: "4k", fps60: false, task: "upscale",
    astra: { creativity: .5, realism: .5, sharpness: .5, fps: 30 },
    astraSource: { width: 720, height: 1280, seconds: 1.5 },
    sourceUploadId: "original_source", maxCredits: 12, quoteFingerprint: "a".repeat(64),
  };
  await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'video','fal',?,'',?,'running',?,?)", args: [id, MODEL, JSON.stringify(params), Date.now() - age, Date.now() - age] });
  const event = { id, kind: "video" as const, engine: "fal", model: MODEL, status: "running" as const, engineCostUsd: .75 };
  await reserveGenerationSpend(event);
  if (historical) {
    await writeGenerationOutcome({ sql: "UPDATE generations SET status='failed',error=? WHERE id=?", args: [TIMEOUT, id] }, { ...event, status: "failed", engineCostUsd: null });
    await deliverGenerationSettlement(id);
  }
  return params;
}
const result = (status: PollResult["status"]): PollResult => ({
  status, videoUrl: status === "succeeded" ? "fixture:astra-clip.mp4" : null,
  totalTokens: null, error: status === "failed" ? "Provider rejected the original request" : null,
  vendorStartedAt: null, vendorEndedAt: null, raw: {},
});
async function read(id: string) {
  const { getGeneration } = await import("../../lib/jobs");
  const { platformDb } = await import("../../lib/platform");
  return {
    job: (await getGeneration(id))!,
    meter: (await platformDb().execute({ sql: "SELECT status,billed_credits,engine_cost_usd,paid_by_platform FROM meter_events WHERE id=?", args: [id] })).rows[0],
    intent: (await platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE id=?", args: [id] })).rows[0].state,
  };
}
async function withPoll(run: (engine: ReturnType<typeof import("../../lib/engines")["engineFor"]>, calls: string[]) => Promise<void>) {
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("fal"), originalPoll = engine.poll, originalRender = engine.render;
  const calls: string[] = [];
  engine.render = async () => { throw Error("Recovery must not submit a provider request"); };
  engine.poll = async handle => { calls.push(handle.ref); return result("running"); };
  try { await run(engine, calls); } finally { engine.poll = originalPoll; engine.render = originalRender; }
}

for (const status of ["queued", "running"] as const) {
  test(`provider ${status} after one hour remains accepted and the same late output settles once`, async () => {
    const { runInTenant } = await import("../../lib/tenant");
    const { syncGeneration } = await import("../../lib/jobs");
    const { flushGenerationSettlements } = await import("../../lib/generationSettlement");
    await withPoll(async (engine, calls) => runInTenant(await workspace(`active_${status}`), async () => {
      const id = `gen_active_${status}`, params = await seed(id, false, 7 * 3600_000);
      engine.poll = async handle => { calls.push(handle.ref); return result(status); };
      await syncGeneration((await read(id)).job);
      const active = await read(id);
      expect(active.job.status).toBe("running");
      expect(active.job.error).toContain("still reports this original request as active");
      expect(active.meter.status).toBe("running");
      expect(Number(active.meter.billed_credits)).toBe(12);
      expect(active.intent).toBe("accepted");
      engine.poll = async handle => { calls.push(handle.ref); return result("succeeded"); };
      await syncGeneration(active.job);
      const delivered = await read(id);
      expect(delivered.job.status).toBe("succeeded");
      expect(delivered.job.storedUrl).toBe(`/api/media/${id}`);
      expect(delivered.job.params.falRequestId).toBe(params.falRequestId);
      expect(delivered.job.params.quoteFingerprint).toBe(params.quoteFingerprint);
      expect(delivered.job.params.maxCredits).toBe(12);
      expect(delivered.meter.status).toBe("succeeded");
      expect(Number(delivered.meter.billed_credits)).toBeGreaterThan(0);
      expect(Number(delivered.meter.billed_credits)).toBeLessThanOrEqual(12);
      expect(delivered.intent).toBe("resolved");
      await syncGeneration(delivered.job);
      expect(await flushGenerationSettlements()).toEqual({ attempted: 0, failed: 0 });
      expect((await read(id)).meter).toEqual(delivered.meter);
      expect(calls).toEqual([params.falRequestId, params.falRequestId]);
    }));
  });
}

test("cron selects only a matching historical timeout and delivers its original result without reopening the meter", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { syncPending, syncGeneration } = await import("../../lib/jobs");
  const { astraTimeoutReceipt } = await import("../../lib/astraRecovery");
  await withPoll(async (engine, calls) => runInTenant(await workspace("historical"), async () => {
    const id = "gen_historical", params = await seed(id, true);
    expect(await astraTimeoutReceipt(id)).not.toBeNull();
    await syncPending(5);
    const waiting = await read(id);
    expect(waiting.job.status).toBe("failed");
    expect(waiting.job.error).toBe(TIMEOUT);
    expect(waiting.meter.status).toBe("failed");
    expect(Number(waiting.meter.billed_credits)).toBe(12);
    expect(waiting.intent).toBe("accepted");
    engine.poll = async handle => { calls.push(handle.ref); return result("succeeded"); };
    await syncPending(5);
    const delivered = await read(id);
    expect(delivered.job.status).toBe("succeeded");
    const { db } = await import("../../lib/db");
    const storedParams = JSON.parse(String((await db().execute({ sql: "SELECT params FROM generations WHERE id=?", args: [id] })).rows[0].params));
    expect(storedParams.paidClaim).toBe(params.paidClaim);
    expect(storedParams.producedOutcome).toEqual(params.producedOutcome);
    expect(delivered.meter.status).toBe("succeeded");
    expect(delivered.intent).toBe("resolved");
    expect((await syncGeneration(waiting.job)).status).toBe("succeeded"); // stale failed snapshot cannot recover it again
    expect(calls).toEqual([params.falRequestId, params.falRequestId]);
    expect((await read(id)).meter).toEqual(delivered.meter);
  }));
});

test("confirmed provider failure stays terminal and resolves its original failed bill", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { syncGeneration } = await import("../../lib/jobs");
  await withPoll(async (engine, calls) => runInTenant(await workspace("confirmed"), async () => {
    const id = "gen_confirmed"; await seed(id);
    engine.poll = async handle => { calls.push(handle.ref); return result("failed"); };
    await syncGeneration((await read(id)).job);
    const failed = await read(id);
    expect(failed.job.status).toBe("failed");
    expect(failed.job.error).toBe("Provider rejected the original request");
    expect(Number(failed.meter.billed_credits)).toBe(0);
    expect(failed.intent).toBe("resolved");
    await syncGeneration(failed.job);
    expect(calls).toHaveLength(1);
  }));
});

for (const mutation of ["reason", "receipt", "handle", "model", "cost", "cancelled", "deleted", "funding", "debit", "resolved"] as const) {
  test(`historical timeout recovery refuses mismatched ${mutation}`, async () => {
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    const { platformDb } = await import("../../lib/platform");
    const { syncGeneration } = await import("../../lib/jobs");
    const { astraTimeoutReceipt } = await import("../../lib/astraRecovery");
    await withPoll(async (_engine, calls) => runInTenant(await workspace(`excluded_${mutation}`), async () => {
      const id = `gen_excluded_${mutation}`; await seed(id, true);
      const statements = {
        reason: "UPDATE generations SET error='Provider failure' WHERE id=?",
        receipt: "UPDATE generation_settlements SET event=json_set(event,'$.engineCostUsd',0) WHERE id=?",
        handle: "UPDATE generations SET params=json_set(params,'$.falRequestId','different-handle') WHERE id=?",
        model: "UPDATE generations SET model='another-model' WHERE id=?",
        cost: "UPDATE generations SET cost_usd=.5 WHERE id=?",
        cancelled: "UPDATE generations SET status='cancelled' WHERE id=?",
        deleted: "UPDATE generations SET deleted=1 WHERE id=?",
        funding: "UPDATE meter_events SET paid_by_platform=0 WHERE id=?",
        debit: "UPDATE billing_debits SET credits=0 WHERE event_id=?",
        resolved: "UPDATE recovery_intents SET state='resolved' WHERE id=?",
      };
      await (["funding", "debit", "resolved"].includes(mutation) ? platformDb() : db()).execute({ sql: statements[mutation], args: [id] });
      expect(await astraTimeoutReceipt(id)).toBeNull();
      const current = (await read(id)).job;
      if (current) await syncGeneration(current);
      expect(calls).toHaveLength(0);
    }));
  });
}

test("parallel collectors preserve one lease and changed funding rejects a stale successful provider response", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { syncGeneration } = await import("../../lib/jobs");
  await withPoll(async (engine, calls) => runInTenant(await workspace("stale_funding"), async () => {
    const id = "gen_stale_funding"; await seed(id, true);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    engine.poll = async handle => { calls.push(handle.ref); entered(); await waiting; return result("succeeded"); };
    const before = (await read(id)).job;
    const first = syncGeneration(before); await started;
    await syncGeneration(before);
    expect(calls).toHaveLength(1);
    await platformDb().execute({ sql: "UPDATE meter_events SET paid_by_platform=0 WHERE id=?", args: [id] });
    release(); await first;
    const after = await read(id);
    expect(after.job.status).toBe("failed");
    expect(after.job.storedUrl).toBeNull();
    expect(Number(after.meter.billed_credits)).toBe(12);
    expect(after.intent).toBe("accepted");
  }));
});


for (const mutation of ["quote", "lease", "outbox"] as const) {
  test(`a changed ${mutation} cannot seal a stale historical collection`, async () => {
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    const { syncGeneration } = await import("../../lib/jobs");
    await withPoll(async (engine, calls) => runInTenant(await workspace(`stale_${mutation}`), async () => {
      const id = `gen_stale_${mutation}`; await seed(id, true);
      engine.poll = async handle => {
        calls.push(handle.ref);
        const statements = {
          quote: "UPDATE generations SET params=json_set(params,'$.maxCredits',1) WHERE id=?",
          lease: "UPDATE generations SET params=json_set(params,'$.astraPollUntil',1) WHERE id=?",
          outbox: "UPDATE generation_settlements SET settled_at=settled_at+1 WHERE id=?",
        };
        await db().execute({ sql: statements[mutation], args: [id] });
        return result("succeeded");
      };
      await syncGeneration((await read(id)).job);
      const after = await read(id);
      expect(after.job.status).toBe("failed");
      expect(after.job.storedUrl).toBeNull();
      expect(Number(after.meter.billed_credits)).toBe(12);
      expect(after.intent).toBe("accepted");
      expect(calls).toHaveLength(1);
    }));
  });
}

test("changed credit terms cannot charge historical delivery above its original reservation", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { syncGeneration } = await import("../../lib/jobs");
  const { astraTimeoutReceipt } = await import("../../lib/astraRecovery");
  const previousCreditUsd = process.env.CREDIT_USD;
  try {
    await withPoll(async (engine, calls) => runInTenant(await workspace("changed_rates"), async () => {
      const id = "gen_changed_rates", params = await seed(id, true);
      process.env.CREDIT_USD = "0.001";
      engine.poll = async handle => { calls.push(handle.ref); return result("succeeded"); };
      await expect(syncGeneration((await read(id)).job, { strict: true })).rejects.toThrow("exceeds its original reservation");
      const after = await read(id);
      expect(after.job.status).toBe("failed");
      expect(after.job.storedUrl).toBeNull();
      expect(Number(after.meter.billed_credits)).toBe(12);
      expect(after.intent).toBe("accepted");
      expect(await astraTimeoutReceipt(id)).not.toBeNull();
      process.env.CREDIT_USD = previousCreditUsd;
      await syncGeneration(after.job);
      expect((await read(id)).job.status).toBe("succeeded");
      expect(calls).toEqual([params.falRequestId, params.falRequestId]);
    }));
  } finally { process.env.CREDIT_USD = previousCreditUsd; }
});

test("a historical poll outage preserves eligibility and confirmed failure settles without resubmission", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { syncGeneration } = await import("../../lib/jobs");
  const { astraTimeoutReceipt } = await import("../../lib/astraRecovery");
  await withPoll(async (engine, calls) => runInTenant(await workspace("historical_outage"), async () => {
    const id = "gen_historical_outage", params = await seed(id, true, 8 * 3600_000);
    engine.poll = async handle => { calls.push(handle.ref); throw Error("Provider poll timed out"); };
    await expect(syncGeneration((await read(id)).job, { strict: true })).rejects.toThrow("Provider poll timed out");
    expect(await astraTimeoutReceipt(id)).not.toBeNull();
    expect((await read(id)).job.error).toBe(TIMEOUT);
    engine.poll = async handle => { calls.push(handle.ref); return result("failed"); };
    await syncGeneration((await read(id)).job);
    const failed = await read(id);
    expect(failed.job.error).toBe("Provider rejected the original request");
    expect(Number(failed.meter.billed_credits)).toBe(0);
    expect(failed.intent).toBe("resolved");
    expect(await astraTimeoutReceipt(id)).toBeNull();
    expect(calls).toEqual([params.falRequestId, params.falRequestId]);
  }));
});

test("historical recovery needs the original reservation, not optional client quote fields", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { syncGeneration } = await import("../../lib/jobs");
  await withPoll(async (engine) => runInTenant(await workspace("without_client_quote"), async () => {
    const id = "gen_without_client_quote"; await seed(id, true);
    await db().execute({ sql: "UPDATE generations SET params=json_remove(params,'$.maxCredits','$.quoteFingerprint') WHERE id=?", args: [id] });
    engine.poll = async () => result("succeeded");
    await syncGeneration((await read(id)).job);
    const after = await read(id);
    expect(after.job.status).toBe("succeeded");
    expect(Number(after.meter.billed_credits)).toBeLessThanOrEqual(12);
  }));
});

test("durable historical settlement refuses a changed ledger and retries its frozen debit exactly once", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { astraTimeoutReceipt, astraRecoveryFunding } = await import("../../lib/astraRecovery");
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  const previousCreditUsd = process.env.CREDIT_USD;
  try {
    await runInTenant(await workspace("outbox_guard"), async () => {
      const id = "gen_outbox_guard"; await seed(id, true);
      const receipt = (await astraTimeoutReceipt(id))!;
      const recoveryFunding = astraRecoveryFunding(receipt, .3);
      await writeGenerationOutcome({ sql: "UPDATE generations SET status='succeeded',cost_usd=.3 WHERE id=?", args: [id] }, {
        id, kind: "video", engine: "fal", model: MODEL, status: "succeeded", engineCostUsd: .3, recoveryFunding,
      });
      await platformDb().execute({ sql: "UPDATE meter_events SET paid_by_platform=0 WHERE id=?", args: [id] });
      await expect(deliverGenerationSettlement(id)).rejects.toThrow("could not record this job");
      expect((await read(id)).meter.status).toBe("failed");
      expect((await db().execute({ sql: "SELECT settled_at FROM generation_settlements WHERE id=?", args: [id] })).rows[0].settled_at).toBeNull();
      await platformDb().execute({ sql: "UPDATE meter_events SET paid_by_platform=1 WHERE id=?", args: [id] });
      process.env.CREDIT_USD = "0.001"; // a deployment rate change cannot reprice the persisted settlement
      await deliverGenerationSettlement(id);
      const delivered = await read(id);
      expect(Number(delivered.meter.billed_credits)).toBe(recoveryFunding.settledCredits);
      expect(delivered.intent).toBe("resolved");
      await db().execute({ sql: "UPDATE generation_settlements SET settled_at=NULL WHERE id=?", args: [id] });
      await deliverGenerationSettlement(id); // simulate a crash after the platform transaction committed
      expect((await read(id)).meter).toEqual(delivered.meter);
    });
  } finally { process.env.CREDIT_USD = previousCreditUsd; }
});
