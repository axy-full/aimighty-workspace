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
    expect(gen.error).toContain("unconfirmed");
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
