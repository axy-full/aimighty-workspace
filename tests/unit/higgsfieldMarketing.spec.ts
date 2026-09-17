import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StillRenderRequest } from "../../lib/engines/types";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-marketing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-marketing-secret-unit-test-keyring";
const presetId = "067e9e94-0bea-4acd-b82a-071a264d8e26";
const requestId = "117e9e94-0bea-4acd-b82a-071a264d8e26";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = "marketing-test:secret-test";
  process.env.HF_SOUL_CHARACTER_ENABLED = "0";
  globalThis.fetch = async () => {
    throw new Error("Unexpected external request");
  };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}`,
    slug: name,
    name,
    legacy: true,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "owner",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: 8,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
async function request(): Promise<StillRenderRequest> {
  const { getModel, MARKETING_IMAGE_MODEL_ID } =
    await import("../../lib/models");
  const { higgsfieldCredentialFingerprint } =
    await import("../../lib/higgsfield");
  return {
    kind: "image",
    genId: "gen_marketing",
    model: getModel(MARKETING_IMAGE_MODEL_ID),
    prompt: "A product on a studio plinth",
    ratio: "3:4",
    size: "2k",
    references: [],
    marketing: { quality: "high", enhancePrompt: false },
    higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(),
    higgsfieldVendorCostUsd: 0.3,
  };
}

test("Marketing input enforces vendor constraints, moderation and explicit preset enhancement", async () => {
  const { marketingInput, marketingSettings } =
    await import("../../lib/higgsfieldMarketing");
  const settings = marketingSettings(undefined);
  const body = marketingInput("A product", "auto", "2k", settings, []);
  expect(body).toEqual({
    prompt: "A product",
    image_urls: [],
    quality: "high",
    moderation: "auto",
    resolution: "2k",
    aspect_ratio: "auto",
    enhance_prompt: false,
  });
  for (const invalid of [
    { quality: "bad" },
    { moderation: "low" },
    { presetId },
    { enhancePrompt: true },
    { enhancePrompt: true, presetId, quality: "low" },
  ])
    expect(() => marketingSettings(invalid)).toThrow();
  const preset = marketingSettings({ enhancePrompt: true, presetId });
  expect(() => marketingInput("A product", "3:4", "2k", preset, [])).toThrow(
    /1–2/,
  );
  expect(() =>
    marketingInput(
      "A product",
      "3:4",
      "2k",
      preset,
      Array(3).fill("https://image.example/a"),
    ),
  ).toThrow();
  expect(
    marketingInput("A product", "3:4", "4k", preset, [
      "https://image.example/a",
    ]),
  ).toMatchObject({ preset_id: presetId, enhance_prompt: true });
  for (const [prompt, ratio, size, refs] of [
    ["a".repeat(5001), "3:4", "2k", []],
    ["ok", "4:5", "2k", []],
    ["ok", "3:4", "2K", []],
    ["ok", "3:4", "2k", Array(17).fill("https://image.example/a")],
    ["ok", "3:4", "2k", ["http://localhost/private"]],
  ] as [string, string, string, string[]][])
    expect(() => marketingInput(prompt, ratio, size, settings, refs)).toThrow();
});

test("live catalog is bounded, cursor encoded, safe metadata only, credential and tenant scoped", async () => {
  const { listMarketingPresets, requireMarketingPreset, marketingSettings } =
    await import("../../lib/higgsfieldMarketing");
  const { runInTenant } = await import("../../lib/tenant");
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    expect(String(url)).toBe(
      "https://api.higgsfield.ai/marketing-studio/image/presets?size=50&cursor=next%26other%3Dvalue",
    );
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Key marketing-test:secret-test" },
    });
    return Response.json({
      total: 1,
      cursor: null,
      items: [
        {
          id: presetId,
          type: "ads",
          name: "Product studio",
          secret: "PRIVATE",
          image_url: "PRIVATE",
        },
      ],
      secret: "PRIVATE",
    });
  };
  const selected = marketingSettings({ enhancePrompt: true, presetId });
  await runInTenant(
    { ...workspace("catalog_a"), usesPlatformKeys: true },
    async () => {
      expect(await listMarketingPresets("next&other=value")).toEqual({
        total: 1,
        cursor: null,
        items: [{ id: presetId, type: "ads", name: "Product studio" }],
      });
      await requireMarketingPreset(selected);
      process.env.HF_CREDENTIALS = "changed:credential";
      await expect(requireMarketingPreset(selected)).rejects.toThrow(
        /Refresh presets/,
      );
      process.env.HF_CREDENTIALS = "marketing-test:secret-test";
    },
  );
  await runInTenant(
    { ...workspace("catalog_b"), usesPlatformKeys: true },
    async () => {
      await expect(requireMarketingPreset(selected)).rejects.toThrow(
        /Refresh presets/,
      );
    },
  );
  expect(calls).toBe(1);
});

test("the model-specific preset catalog accepts bounded category metadata without inventing an enum", async () => {
  const { listMarketingPresets, requireMarketingPreset, marketingSettings } =
    await import("../../lib/higgsfieldMarketing");
  const { runInTenant } = await import("../../lib/tenant");
  globalThis.fetch = async () =>
    Response.json({
      total: 1,
      cursor: null,
      items: [
        {
          id: presetId,
          type: "fixture-category",
          name: "Fixture preset",
          private_data: "PRIVATE",
        },
      ],
    });
  await runInTenant(
    { ...workspace("catalog_category"), usesPlatformKeys: true },
    async () => {
      expect(await listMarketingPresets()).toEqual({
        total: 1,
        cursor: null,
        items: [
          { id: presetId, type: "fixture-category", name: "Fixture preset" },
        ],
      });
      await requireMarketingPreset(
        marketingSettings({ enhancePrompt: true, presetId }),
      );
    },
  );
});

test("invalid preset pages log only bounded schema diagnostics and keep rejecting the response", async () => {
  const { listMarketingPresets } =
    await import("../../lib/higgsfieldMarketing");
  const { runInTenant } = await import("../../lib/tenant");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = async () =>
    Response.json({
      total: "PRIVATE_TOTAL",
      cursor: { url: "https://private.example/cursor", token: "PRIVATE_TOKEN" },
      items: Array.from({ length: 10 }, () => ({
        id: "PRIVATE_ID",
        type: { secret: "PRIVATE_TYPE" },
        name: null,
        image_url: "https://private.example/image",
        secret: "PRIVATE_SECRET",
      })),
      account: "PRIVATE_ACCOUNT",
    });
  try {
    await runInTenant(
      { ...workspace("catalog_invalid"), usesPlatformKeys: true },
      async () => {
        await expect(listMarketingPresets()).rejects.toMatchObject({
          message: "Higgsfield returned an unusable preset page.",
          status: 503,
          code: "invalid_response",
        });
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toHaveLength(1);
  const diagnostic = warnings[0][0] as Record<string, unknown>;
  expect(diagnostic).toMatchObject({
    event: "higgsfield_marketing_preset_schema_mismatch",
    totalType: "string",
    cursorType: "object",
    itemsType: "array",
    itemCount: 10,
    issues: [
      { code: "invalid_type", path: ["total"] },
      { code: "invalid_type", path: ["cursor"] },
      { code: "invalid_format", path: ["items", 0, "id"] },
      { code: "invalid_type", path: ["items", 0, "type"] },
      { code: "invalid_type", path: ["items", 0, "name"] },
      { code: "invalid_format", path: ["items", 1, "id"] },
      { code: "invalid_type", path: ["items", 1, "type"] },
      { code: "invalid_type", path: ["items", 1, "name"] },
    ],
  });
  const serialized = JSON.stringify(diagnostic);
  expect(serialized).not.toMatch(
    /PRIVATE|https:|marketing-test|secret-test|account|image_url|token/,
  );
  expect(serialized.length).toBeLessThan(1500);
});

test("estimate trusts only positive USD, bounds JSON, and redacts vendor/transport errors", async () => {
  const {
    estimateMarketingInput,
    marketingInput,
    marketingSettings,
    marketingJson,
  } = await import("../../lib/higgsfieldMarketing");
  const input = marketingInput(
    "A product",
    "3:4",
    "2k",
    marketingSettings({ quality: "medium" }),
    [],
  );
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe(
      "https://api.higgsfield.ai/estimate/marketing-studio/image",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    return Response.json({ usd: "0.345", credits: "9999" });
  };
  expect(await estimateMarketingInput(input)).toBe(0.345);
  for (const usd of [0.2, "0", "-1", "NaN", "Infinity", undefined]) {
    globalThis.fetch = async () => Response.json({ usd, credits: "0.001" });
    await expect(estimateMarketingInput(input)).rejects.toThrow(/positive USD/);
  }
  globalThis.fetch = async () =>
    new Response("PRIVATE CREDENTIAL", { status: 401 });
  await expect(estimateMarketingInput(input)).rejects.toThrow(
    "This Higgsfield connection cannot access Marketing Studio.",
  );
  globalThis.fetch = async () => {
    throw new Error("PRIVATE TOKEN");
  };
  await expect(estimateMarketingInput(input)).rejects.toThrow(
    "Higgsfield pricing or presets could not be reached.",
  );
  await expect(
    marketingJson(new Response("x".repeat(512 * 1024 + 1))),
  ).rejects.toThrow(/unusable response/);
});

test("Marketing worker rechecks price before one POST, retains UUID and polls exact model without Soul gate", async () => {
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const req = await request();
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Key marketing-test:secret-test",
    );
    if (String(url).includes("/estimate/"))
      return Response.json({ usd: "0.3", credits: "999" });
    if (init?.method === "POST") {
      expect(String(url)).toBe(
        "https://api.higgsfield.ai/marketing-studio/image",
      );
      expect(JSON.parse(String(init.body))).toMatchObject({
        quality: "high",
        moderation: "auto",
        enhance_prompt: false,
        image_urls: [],
      });
      return Response.json({ request_id: requestId, status_url: statusUrl });
    }
    expect(String(url)).toBe(statusUrl);
    return Response.json({
      request_id: requestId,
      status: "completed",
      images: [{ url: "https://images.higgs.ai/master.png" }],
    });
  };
  const out = await higgsfield.render(req);
  expect(out).toMatchObject({
    handle: {
      model: req.model.id,
      ref: requestId,
      credentialFingerprint: req.higgsfieldCredentialFingerprint,
    },
  });
  if (!("handle" in out)) throw new Error("missing handle");
  expect((await higgsfield.poll!(out.handle)).status).toBe("succeeded");
  expect(calls.map((x) => x.method)).toEqual(["POST", "POST", "GET"]);
});

test("changed or missing estimate never submits; ambiguous paid POST is never retried", async () => {
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const { higgsfieldSubmissionRejected } = await import("../../lib/higgsfield");
  const req = await request();
  let submits = 0;
  for (const usd of ["0.4", "0.2", "0", undefined]) {
    globalThis.fetch = async (url) => {
      if (!String(url).includes("/estimate/")) submits++;
      return Response.json({ usd });
    };
    try {
      await higgsfield.render(req);
      throw new Error("expected refusal");
    } catch (error) {
      expect(higgsfieldSubmissionRejected(error)).toBe(true);
    }
  }
  expect(submits).toBe(0);
  globalThis.fetch = async (url) => {
    if (String(url).includes("/estimate/"))
      return Response.json({ usd: "0.3" });
    submits++;
    throw new Error("ambiguous submit");
  };
  await expect(higgsfield.render(req)).rejects.toThrow("ambiguous submit");
  expect(submits).toBe(1);
});

test("signed references use tenant original identities, reject unsupported sources and cannot forward client URLs", async () => {
  const { marketingReferenceUrls } =
    await import("../../lib/higgsfieldMarketing");
  const { runInTenant } = await import("../../lib/tenant");
  process.env.ENGINE_MOCK = "1";
  await runInTenant({ ...workspace("signed"), legacy: false }, async () => {
    const urls = await marketingReferenceUrls([
      {
        id: "up_one",
        mime: "image/png",
        ext: "png",
        storedUrl: "https://attacker.invalid/source",
        kind: "image",
        role: "reference_image",
      },
    ]);
    expect(urls[0]).toContain("ws_signed/uploads/up_one.png");
    expect(urls[0]).not.toContain("attacker");
    await expect(
      marketingReferenceUrls([
        {
          id: "../other",
          mime: "image/png",
          ext: "png",
          storedUrl: "",
          kind: "image",
          role: "reference_image",
        },
      ]),
    ).rejects.toThrow(/stored still/);
  });
});

test("Marketing durable receipts recover lost tenant acknowledgement, settle saved price once and hide internal fields", async () => {
  process.env.ENGINE_MOCK = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { loadJob, produce, reconcileHiggsfieldImage } =
    await import("../../lib/renderWork");
  const { getGeneration, syncPending } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const { restoreHiggsfieldGenerationReceipt } =
    await import("../../lib/higgsfieldGenerationReceipts");
  const engine = engineFor("higgsfield"),
    render = engine.render,
    poll = engine.poll;
  let paidPosts = 0;
  engine.render = async (req) => {
    paidPosts++;
    return render(req);
  };
  engine.poll = async () => {
    throw new Error("Temporary poll failure");
  };
  const genId = `gen_marketing_${path.basename(dir)}`;
  try {
    await runInTenant(workspace("marketing_recovery"), async () => {
      await ready();
      const req = await request();
      const params = {
        marketing: req.marketing,
        higgsfieldCredentialFingerprint: req.higgsfieldCredentialFingerprint,
        higgsfieldVendorCostUsd: 0.25,
        ratio: req.ratio,
        resolution: req.size,
        references: [],
      };
      await db().execute({
        sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','higgsfield',?,?,?,'running',?,?)",
        args: [
          genId,
          req.model.id,
          req.prompt,
          JSON.stringify(params),
          Date.now(),
          Date.now(),
        ],
      });
      const client = db(),
        execute = client.execute.bind(client);
      client.execute = async (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (
          sql.startsWith(
            "UPDATE generations SET params=json_set(params,'$.higgsfieldStillHandle'",
          )
        )
          throw new Error("Tenant write outage");
        return execute(statement);
      };
      try {
        expect(await produce((await loadJob(genId))!)).toBeNull();
      } finally {
        client.execute = execute;
      }
      expect(paidPosts).toBe(1);
      const receipt = (
        await platformDb().execute({
          sql: "SELECT handle_json FROM higgsfield_generation_receipts WHERE id=?",
          args: [genId],
        })
      ).rows[0];
      expect(JSON.parse(String(receipt.handle_json)).model).toBe(req.model.id);
      await restoreHiggsfieldGenerationReceipt(genId);
      expect(await produce((await loadJob(genId))!)).toBeNull();
      await syncPending(10);
      expect(paidPosts).toBe(1);
      const visible = (await getGeneration(genId))!;
      for (const key of [
        "higgsfieldCredentialFingerprint",
        "higgsfieldVendorCostUsd",
        "higgsfieldStillHandle",
        "paidClaim",
      ])
        expect(visible.params).not.toHaveProperty(key);
      expect(visible.params.marketing).toEqual(req.marketing);
      // Use the real mock collector's bounded master bytes and preserve original price.
      const { fixtureUrl } = await import("../../lib/mock");
      engine.poll = async () => ({
        status: "succeeded",
        videoUrl: null,
        imageUrl: fixtureUrl("still.png"),
        totalTokens: null,
        error: null,
        vendorStartedAt: null,
        vendorEndedAt: null,
        raw: {},
      });
      await reconcileHiggsfieldImage(genId);
      await reconcileHiggsfieldImage(genId);
      expect((await getGeneration(genId))!.costUsd).toBe(0.25);
      expect((await getGeneration(genId))!.status).toBe("succeeded");
      expect(
        (
          await platformDb().execute({
            sql: "SELECT settled_at FROM higgsfield_generation_receipts WHERE id=?",
            args: [genId],
          })
        ).rows[0].settled_at,
      ).toBeTruthy();
      expect(
        (
          await platformDb().execute({
            sql: "SELECT engine_cost_usd FROM meter_events WHERE id=?",
            args: [genId],
          })
        ).rows,
      ).toEqual([expect.objectContaining({ engine_cost_usd: 0.25 })]);
      expect(paidPosts).toBe(1);
    });
  } finally {
    engine.render = render;
    engine.poll = poll;
    await unlink(
      path.join(process.cwd(), ".data", "generations", `${genId}.png`),
    ).catch(() => {});
  }
});

test("unknown paid Marketing outcome retains claim and reserve; worker replays and pending sync never submit it again", async () => {
  process.env.ENGINE_MOCK = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { meter } = await import("../../lib/meter");
  const { platformDb } = await import("../../lib/platform");
  const { loadJob, produce } = await import("../../lib/renderWork");
  const { syncPending } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("higgsfield"),
    render = engine.render;
  let submits = 0;
  engine.render = async () => {
    submits++;
    throw new Error("Paid POST acknowledgement lost");
  };
  try {
    await runInTenant(workspace("unknown_marketing"), async () => {
      await ready();
      const req = await request();
      const params = {
        marketing: req.marketing,
        higgsfieldCredentialFingerprint: req.higgsfieldCredentialFingerprint,
        higgsfieldVendorCostUsd: 0.25,
        ratio: req.ratio,
        resolution: req.size,
        references: [],
      };
      await db().execute({
        sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES('marketing_unknown','image','higgsfield',?,?,?,'running',?,?)",
        args: [
          req.model.id,
          req.prompt,
          JSON.stringify(params),
          Date.now() - 3600_000,
          Date.now(),
        ],
      });
      await meter({
        id: "marketing_unknown",
        engine: "higgsfield",
        kind: "image",
        model: req.model.id,
        status: "running",
        engineCostUsd: 0.25,
      });
      expect(await produce((await loadJob("marketing_unknown"))!)).toBeNull();
      expect(await produce((await loadJob("marketing_unknown"))!)).toBeNull();
      await syncPending(10);
      expect(submits).toBe(1);
      const row = (
        await db().execute(
          "SELECT status,params FROM generations WHERE id='marketing_unknown'",
        )
      ).rows[0];
      expect(row.status).toBe("running");
      expect(JSON.parse(String(row.params)).paidClaim).toBeTruthy();
      expect(
        (
          await platformDb().execute(
            "SELECT engine_cost_usd,status FROM meter_events WHERE id='marketing_unknown'",
          )
        ).rows[0],
      ).toMatchObject({ engine_cost_usd: 0.25, status: "running" });
    });
  } finally {
    engine.render = render;
  }
});

test("an estimate transport failure ends a read activity without uncertain paid-operation bookkeeping", async () => {
  const { estimateMarketingInput, marketingInput, marketingSettings } =
    await import("../../lib/higgsfieldMarketing");
  const { recoveryFence } = await import("../../lib/recovery");
  const before = (await recoveryFence().status()).activities.length;
  globalThis.fetch = async () => {
    throw new Error("read response lost");
  };
  await expect(
    estimateMarketingInput(
      marketingInput("A product", "3:4", "2k", marketingSettings({}), []),
    ),
  ).rejects.toThrow(/could not be reached/);
  expect((await recoveryFence().status()).activities.length).toBe(before);
});

test("Marketing has no static fallback rate in either credits or vendor-dollar tables", async () => {
  const { MARKETING_IMAGE_MODEL_ID } = await import("../../lib/models");
  const { estimateImageCostUsd } = await import("../../lib/vendorPricing");
  const { buildRateTable } = await import("../../lib/rateTable.server");
  const { estimateImage } = await import("../../lib/rateTable");
  for (const size of ["1k", "2k", "4k"]) {
    expect(estimateImageCostUsd(MARKETING_IMAGE_MODEL_ID, size, 2)).toBeNull();
    expect(
      estimateImage(buildRateTable("cr"), MARKETING_IMAGE_MODEL_ID, size, 2),
    ).toBeNull();
    expect(
      estimateImage(buildRateTable("usd"), MARKETING_IMAGE_MODEL_ID, size, 2),
    ).toBeNull();
  }
});
