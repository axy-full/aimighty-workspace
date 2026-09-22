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

test("an answer the caller refuses is paid to the provider but settles at zero for the workspace", async () =>
  scope("text_refused", async () => {
    const { runPaidText } = await import("../../lib/paidText");
    const { db } = await import("../../lib/db");
    await expect(
      runPaidText(call, {
        model,
        submit: async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "A rewrite without the citation." } }], usage: { cost: 0.01 } }) }),
        accept: (text) => (text.includes("@Image1") ? { ok: true } : { ok: false, reason: "The rewrite dropped @Image1. Your prompt is unchanged; try once more." }),
      }),
    ).rejects.toThrow(/dropped @Image1.*Nothing was charged\./);
    const event = (await metered("text_refused"))[0];
    expect(event.status).toBe("failed");
    expect(Number(event.billed_credits)).toBe(0);
    const job = (await db().execute(`SELECT status,cost_usd,response_json FROM paid_text_jobs`)).rows[0];
    expect(job.status).toBe("refused");
    expect(Number(job.cost_usd)).toBeCloseTo(0.01, 6);
    expect(String(job.response_json)).toContain("without the citation");
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

test("legacy reasoning quotes are read-only and the paid request reserves the quoted reasoning ceiling", async () =>
  scope("text_reasoning_quote", async () => {
    const { quotePaidText, runPaidText } = await import("../../lib/paidText");
    const { db } = await import("../../lib/db");
    const thinking: CatalogModel = {
      ...model, id: "anthropic/claude-sonnet-4.6", owner: "anthropic", maxTokens: 32768,
      tags: ["reasoning"], reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
    };
    const request = { ...call, id: "quoted_reasoning", model: thinking.id, effort: "high" };
    const quote = await quotePaidText(request, thinking);
    expect(quote.model).toBe(thinking.id);
    expect(quote.effort).toBe("high");
    expect(quote.estimateCredits).toBeGreaterThan(0);
    const { paidTextQuoteResponse } = await import("../../lib/paidText");
    expect(await paidTextQuoteResponse(quote).json()).not.toHaveProperty("estimateUsd");
    expect(await metered("text_reasoning_quote")).toEqual([]);
    expect((await db().execute("SELECT name FROM sqlite_master WHERE name='paid_text_jobs'")).rows).toEqual([]);
    let calls = 0;
    await expect(runPaidText({ ...request, maxCredits: quote.estimateCredits - 1 }, { model: thinking, submit: async () => {
      calls++; return { ok: true, status: 200, text: "{}" };
    } })).rejects.toThrow("estimate changed");
    expect(calls).toBe(0);
    expect(await metered("text_reasoning_quote")).toEqual([]);
    const result = await runPaidText({ ...request, maxCredits: quote.estimateCredits }, { model: thinking, submit: async (input) => {
      calls++;
      const body = JSON.parse(input.body);
      expect(body.reasoning_effort).toBe("high");
      expect(body.max_tokens).toBe(900 + 16384);
      expect((await metered("text_reasoning_quote"))[0].status).toBe("running");
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"logline":"A film"}' } }], usage: { cost: 0.01 } }) };
    } });
    expect(result.id).toBe(request.id);
    expect(calls).toBe(1);
    const saved = (await db().execute({ sql: "SELECT effort, request_body FROM paid_text_jobs WHERE id=?", args: [request.id] })).rows[0];
    expect(saved.effort).toBe("high");
    expect(JSON.parse(String(saved.request_body)).reasoning_effort).toBe("high");
    await expect(runPaidText({ ...request, maxCredits: quote.estimateCredits }, { model: thinking })).rejects.toThrow("already has a paid claim");
  }));

test("legacy invalid efforts and incompatible image references fail before a paid claim", async () =>
  scope("text_bad_reasoning", async () => {
    const { runPaidText, quotePaidText } = await import("../../lib/paidText");
    const { requestEffort } = await import("../../lib/atomik");
    const { requestMaxCredits } = await import("../../lib/paidText");
    expect(requestMaxCredits(undefined)).toBeUndefined();
    expect(() => requestMaxCredits(undefined, true)).toThrow("Review a writing quote");
    expect(requestEffort(undefined)).toBeUndefined();
    expect(requestEffort("budget:4096")).toBe("budget:4096");
    expect(() => requestEffort({ effort: "high" })).toThrow("supported reasoning effort");
    let calls = 0;
    await expect(runPaidText({ ...call, effort: "high" }, { model, submit: async () => {
      calls++; return { ok: true, status: 200, text: "{}" };
    } })).rejects.toThrow("effort setting is not available");
    await expect(quotePaidText({ ...call, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aA==" } }] }] }, model)).rejects.toThrow("cannot read image references");
    expect(calls).toBe(0);
    expect(await metered("text_bad_reasoning")).toEqual([]);
  }));


test("an older text request without effort keeps its original output limit and wire fields", async () =>
  scope("text_old_effort", async () => {
    const { runPaidText } = await import("../../lib/paidText");
    const thinking: CatalogModel = { ...model, id: "anthropic/claude-sonnet-4.6", owner: "anthropic", maxTokens: 32768,
      tags: ["reasoning"], reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] };
    const { createChat, getChat } = await import("../../lib/atomik");
    const chatId = await createChat({ userId: "test_user", projectId: null, model: thinking.id, agentMode: "ask" });
    const restored = await getChat(chatId);
    expect(restored?.chat.effort).toBeUndefined();
    await runPaidText({ ...call, model: thinking.id, maxTokens: 4000, effort: restored?.chat.effort }, { model: thinking, submit: async (input) => {
      const body = JSON.parse(input.body);
      expect(body.max_tokens).toBe(4000);
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("providerOptions");
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"say":"Done"}' } }], usage: { cost: 0.01 } }) };
    } });
  }));


test("premium reasoning is available within its explicit quote while old unquoted text retains its budget", async () =>
  scope("text_premium_quote", async () => {
    const { quotePaidText, runPaidText } = await import("../../lib/paidText");
    const premium: CatalogModel = { ...model, id: "openai/gpt-5.5-pro", owner: "openai", maxTokens: 32768,
      pricing: { input: "0.00003", output: "0.0003" }, tags: ["reasoning"], reasoningOptions: [{ type: "effort", values: ["high"] }] };
    const request = { ...call, model: premium.id, effort: "high", maxTokens: 4000 };
    const quote = await quotePaidText(request, premium);
    expect(quote.estimateUsd).toBeGreaterThan(1);
    expect(quote.estimateUsd).toBeLessThan(10);
    await expect(runPaidText(request, { model: premium })).rejects.toThrow("Review a writing quote");
    await expect(quotePaidText({ ...request, effort: undefined }, premium)).rejects.toThrow("request budget");
    expect(await metered("text_premium_quote")).toEqual([]);
  }));


test('legacy direct OpenAI saves cache receipts and price snapshot, retaining unknown usage without replay', async () => {
  const priorMock = process.env.ENGINE_MOCK, priorKey = process.env.OPENAI_API_KEY;
  delete process.env.ENGINE_MOCK; process.env.OPENAI_API_KEY = 'fixture-only-never-sent';
  try { for (const unknown of [false, true]) await scope(`direct_cache_${unknown}`, async () => {
    const { runPaidText } = await import('../../lib/paidText');
    const { db } = await import('../../lib/db');
    const priced: CatalogModel = { ...model, id: 'openai/gpt-6-astra', owner: 'openai', pricing: { input: .0000001, output: .0000003, input_cache_read: .00000001, input_cache_write: .000000125 } };
    let calls = 0;
    const input = { ...call, model: priced.id, id: `direct-cache-${unknown}` };
    const submit = async (request: { body: string }) => {
      calls++; expect(request.body).not.toContain('pricingModel');
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: 'Saved paid answer.' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30, ...(unknown ? {} : { cache_write_tokens: 40 }) }, completion_tokens_details: { reasoning_tokens: 10 } } }) };
    };
    if (unknown) await expect(runPaidText(input, { model: priced, submit })).rejects.toThrow('retained for review');
    else expect((await runPaidText(input, { model: priced, submit })).costUsd).toBeCloseTo(30 * .0000001 + 30 * .00000001 + 40 * .000000125 + 20 * .0000003, 12);
    await expect(runPaidText(input, { model: priced, submit })).rejects.toThrow('already has a paid claim');
    expect(calls).toBe(1);
    const saved = (await db().execute({ sql: 'SELECT * FROM paid_text_jobs WHERE id=?', args: [input.id] })).rows[0];
    expect(saved.status).toBe(unknown ? 'uncertain' : 'succeeded');
    expect(JSON.parse(String(saved.request_body)).pricingModel.pricing).toEqual(priced.pricing);
    expect(String(saved.response_json)).toContain('cached_tokens');
    if (unknown) expect(saved.cost_usd).toBe(saved.estimate_usd);
  }); } finally {
    if (priorMock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = priorMock;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
  }
});
