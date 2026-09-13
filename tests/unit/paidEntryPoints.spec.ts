import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogModel } from "../../lib/catalog";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-paid-entry-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
const model: CatalogModel = {
  id: "test/text",
  name: "Test",
  owner: "test",
  type: "language",
  description: "",
  contextWindow: 100000,
  maxTokens: 5000,
  pricing: { input: "0.000001", output: "0.000002" },
};

function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}`,
    slug: name,
    name,
    legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: true,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "test_user",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
async function scope<T>(
  name: string,
  fn: () => Promise<T>,
  credits = 200,
): Promise<T> {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  const ws = workspace(name);
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,'manual',0)`,
    args: [`grant_${name}`, ws.id, credits],
  });
  return runInTenant(ws, async () => {
    await ready();
    return fn();
  });
}
async function metered(name: string) {
  const { platformDb } = await import("../../lib/platform");
  return (
    await platformDb().execute({
      sql: `SELECT * FROM meter_events WHERE workspace_id=?`,
      args: [`ws_${name}`],
    })
  ).rows;
}
const call = {
  model: model.id,
  messages: [{ role: "user", content: "A film idea" }],
  maxTokens: 600,
  kind: "idea",
};

test("legacy text reserves before its only provider call and charges even when the answer cannot form a usable proposal", async () =>
  scope("text_paid", async () => {
    const { runPaidText } = await import("../../lib/paidText");
    let calls = 0;
    const out = await runPaidText(call, {
      model,
      submit: async () => {
        calls++;
        expect((await metered("text_paid"))[0].status).toBe("running");
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            choices: [
              {
                message: {
                  content: "This is not the requested proposal JSON.",
                },
              },
            ],
            usage: { cost: 0.01 },
          }),
        };
      },
    });
    expect(out.text).toContain("not the requested");
    expect(calls).toBe(1);
    expect((await metered("text_paid"))[0].status).toBe("succeeded");
    expect(Number((await metered("text_paid"))[0].billed_credits)).toBe(1);
  }));

test("unknown text prices and empty balances fail before provider submission", async () =>
  scope(
    "text_empty",
    async () => {
      const { runPaidText } = await import("../../lib/paidText");
      let calls = 0;
      const submit = async () => {
        calls++;
        return { ok: true, status: 200, text: "{}" };
      };
      await expect(
        runPaidText(call, { model: { ...model, pricing: null }, submit }),
      ).rejects.toThrow("confirmed price");
      await expect(runPaidText(call, { model, submit })).rejects.toThrow(
        "available",
      );
      expect(calls).toBe(0);
    },
    0,
  ));

test("ambiguous or unreadable text responses keep their reservation and never retry", async () =>
  scope("text_unknown", async () => {
    const { runPaidText } = await import("../../lib/paidText");
    let calls = 0;
    await expect(
      runPaidText(
        { ...call, id: "text_unknown_transport" },
        {
          model,
          submit: async () => {
            calls++;
            throw new Error("connection reset");
          },
        },
      ),
    ).rejects.toThrow("interrupted");
    await expect(
      runPaidText(
        { ...call, id: "text_unknown_transport" },
        {
          model,
          submit: async () => {
            calls++;
            return { ok: true, status: 200, text: "{}" };
          },
        },
      ),
    ).rejects.toThrow("paid claim");
    await expect(
      runPaidText(call, {
        model,
        submit: async () => {
          calls++;
          return { ok: true, status: 200, text: "not json" };
        },
      }),
    ).rejects.toThrow("unreadable");
    const rows = await metered("text_unknown");
    expect(calls).toBe(2);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.status === "failed" && Number(r.billed_credits) > 0),
    ).toBe(true);
  }));

test("text rejection releases credits while request replay is scoped to endpoint and method", async () =>
  scope("text_reject", async () => {
    const { runPaidText, paidTextFailure } = await import("../../lib/paidText");
    const { withGenerationRequest } =
      await import("../../lib/generationRequests");
    let calls = 0;
    const request = (url: string) =>
      new Request(url, {
        method: "POST",
        headers: { "Idempotency-Key": "same-text-request" },
        body: JSON.stringify({ brief: "A film idea" }),
      });
    const run = async () => {
      try {
        await runPaidText(call, {
          model,
          submit: async () => {
            calls++;
            return { ok: false, status: 422, text: "private provider details" };
          },
        });
        return Response.json({});
      } catch (error) {
        return paidTextFailure(error);
      }
    };
    const first = await withGenerationRequest(
      request("http://localhost/api/atomik/ideas/draft"),
      "test_user",
      run,
    );
    expect(first.status).toBe(502);
    expect(await first.text()).not.toContain("private provider details");
    await withGenerationRequest(
      request("http://localhost/api/atomik/ideas/draft"),
      "test_user",
      run,
    );
    expect(
      (
        await withGenerationRequest(
          request("http://localhost/api/atomik/treatment/scene"),
          "test_user",
          run,
        )
      ).status,
    ).toBe(409);
    expect(calls).toBe(1);
    expect(Number((await metered("text_reject"))[0].billed_credits)).toBe(0);
  }));

async function identity(id: string) {
  const { db, now } = await import("../../lib/db");
  const { MIN_PHOTOS } = await import("../../lib/identities");
  await db().execute({
    sql: `INSERT INTO identities(id,name,photos,status,created_by,created_at,updated_at) VALUES(?,?,?,'draft','test_user',?,?)`,
    args: [
      id,
      "Test face",
      JSON.stringify(
        Array.from({ length: MIN_PHOTOS }, (_, i) => `photo_${i}`),
      ),
      now(),
      now(),
    ],
  });
}

test("concurrent training attempts claim one identity and reserve before submitting", async () =>
  scope("training_race", async () => {
    const { startTraining } = await import("../../lib/identities");
    await identity("identity_race");
    let calls = 0;
    const deps = {
      archive: async () => "https://example.invalid/photos.zip",
      submit: async () => {
        calls++;
        expect(
          Number((await metered("training_race"))[0].billed_credits),
        ).toBeGreaterThan(0);
        return { request_id: "mock-training-accepted" };
      },
    };
    const results = await Promise.allSettled([
      startTraining("identity_race", { by: "test_user" }, deps),
      startTraining("identity_race", { by: "test_user" }, deps),
    ]);
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await metered("training_race")).toHaveLength(1);
  }));

test("uncertain training cannot silently retry or release its credits", async () =>
  scope("training_unknown", async () => {
    const { startTraining } = await import("../../lib/identities");
    await identity("identity_unknown");
    let calls = 0;
    const deps = {
      archive: async () => "https://example.invalid/photos.zip",
      submit: async () => {
        calls++;
        throw new Error("transport interrupted after acceptance");
      },
    };
    await expect(
      startTraining("identity_unknown", { by: "test_user" }, deps),
    ).rejects.toThrow("uncertain");
    await expect(
      startTraining("identity_unknown", { by: "test_user" }, deps),
    ).rejects.toThrow("previous training submission is uncertain");
    expect(calls).toBe(1);
    expect(
      Number((await metered("training_unknown"))[0].billed_credits),
    ).toBeGreaterThan(0);
  }));

test("a rejected training run can be tried explicitly with a new run id and retains both ledger entries", async () =>
  scope("training_reject", async () => {
    const { startTraining } = await import("../../lib/identities");
    const { FalHttpError } = await import("../../lib/fal");
    await identity("identity_reject");
    const archive = async () => "https://example.invalid/photos.zip";
    await expect(
      startTraining(
        "identity_reject",
        { by: "test_user" },
        {
          archive,
          submit: async () => {
            throw new FalHttpError(422, "invalid training input");
          },
        },
      ),
    ).rejects.toThrow("No training credits");
    await startTraining(
      "identity_reject",
      { by: "test_user" },
      { archive, submit: async () => ({ request_id: "mock-second-training" }) },
    );
    const rows = await metered("training_reject");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.filter((r) => Number(r.billed_credits) === 0)).toHaveLength(1);
    expect(rows.filter((r) => Number(r.billed_credits) > 0)).toHaveLength(1);
  }));

test("a stale request scope cannot reserve after workspace deletion", async () =>
  scope("deleted", async () => {
    const { platformDb } = await import("../../lib/platform");
    const { reserveGenerationSpend } =
      await import("../../lib/generationRequests");
    await platformDb().execute(
      `INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at,deleted_at) VALUES('ws_deleted','deleted','Deleted','file:unused','test_user',0,0,1)`,
    );
    await expect(
      reserveGenerationSpend({
        id: "deleted_job",
        kind: "text",
        engine: "vercel",
        model: model.id,
        status: "running",
        engineCostUsd: 0.01,
      }),
    ).rejects.toThrow("deleted");
    expect(await metered("deleted")).toHaveLength(0);
  }));

test("stale account or workspace headers are rejected before a paid claim is created", async () =>
  scope("stale_headers", async () => {
    const { withGenerationRequest } =
      await import("../../lib/generationRequests");
    let calls = 0;
    const staleHeaders: Record<string, string>[] = [
      { "X-Workspace-Id": "another-workspace" },
      { "X-Actor-Email": "another@example.com" },
    ];
    for (const headers of staleHeaders) {
      const req = new Request("http://localhost/api/generate", {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(
        (
          await withGenerationRequest(req, "test_user", async () => {
            calls++;
            return Response.json({ id: "unwanted" });
          })
        ).status,
      ).toBe(409);
    }
    expect(calls).toBe(0);
    expect(await metered("stale_headers")).toHaveLength(0);
  }));

test("monthly cap includes recent turns on old or deleted chats and keeps deleted media spend", async () =>
  scope("old_chat_cap", async () => {
    const { db, now } = await import("../../lib/db");
    const { currentTenant, runInTenant } = await import("../../lib/tenant");
    const { platformSpendSince } = await import("../../lib/platformSpend");
    const { reserveGenerationSpend } =
      await import("../../lib/generationRequests");
    const { cycleBounds } = await import("../../lib/cycle");
    await db().execute(
      "INSERT INTO atomik_chats(id,created_at,updated_at,deleted,text_cost_usd) VALUES('old_chat',0,0,1,12.8)",
    );
    await db().execute({
      sql: "INSERT INTO atomik_messages(id,chat_id,role,cost_usd,created_at) VALUES('recent_turn','old_chat','assistant',0.8,?)",
      args: [now()],
    });
    await db().execute(
      "INSERT INTO atomik_messages(id,chat_id,role,cost_usd,created_at) VALUES('old_turn','old_chat','assistant',12,0)",
    );
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,provider,cost_usd,created_at,updated_at,deleted) VALUES('deleted_media','mock','test','{}','succeeded','vercel',0.1,?,?,1)",
      args: [now(), now()],
    });
    expect(await platformSpendSince(cycleBounds(1, now()).start)).toBeCloseTo(
      0.9,
    );
    await runInTenant(
      { ...currentTenant()!.workspace!, allowanceUsd: 1 },
      async () => {
        await expect(
          reserveGenerationSpend({
            id: "over_chat_cap",
            kind: "text",
            engine: "vercel",
            model: model.id,
            status: "running",
            engineCostUsd: 0.2,
          }),
        ).rejects.toThrow("monthly spending cap");
      },
    );
    expect(await metered("old_chat_cap")).toHaveLength(0);
  }));

test("a training attempt and its meter count once toward the monthly cap, including an older identity", async () =>
  scope("training_cap", async () => {
    const { db } = await import("../../lib/db");
    const { currentTenant, runInTenant } = await import("../../lib/tenant");
    const { startTraining } = await import("../../lib/identities");
    const { reserveGenerationSpend } =
      await import("../../lib/generationRequests");
    await identity("identity_cap");
    await db().execute(
      "UPDATE identities SET created_at=0 WHERE id='identity_cap'",
    );
    await startTraining(
      "identity_cap",
      { by: "test_user" },
      {
        archive: async () => "https://example.invalid/photos.zip",
        submit: async () => ({ request_id: "mock-training-cap" }),
      },
    );
    const trainingCost = Number(
      (await metered("training_cap"))[0].engine_cost_usd,
    );
    await runInTenant(
      { ...currentTenant()!.workspace!, allowanceUsd: trainingCost + 0.4 },
      async () => {
        await reserveGenerationSpend({
          id: "within_training_cap",
          kind: "text",
          engine: "vercel",
          model: model.id,
          status: "running",
          engineCostUsd: 0.3,
        });
        await expect(
          reserveGenerationSpend({
            id: "over_training_cap",
            kind: "text",
            engine: "vercel",
            model: model.id,
            status: "running",
            engineCostUsd: 0.2,
          }),
        ).rejects.toThrow("monthly spending cap");
      },
    );
    expect(await metered("training_cap")).toHaveLength(2);
  }));
