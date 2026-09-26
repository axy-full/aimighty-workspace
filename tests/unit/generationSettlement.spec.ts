import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-settlement-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

function workspace(name: string, paid = true): TenantWorkspace {
  return {
    id: `ws_${name}`,
    slug: name,
    name,
    legacy: !paid,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: paid,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "u_test",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: 1,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
async function setup(name: string, paid = true) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace(name, paid);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'test',?)",
    args: [`grant_${name}`, ws.id, Date.now()],
  });
  return ws;
}
async function insert(
  id: string,
  options: {
    status?: string;
    age?: number;
    claim?: boolean;
    task?: string;
    cost?: number;
    stored?: string;
  } = {},
) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,ark_task_id,created_at,updated_at,cost_usd,stored_url)
    VALUES(?,'video','byteplus','mock','test',?,?,?, ?,?,?,?)`,
    args: [
      id,
      JSON.stringify(options.claim ? { paidClaim: 10 } : {}),
      options.status ?? "running",
      options.task ?? null,
      Date.now() - (options.age ?? 0),
      Date.now() - (options.age ?? 0),
      options.cost ?? null,
      options.stored ?? null,
    ],
  });
}
const event = (id: string) => ({
  id,
  kind: "video" as const,
  engine: "byteplus",
  model: "mock",
  status: "running" as const,
  engineCostUsd: 1,
});

test("terminal result and bill survive a platform outage, release the slot once, and keep the exact cost", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const {
    writeGenerationOutcome,
    deliverGenerationSettlement,
    flushGenerationSettlements,
  } = await import("../../lib/generationSettlement");
  const ws = await setup("outage");
  await runInTenant(ws, async () => {
    await insert("gen_outage");
    await reserveGenerationSpend(event("gen_outage"));
    await platformDb().execute(
      `CREATE TRIGGER reject_settlement BEFORE UPDATE OF status ON meter_events WHEN NEW.id='gen_outage' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'simulated ledger outage'); END`,
    );
    await writeGenerationOutcome(
      {
        sql: "UPDATE generations SET status='succeeded',cost_usd=.4,stored_url='local-master' WHERE id='gen_outage'",
      },
      { ...event("gen_outage"), status: "succeeded", engineCostUsd: 0.4 },
    );
    await expect(deliverGenerationSettlement("gen_outage")).rejects.toThrow();
    expect(
      (
        await db().execute(
          "SELECT status FROM generations WHERE id='gen_outage'",
        )
      ).rows[0].status,
    ).toBe("succeeded");
    expect(
      (
        await db().execute(
          "SELECT settled_at FROM generation_settlements WHERE id='gen_outage'",
        )
      ).rows[0].settled_at,
    ).toBeNull();
    await platformDb().execute("DROP TRIGGER reject_settlement");
    expect(await flushGenerationSettlements()).toEqual({
      attempted: 1,
      failed: 0,
    });
    expect(await flushGenerationSettlements()).toEqual({
      attempted: 0,
      failed: 0,
    });
    const meter = (
      await platformDb().execute(
        "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id='gen_outage'",
      )
    ).rows[0];
    expect(meter.status).toBe("succeeded");
    expect(Number(meter.engine_cost_usd)).toBe(0.4);
    expect(Number(meter.billed_credits)).toBe(6);
    await reserveGenerationSpend(event("gen_after_outage"));
  });
});

test("a rejected outcome write cannot enqueue a bill, and a late failed receipt cannot replace success", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { writeGenerationOutcome } =
    await import("../../lib/generationSettlement");
  await runInTenant(await setup("atomic"), async () => {
    await insert("gen_atomic");
    await expect(
      writeGenerationOutcome("UPDATE missing_table SET x=1", {
        ...event("gen_atomic"),
        status: "succeeded",
      }),
    ).rejects.toThrow();
    expect(
      (await db().execute("SELECT COUNT(*) AS n FROM generation_settlements"))
        .rows[0].n,
    ).toBe(0);
    await writeGenerationOutcome(
      "UPDATE generations SET status='succeeded' WHERE id='gen_atomic'",
      { ...event("gen_atomic"), status: "succeeded", engineCostUsd: 0.25 },
    );
    await writeGenerationOutcome(
      "UPDATE generations SET status='failed' WHERE id='gen_atomic' AND status!='succeeded'",
      { ...event("gen_atomic"), status: "failed", engineCostUsd: 0 },
    );
    expect(
      JSON.parse(
        String(
          (await db().execute("SELECT event FROM generation_settlements"))
            .rows[0].event,
        ),
      ).status,
    ).toBe("succeeded");
  });
});

test("janitor frees a stranded running slot without refunding or repeating an uncertain paid attempt", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { syncPending } = await import("../../lib/jobs");
  await runInTenant(await setup("stale"), async () => {
    await insert("gen_stale", { age: 20 * 60_000, claim: true });
    await reserveGenerationSpend(event("gen_stale"));
    expect((await syncPending(5)).failed).toBe(0);
    const gen = (
      await db().execute(
        "SELECT status,params,error FROM generations WHERE id='gen_stale'",
      )
    ).rows[0];
    expect(gen.status).toBe("failed");
    expect(JSON.parse(String(gen.params)).paidClaim).toBe(10);
    expect(gen.error).toContain("never confirmed");
    const meter = (
      await platformDb().execute(
        "SELECT status,billed_credits FROM meter_events WHERE id='gen_stale'",
      )
    ).rows[0];
    expect(meter.status).toBe("failed");
    expect(Number(meter.billed_credits)).toBe(15);
    await reserveGenerationSpend(event("gen_after_stale"));
  });
});

test("pre-outbox terminal jobs reconcile conservatively, including archived jobs", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { repairLegacyGenerationSettlements } =
    await import("../../lib/generationSettlement");
  await runInTenant(await setup("legacy"), async () => {
    await insert("gen_legacy");
    await reserveGenerationSpend(event("gen_legacy"));
    await db().execute(
      "UPDATE generations SET status='failed',deleted=1 WHERE id='gen_legacy'",
    );
    expect(await repairLegacyGenerationSettlements()).toEqual({
      attempted: 1,
      failed: 0,
    });
    const meter = (
      await platformDb().execute(
        "SELECT status,billed_credits FROM meter_events WHERE id='gen_legacy'",
      )
    ).rows[0];
    expect(meter.status).toBe("failed");
    expect(Number(meter.billed_credits)).toBe(15);
  });
});

for (const paid of [true, false])
  test(`video reconciliation preserves persisted pricing and ${paid ? "credit privacy" : "BYOK dollars"}`, async () => {
    const { runInTenant } = await import("../../lib/tenant");
    const { engineFor } = await import("../../lib/engines");
    const { platformDb } = await import("../../lib/platform");
    const { reserveGenerationSpend } =
      await import("../../lib/generationRequests");
    const { getGeneration, syncGeneration } = await import("../../lib/jobs");
    const engine = engineFor("byteplus"),
      original = engine.poll;
    let calls = 0;
    engine.poll = async () => {
      calls++;
      return {
        status: "succeeded",
        videoUrl: "https://unused.invalid/video",
        totalTokens: 99999999,
        error: null,
        vendorStartedAt: null,
        vendorEndedAt: null,
        raw: {},
      };
    };
    try {
      await runInTenant(await setup(`snapshot_${paid}`, paid), async () => {
        const id = `gen_snapshot_${paid}`;
        await insert(id, {
          cost: 0.4,
          task: "stored-task",
          stored: "local-master",
        });
        await reserveGenerationSpend(event(id));
        const result = await syncGeneration((await getGeneration(id))!);
        expect(result.costUsd).toBe(paid ? null : 0.4);
        expect(result.creditsBilled).toBe(paid ? 6 : null);
        expect(
          Number(
            (
              await platformDb().execute({
                sql: "SELECT engine_cost_usd FROM meter_events WHERE id=?",
                args: [id],
              })
            ).rows[0].engine_cost_usd,
          ),
        ).toBe(0.4);
        await syncGeneration((await getGeneration(id))!);
        expect(calls).toBe(1);
      });
    } finally {
      engine.poll = original;
    }
  });

test("cron reports failed polls and stops scheduling after its deadline", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { syncPending } = await import("../../lib/jobs");
  const engine = engineFor("byteplus"),
    original = engine.poll;
  let calls = 0;
  engine.poll = async () => {
    calls++;
    throw new Error("simulated poll outage");
  };
  try {
    await runInTenant(await setup("deadline"), async () => {
      await insert("gen_deadline", { task: "known-task" });
      expect(await syncPending(5, { deadlineAt: Date.now() - 1 })).toEqual({
        attempted: 0,
        failed: 0,
        deferred: 1,
      });
      expect(calls).toBe(0);
      expect(await syncPending(5)).toEqual({
        attempted: 1,
        failed: 1,
        deferred: 0,
      });
      expect(calls).toBe(1);
    });
  } finally {
    engine.poll = original;
  }
});

test("a late failed poll cannot overwrite a completed take or its settled bill", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { platformDb } = await import("../../lib/platform");
  const engine = engineFor("byteplus"),
    original = engine.poll;
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  engine.poll = async () => {
    const first = ++calls === 1;
    if (first) {
      entered();
      await wait;
    }
    return {
      status: first ? "failed" : "succeeded",
      videoUrl: first ? null : "https://unused.invalid/master",
      totalTokens: 100,
      error: first ? "late failure" : null,
      vendorStartedAt: null,
      vendorEndedAt: null,
      raw: {},
    };
  };
  try {
    await runInTenant(await setup("late_poll"), async () => {
      await insert("gen_late_poll", {
        cost: 0.4,
        task: "known-task",
        stored: "local-master",
      });
      await reserveGenerationSpend(event("gen_late_poll"));
      const gen = (await getGeneration("gen_late_poll"))!;
      const older = syncGeneration(gen);
      await started;
      expect((await syncGeneration(gen)).status).toBe("succeeded");
      release();
      expect((await older).status).toBe("succeeded");
      expect((await getGeneration(gen.id))?.storedUrl).toBe("local-master");
      expect(
        (
          await platformDb().execute(
            "SELECT status FROM meter_events WHERE id='gen_late_poll'",
          )
        ).rows[0].status,
      ).toBe("succeeded");
    });
  } finally {
    release?.();
    engine.poll = original;
  }
});

test("an aged synchronous job recovers its persisted produced outcome before the janitor, without a provider call", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { syncPending, getGeneration } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("google"),
    original = engine.render;
  let calls = 0;
  engine.render = async () => {
    calls++;
    throw new Error("must never generate again");
  };
  try {
    await runInTenant(await setup("stored_outcome"), async () => {
      await insert("gen_stored_outcome", { age: 3 * 60 * 60_000 });
      const produced = {
        kind: "image",
        storedUrl: "local-master.png",
        bytes: 20,
        cost: 0.4,
        tokens: 100,
        via: "google",
        timings: { queueMs: 1, engineMs: 2, storeMs: 3 },
      };
      await db().execute({
        sql: "UPDATE generations SET kind='image',model='gemini-3.1-flash-image',provider='google',params=? WHERE id='gen_stored_outcome'",
        args: [
          JSON.stringify({
            paidClaim: 10,
            worker: "inngest",
            producedOutcome: produced,
          }),
        ],
      });
      await reserveGenerationSpend({
        ...event("gen_stored_outcome"),
        kind: "image",
        engine: "google",
        model: "gemini-3.1-flash-image",
      });
      expect((await syncPending(5)).failed).toBe(0);
      expect((await getGeneration("gen_stored_outcome"))?.status).toBe(
        "succeeded",
      );
      expect((await getGeneration("gen_stored_outcome"))?.storedUrl).toBe(
        "local-master.png",
      );
      expect(calls).toBe(0);
    });
  } finally {
    engine.render = original;
  }
});

test("a rejected transition cannot rewrite an existing failed settlement or a cancelled job", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { writeGenerationOutcome } =
    await import("../../lib/generationSettlement");
  await runInTenant(await setup("rejected_receipt"), async () => {
    await insert("gen_rejected_receipt");
    await writeGenerationOutcome(
      "UPDATE generations SET status='failed' WHERE id='gen_rejected_receipt'",
      {
        ...event("gen_rejected_receipt"),
        status: "failed",
        engineCostUsd: 0.6,
      },
    );
    expect(
      await writeGenerationOutcome(
        "UPDATE generations SET status='failed' WHERE id='gen_rejected_receipt' AND status='running'",
        {
          ...event("gen_rejected_receipt"),
          status: "failed",
          engineCostUsd: 0,
        },
      ),
    ).toBe(false);
    const saved = JSON.parse(
      String(
        (
          await db().execute(
            "SELECT event FROM generation_settlements WHERE id='gen_rejected_receipt'",
          )
        ).rows[0].event,
      ),
    );
    expect(saved.engineCostUsd).toBe(0.6);
    await insert("gen_already_cancelled", { status: "cancelled" });
    expect(
      await writeGenerationOutcome(
        "UPDATE generations SET status='failed' WHERE id='gen_already_cancelled' AND status='running'",
        {
          ...event("gen_already_cancelled"),
          status: "failed",
          engineCostUsd: 0,
        },
      ),
    ).toBe(false);
    expect(
      (
        await db().execute(
          "SELECT COUNT(*) AS n FROM generation_settlements WHERE id='gen_already_cancelled'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

test("a success whose usage has not arrived keeps its reservation, is billed once usage lands, and notifies once", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("byteplus"), original = engine.poll;
  let tokens: number | null = null;
  engine.poll = async () => ({
    status: "succeeded", videoUrl: "https://unused.invalid/master", totalTokens: tokens,
    error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {},
  });
  const bill = async () => (await platformDb().execute("SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id='gen_usage'")).rows[0];
  const marker = async () => (await db().execute("SELECT json_extract(params,'$.settledBy') AS by, cost_usd FROM generations WHERE id='gen_usage'")).rows[0];
  try {
    await runInTenant(await setup("usage"), async () => {
      await insert("gen_usage", { task: "usage-task", stored: "local-master" });
      await db().execute("UPDATE generations SET model='dreamina-seedance-2-0-260128',params=json_set(params,'$.resolution','720p') WHERE id='gen_usage'");
      await reserveGenerationSpend({ ...event("gen_usage"), model: "dreamina-seedance-2-0-260128" });
      // ModelArk says succeeded before usage.completion_tokens appears.
      expect((await syncGeneration((await getGeneration("gen_usage"))!)).status).toBe("succeeded");
      expect(await bill()).toMatchObject({ status: "succeeded", engine_cost_usd: 1, billed_credits: 15 });
      const first = await marker();
      expect(first.by).toBeTruthy();
      expect(first.cost_usd).toBeNull();
      // The cron's next pass sees the usage and bills the real cost; it is a repair, not a second arrival.
      tokens = 108_900;
      await syncGeneration((await getGeneration("gen_usage"))!);
      const second = await marker();
      expect(second.by).toBe(first.by);
      expect(Number(second.cost_usd)).toBeGreaterThan(0);
      expect(await bill()).toMatchObject({ status: "succeeded", engine_cost_usd: Number(second.cost_usd) });
    });
  } finally {
    engine.poll = original;
  }
});

test("while one poller holds the master's download lease, the others leave the row to it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("byteplus"), original = engine.poll;
  engine.poll = async () => ({
    status: "succeeded", videoUrl: "https://unused.invalid/master", totalTokens: 100,
    error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {},
  });
  try {
    await runInTenant(await setup("lease"), async () => {
      await insert("gen_lease", { task: "lease-task" });
      await reserveGenerationSpend(event("gen_lease"));
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.storeUntil',?) WHERE id='gen_lease'", args: [Date.now() + 60_000] });
      const seen = await syncGeneration((await getGeneration("gen_lease"))!);
      expect(seen.status).toBe("running");
      expect(seen.params.storeUntil).toBeUndefined();
      expect((await db().execute("SELECT status,stored_url FROM generations WHERE id='gen_lease'")).rows[0]).toMatchObject({ status: "running", stored_url: null });
      expect((await platformDb().execute("SELECT status FROM meter_events WHERE id='gen_lease'")).rows[0].status).toBe("running");
    });
  } finally {
    engine.poll = original;
  }
});

test("the janitor refunds a take that was never claimed, and keeps the charge for one that was", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { syncPending } = await import("../../lib/jobs");
  await runInTenant(await setup("unsent"), async () => {
    // A worker or after() that never ran: no paid claim, nothing produced, no handle.
    await insert("gen_unsent", { status: "queued", age: 20 * 60_000 });
    await reserveGenerationSpend(event("gen_unsent"));
    expect((await syncPending(5)).failed).toBe(0);
    const gen = (await db().execute("SELECT status,cost_usd,error FROM generations WHERE id='gen_unsent'")).rows[0];
    expect(gen).toMatchObject({ status: "failed", cost_usd: 0 });
    expect(gen.error).toContain("nothing was charged");
    expect((await platformDb().execute("SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id='gen_unsent'")).rows[0])
      .toMatchObject({ status: "failed", engine_cost_usd: 0, billed_credits: 0 });
  });
});

test("a connected-account still that is never acknowledged, or never collected, stops holding a slot", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { syncPending } = await import("../../lib/jobs");
  const { MARKETING_IMAGE_MODEL_ID } = await import("../../lib/models");
  const still = async (id: string, params: Record<string, unknown>) => {
    await ready();
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,billed_to)
            VALUES(?,'image','higgsfield',?,'test',?,'running',?,?,'higgsfield')`,
      args: [id, MARKETING_IMAGE_MODEL_ID, JSON.stringify({ ratio: "16:9", resolution: "2k", higgsfieldVendorCostUsd: 0.5, higgsfieldCredentialFingerprint: "fp", ...params }), Date.now() - 30 * 3600_000, Date.now() - 30 * 3600_000],
    });
    await reserveGenerationSpend({ ...event(id), kind: "image", engine: "higgsfield", model: MARKETING_IMAGE_MODEL_ID });
  };
  const bill = async (id: string) => (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
  const row = async (id: string) => (await db().execute({ sql: "SELECT status,error,cost_usd FROM generations WHERE id=?", args: [id] })).rows[0];
  await runInTenant(await setup("higgsfield_ceiling"), async () => {
    // The POST timed out three hours ago and no acknowledgement was ever saved.
    await still("gen_hf_unacked", { paidClaim: Date.now() - 3 * 3600_000 });
    await syncPending(10);
    expect(await row("gen_hf_unacked")).toMatchObject({ status: "failed", error: expect.stringContaining("never confirmed") });
    expect(await bill("gen_hf_unacked")).toMatchObject({ status: "failed", engine_cost_usd: 1, billed_credits: 15 });
    // The workspace's one slot is free again. Accepted a day and more ago; every poll since has failed (the account was rotated), the latest just now.
    await still("gen_hf_uncollected", { paidClaim: Date.now() - 25 * 3600_000,
      higgsfieldStillHandle: { provider: "higgsfield", model: MARKETING_IMAGE_MODEL_ID, ref: "req-1", credentialFingerprint: "fp" },
      higgsfieldStillCollection: { since: Date.now() - 25 * 3600_000, last: Date.now() - 10 * 60_000, failures: 150 } });
    await syncPending(10);
    expect(await row("gen_hf_uncollected")).toMatchObject({ status: "failed", cost_usd: 0.5, error: expect.stringContaining("stopped answering") });
    expect(await bill("gen_hf_uncollected")).toMatchObject({ status: "failed", engine_cost_usd: 0.5 });
  });
});

test("a connected-account still is never given up on for time alone: only a day of failed collection that is failing still", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { syncPending } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const { MARKETING_IMAGE_MODEL_ID } = await import("../../lib/models");
  const handle = { provider: "higgsfield", model: MARKETING_IMAGE_MODEL_ID, ref: "req-aged", credentialFingerprint: "fp" };
  const still = async (id: string, params: Record<string, unknown>) => {
    await ready();
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,billed_to)
            VALUES(?,'image','higgsfield',?,'test',?,'running',?,?,'higgsfield')`,
      args: [id, MARKETING_IMAGE_MODEL_ID, JSON.stringify({ ratio: "16:9", resolution: "2k", higgsfieldVendorCostUsd: 0.5, higgsfieldCredentialFingerprint: "fp",
        paidClaim: Date.now() - 30 * 3600_000, higgsfieldStillHandle: handle, ...params }), Date.now() - 30 * 3600_000, Date.now() - 30 * 3600_000],
    });
    await reserveGenerationSpend({ ...event(id), kind: "image", engine: "higgsfield", model: MARKETING_IMAGE_MODEL_ID });
  };
  const state = async (id: string) => {
    const r = (await db().execute({ sql: "SELECT status,error,params FROM generations WHERE id=?", args: [id] })).rows[0];
    return { status: r.status, error: r.error, collection: JSON.parse(String(r.params)).higgsfieldStillCollection };
  };
  const engine = engineFor("higgsfield"), poll = engine.poll, fetchMaster = engine.fetchMaster;
  type Poll = Awaited<ReturnType<NonNullable<typeof poll>>>;
  const answer = (status: Poll["status"], imageUrl: string | null = null) =>
    ({ status, imageUrl, videoUrl: null, totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {} }) as Poll;
  try {
    await runInTenant({ ...(await setup("higgsfield_alive")), concurrency: 4 }, async () => {
      // Thirty hours old, and the vendor is still working on it: it keeps its slot, and an old run of failures is over.
      engine.poll = async () => answer("running");
      await still("gen_hf_working", { higgsfieldStillCollection: { since: Date.now() - 26 * 3600_000, last: Date.now() - 3 * 3600_000, failures: 4 } });
      await syncPending(10);
      expect(await state("gen_hf_working")).toMatchObject({ status: "running", collection: undefined });

      // The image is in hand but cannot be stored: our failure, not the vendor's. It is never given up on.
      engine.poll = async () => answer("succeeded", "https://unit.invalid/still.png");
      engine.fetchMaster = async () => Buffer.from("not an image");
      await syncPending(10);
      expect(await state("gen_hf_working")).toMatchObject({ status: "running", error: expect.any(String), collection: undefined });

      // A day of failures, but none lately (the sweep had not reached it): it is tried again first, not ended on the clock.
      engine.poll = async () => { throw new Error("The connected account is not reachable."); };
      await still("gen_hf_quiet", { higgsfieldStillCollection: { since: Date.now() - 25 * 3600_000, last: Date.now() - 3 * 3600_000, failures: 5 } });
      await syncPending(10);
      const tried = await state("gen_hf_quiet");
      expect(tried).toMatchObject({ status: "running", error: expect.stringContaining("not reachable") });
      // The run it belongs to is kept (since), and counted: one more failure, the latest now.
      expect(tried.collection.since).toBeLessThan(Date.now() - 24 * 3600_000);
      expect(tried.collection.failures).toBe(6);
      expect(tried.collection.last).toBeGreaterThan(Date.now() - 60_000);
      // Failing for a day and failing still: now it ends.
      await syncPending(10);
      expect(await state("gen_hf_quiet")).toMatchObject({ status: "failed", error: expect.stringContaining("stopped answering") });
    });
  } finally {
    engine.poll = poll;
    engine.fetchMaster = fetchMaster;
  }
});

test("a still that fails before its paid step was claimed is never charged, even when its job cannot be loaded", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { failJob } = await import("../../lib/renderWork");
  const { MARKETING_IMAGE_MODEL_ID } = await import("../../lib/models");
  const image = async (id: string, model: string, params: Record<string, unknown>) => {
    await ready();
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,billed_to)
            VALUES(?,'image','google',?,'test',?,'running',?,?,'google')`,
      args: [id, model, JSON.stringify({ ratio: "16:9", resolution: "1K", ...params }), Date.now(), Date.now()],
    });
    await reserveGenerationSpend({ ...event(id), kind: "image", engine: "google", model });
  };
  const bill = async (id: string) => (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
  const row = async (id: string) => (await db().execute({ sql: "SELECT status,cost_usd FROM generations WHERE id=?", args: [id] })).rows[0];
  await runInTenant(await setup("fail_unclaimed"), async () => {
    await image("gen_unclaimed", "gemini-3-pro-image", {});
    await failJob("gen_unclaimed", "The database was briefly unavailable.");
    expect(await row("gen_unclaimed")).toMatchObject({ status: "failed", cost_usd: 0 });
    expect(await bill("gen_unclaimed")).toMatchObject({ status: "failed", engine_cost_usd: 0, billed_credits: 0 });

    await image("gen_claimed", "gemini-3-pro-image", { paidClaim: Date.now() });
    await failJob("gen_claimed", "The connection dropped after the request was sent.");
    expect(await row("gen_claimed")).toMatchObject({ status: "failed" });
    expect(await bill("gen_claimed")).toMatchObject({ status: "failed", engine_cost_usd: 1, billed_credits: 15 });

    // loadJob throws for a Marketing Studio take whose source is gone; the row still ends, by id.
    await image("gen_unloadable", MARKETING_IMAGE_MODEL_ID, { references: [{ uploadId: "missing", role: "reference_image", kind: "image" }] });
    await failJob("gen_unloadable", "A Marketing Studio source is no longer available.");
    expect(await row("gen_unloadable")).toMatchObject({ status: "failed", cost_usd: 0 });
    expect(await bill("gen_unloadable")).toMatchObject({ status: "failed", engine_cost_usd: 0 });
  });
});
