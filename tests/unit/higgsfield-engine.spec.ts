import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StillRenderRequest, RenderHandle } from "../../lib/engines/types";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-soul-engine-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const ref = "067e9e94-0bea-4acd-b82a-071a264d8e26";
const requestId = "117e9e94-0bea-4acd-b82a-071a264d8e26";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = "unit-key:unit-secret";
  process.env.HF_SOUL_CHARACTER_ENABLED = "1";
  // Synthetic test configuration, not a published vendor rate.
  process.env.HF_SOUL_CHARACTER_USD_720P = "0.12";
  process.env.HF_SOUL_CHARACTER_USD_1080P = "0.24";
  globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

async function request(): Promise<StillRenderRequest> {
  const { getModel, SOUL_CHARACTER_MODEL_ID } = await import("../../lib/models");
  const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  return { kind: "image", genId: "gen_soul", model: getModel(SOUL_CHARACTER_MODEL_ID), prompt: "Portrait at a diner",
    ratio: "3:4", size: "720p", references: [], soulReferenceId: ref, soulCredentialFingerprint: higgsfieldCredentialFingerprint() };
}

test("Soul generation has no price or availability without both verified configured rates", async () => {
  const { soulCharacterGenerationEnabled, soulCharacterRates } = await import("../../lib/vendorRates");
  const { estimateImageCostUsd } = await import("../../lib/vendorPricing");
  const { buildRateTable } = await import("../../lib/rateTable.server");
  const { estimateImage } = await import("../../lib/rateTable");
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const req = await request();
  expect(soulCharacterGenerationEnabled()).toBe(true);
  expect(higgsfield.estimate(req)).toBe(0.12);
  expect(estimateImage(buildRateTable("usd"), req.model.id, "1080p")).toBe(0.24);
  for (const value of ["", "0", "-1", "NaN", "Infinity"]) {
    process.env.HF_SOUL_CHARACTER_USD_1080P = value;
    expect(soulCharacterGenerationEnabled()).toBe(false);
    expect(soulCharacterRates()).toBeNull();
    expect(estimateImageCostUsd(req.model.id, "720p")).toBeNull();
    // The provider can still serve Marketing Studio; the Soul model stays gated.
    expect(higgsfield.configured()).toBe(true);
    await expect(higgsfield.render(req)).rejects.toThrow(/availability and pricing/);
  }
  process.env.HF_SOUL_CHARACTER_USD_1080P = "0.24";
  delete process.env.HF_SOUL_CHARACTER_ENABLED;
  expect(soulCharacterGenerationEnabled()).toBe(false);
  expect(higgsfield.estimate(req)).toBeNull();
});

test("submission uses the Soul Character contract once and retains its UUID for collection", async () => {
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const req = await request();
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ request_id: requestId, status: "queued", status_url: statusUrl });
  };
  const out = await higgsfield.render({ ...req, soulStrength: 0.7 });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.higgsfield.ai/higgsfield-ai/soul/character");
  expect(calls[0].init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Key unit-key:unit-secret" } });
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ prompt: req.prompt, custom_reference_id: ref, custom_reference_strength: 0.7,
    batch_size: 1, resolution: "720p", aspect_ratio: "3:4", enhance_prompt: false });
  expect(out).toMatchObject({ handle: { ref: requestId, endpoint: statusUrl, credentialFingerprint: req.soulCredentialFingerprint } });
  calls.length = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); throw new Error("Lost acknowledgment"); };
  await expect(higgsfield.render(req)).rejects.toThrow("Lost acknowledgment");
  expect(calls).toHaveLength(1);
});

test("untrusted status URLs and changed credentials never receive an authorized GET", async () => {
  const { higgsfield, soulStatusUrl, soulCharacterInput } = await import("../../lib/engines/higgsfield");
  const req = await request();
  for (const url of ["https://attacker.example/status", `https://api.higgsfield.ai/requests/${ref}/status`, `${statusUrl}?redirect=x`,
    `https://user:secret@api.higgsfield.ai/requests/${requestId}/status`, statusUrl.replace("https:", "http:")])
    expect(() => soulStatusUrl(url, requestId)).toThrow();
  expect(() => soulCharacterInput({ ...req, soulReferenceId: "element-id" })).toThrow();
  expect(() => soulCharacterInput({ ...req, soulStrength: NaN })).toThrow();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ request_id: requestId, status_url: "https://attacker.example/status" }); };
  const out = await higgsfield.render(req);
  expect("handle" in out && out.handle.ref).toBe(requestId); // Never discard an accepted paid UUID.
  await expect(higgsfield.poll!("handle" in out ? out.handle : {} as RenderHandle)).rejects.toThrow(/unexpected status URL/);
  expect(calls).toBe(1);
  process.env.HF_CREDENTIALS = "rotated:key";
  await expect(higgsfield.poll!({ provider: "higgsfield", model: req.model.id, ref: requestId, endpoint: statusUrl,
    credentialFingerprint: req.soulCredentialFingerprint })).rejects.toThrow(/connection changed/);
  expect(calls).toBe(1);
});

test("collection remains enabled after the submit gate closes and preserves full image result", async () => {
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const req = await request();
  process.env.HF_SOUL_CHARACTER_ENABLED = "0";
  const handle: RenderHandle = { provider: "higgsfield", model: req.model.id, ref: requestId, endpoint: statusUrl, credentialFingerprint: req.soulCredentialFingerprint };
  const master = "https://images.higgs.ai/full-original.png";
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe(statusUrl);
    expect(init?.method).toBe("GET");
    return Response.json({ request_id: requestId, status: "completed", images: [{ url: master }] });
  };
  expect(await higgsfield.poll!(handle)).toMatchObject({ status: "succeeded", imageUrl: master });
  for (const status of ["failed", "nsfw", "canceled"]) {
    globalThis.fetch = async () => Response.json({ request_id: requestId, status });
    expect((await higgsfield.poll!(handle)).status).toBe(status === "canceled" ? "cancelled" : "failed");
  }
  globalThis.fetch = async () => Response.json({ request_id: requestId, status: "completed", images: [] });
  await expect(higgsfield.poll!(handle)).rejects.toThrow(/image count/);
  const bytes = Buffer.from([1, 2, 3, 4]);
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe(master);
    expect(init?.headers).toBeUndefined(); // Never send API credentials to a CDN.
    expect(init?.redirect).toBe("error");
    return new Response(bytes);
  };
  expect(await higgsfield.fetchMaster!(master)).toEqual(bytes);
  await expect(higgsfield.fetchMaster!("https://127.0.0.1/private")).rejects.toThrow(/unsupported image URL/);
});

function workspace(name: string): TenantWorkspace {
  return { id: `ws_${name}`, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 8, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null };
}

test("durable collection retains the original request across failures, hides private fields, and never resubmits", async () => {
  process.env.ENGINE_MOCK = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { loadJob, produce, reconcileHiggsfieldImage } = await import("../../lib/renderWork");
  const { engineFor } = await import("../../lib/engines");
  const { getGeneration } = await import("../../lib/jobs");
  const engine = engineFor("higgsfield"), originalRender = engine.render, originalPoll = engine.poll;
  let submitted = 0, polled = 0;
  engine.render = async req => { submitted++; return originalRender(req); };
  engine.poll = async handle => { polled++; expect(handle.credentialFingerprint).toBeTruthy(); throw new Error("Transient collection failure"); };
  try {
    await runInTenant(workspace("soul_collection"), async () => {
      await ready();
      const req = await request();
      const params = { soulIdentityId: "identity-local", soulReferenceId: ref, soulCredentialFingerprint: req.soulCredentialFingerprint,
        soulVendorCostUsd: 0.12, ratio: "3:4", resolution: "720p", references: [] };
      await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','higgsfield',?,?,?,'running',?,?)",
        args: [req.genId, req.model.id, req.prompt, JSON.stringify(params), Date.now(), Date.now()] });
      expect(await produce((await loadJob(req.genId))!)).toBeNull();
      expect(submitted).toBe(1);
      const stored = JSON.parse(String((await db().execute("SELECT params FROM generations WHERE id='gen_soul'")).rows[0].params));
      expect(stored.higgsfieldStillHandle.ref).toMatch(/^mock_higgsfield_/);
      expect(stored.paidClaim).toBeTruthy();
      const visible = (await getGeneration(req.genId))!;
      expect(visible.status).toBe("running");
      for (const key of ["higgsfieldStillHandle", "soulReferenceId", "soulCredentialFingerprint", "soulVendorCostUsd"]) expect(visible.params).not.toHaveProperty(key);
      expect(visible.params.soulIdentityId).toBe("identity-local");
      expect(await produce((await loadJob(req.genId))!)).toBeNull();
      expect(submitted).toBe(1);
      await expect(reconcileHiggsfieldImage(req.genId)).rejects.toThrow("Transient collection failure");
      expect(polled).toBe(2);
      expect(submitted).toBe(1);
      engine.poll = async () => ({ status: "failed", videoUrl: null, imageUrl: null, totalTokens: null, error: "Moderated", vendorStartedAt: null, vendorEndedAt: null, raw: {} });
      await reconcileHiggsfieldImage(req.genId);
      expect((await getGeneration(req.genId))!.status).toBe("failed");
      expect((await db().execute("SELECT cost_usd FROM generations WHERE id='gen_soul'")).rows[0].cost_usd).toBe(0);
    });
  } finally { engine.render = originalRender; engine.poll = originalPoll; }
});

test("a completed request stores the full master and settles the saved price after configuration changes", async () => {
  process.env.ENGINE_MOCK = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { reconcileHiggsfieldImage } = await import("../../lib/renderWork");
  const { getGeneration } = await import("../../lib/jobs");
  const { fixtureBytes } = await import("../../lib/mockFs");
  const sharp = (await import("sharp")).default;
  const genId = `gen_soul_${path.basename(dir)}`;
  const output = path.join(process.cwd(), ".data", "generations", `${genId}.png`);
  try {
    await runInTenant(workspace("soul_success"), async () => {
      await ready();
      const req = await request();
      const params = { soulReferenceId: ref, soulCredentialFingerprint: req.soulCredentialFingerprint,
        soulVendorCostUsd: 0.12, ratio: "3:4", resolution: "720p", references: [], paidClaim: 1,
        higgsfieldStillHandle: { provider: "higgsfield", model: req.model.id, ref: "mock_higgsfield_1" } };
      await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','higgsfield',?,?,?,'running',?,?)",
        args: [genId, req.model.id, req.prompt, JSON.stringify(params), Date.now(), Date.now()] });
      process.env.HF_SOUL_CHARACTER_ENABLED = "0";
      process.env.HF_SOUL_CHARACTER_USD_720P = "9";
      await reconcileHiggsfieldImage(genId);
      const gen = (await getGeneration(genId))!;
      expect(gen.status).toBe("succeeded");
      expect(gen.storedUrl).toBe(`/api/media/${genId}`);
      expect(gen.costUsd).toBe(0.12);
      const saved = await readFile(output);
      const original = await fixtureBytes("still.png");
      expect(await sharp(saved).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
      const event = (await platformDb().execute({ sql: "SELECT engine,engine_cost_usd FROM meter_events WHERE id=?", args: [genId] })).rows[0];
      expect(event.engine).toBe("higgsfield");
      expect(event.engine_cost_usd).toBe(0.12);
      await reconcileHiggsfieldImage(genId);
      expect((await getGeneration(genId))!.status).toBe("succeeded");
    });
  } finally { await unlink(output).catch(() => {}); }
});

test("independent accepted receipt restores a lost tenant handle without another paid submission", async () => {
  process.env.ENGINE_MOCK = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { loadJob, produce } = await import("../../lib/renderWork");
  const { getGeneration, syncGeneration, syncPending } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("higgsfield"), originalRender = engine.render, originalPoll = engine.poll;
  let submitted = 0, polled = 0, terminal = false;
  engine.render = async req => {
    submitted++;
    if (req.genId === "gen_unknown_soul") throw new Error("Acknowledgement lost");
    return originalRender(req);
  };
  engine.poll = async () => { polled++; return { status: terminal ? "failed" : "queued", imageUrl: null, videoUrl: null,
    totalTokens: null, error: terminal ? "Provider confirmed failure" : null, vendorStartedAt: null, vendorEndedAt: null, raw: {} }; };
  try {
    await runInTenant(workspace("soul_receipt_recovery"), async () => {
      await ready();
      const req = await request();
      const params = { soulReferenceId: ref, soulCredentialFingerprint: req.soulCredentialFingerprint,
        soulVendorCostUsd: 0.12, ratio: "3:4", resolution: "720p", references: [] };
      for (const genId of ["gen_receipt_soul", "gen_unknown_soul"]) await db().execute({
        sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','higgsfield',?,?,?,'running',?,?)",
        args: [genId, req.model.id, req.prompt, JSON.stringify(params), Date.now() - 60 * 60_000, Date.now()] });
      const client = db(), execute = client.execute.bind(client);
      client.execute = async statement => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql.startsWith("UPDATE generations SET params=json_set(params,'$.higgsfieldStillHandle'")) throw new Error("Tenant handle write unavailable");
        return execute(statement);
      };
      try { expect(await produce((await loadJob("gen_receipt_soul"))!)).toBeNull(); }
      finally { client.execute = execute; }
      expect(submitted).toBe(1);
      const local = JSON.parse(String((await db().execute("SELECT params FROM generations WHERE id='gen_receipt_soul'")).rows[0].params));
      expect(local.higgsfieldStillHandle).toBeUndefined();
      const receipt = (await platformDb().execute("SELECT handle_json,settled_at FROM higgsfield_generation_receipts WHERE id='gen_receipt_soul'")).rows[0];
      expect(JSON.parse(String(receipt.handle_json)).ref).toMatch(/^mock_higgsfield_/);
      expect(receipt.settled_at).toBeNull();
      expect(await produce((await loadJob("gen_receipt_soul"))!)).toBeNull();
      expect(submitted).toBe(1);
      // A pre-receipt deployment may already have marked this unknown outcome failed.
      await db().execute("UPDATE generations SET status='failed' WHERE id='gen_receipt_soul'");
      const restored = await syncGeneration((await getGeneration("gen_receipt_soul"))!);
      expect(restored.status).toBe("queued");
      expect(polled).toBe(1);
      expect(submitted).toBe(1);
      expect(await produce((await loadJob("gen_unknown_soul"))!)).toBeNull();
      expect(submitted).toBe(2);
      await syncPending(10);
      expect((await getGeneration("gen_unknown_soul"))!.status).toBe("running");
      expect(submitted).toBe(2);
      terminal = true;
      await syncGeneration((await getGeneration("gen_receipt_soul"))!);
      expect((await getGeneration("gen_receipt_soul"))!.status).toBe("failed");
      expect((await platformDb().execute("SELECT settled_at FROM higgsfield_generation_receipts WHERE id='gen_receipt_soul'")).rows[0].settled_at).toBeTruthy();
      const priorPolls = polled;
      await syncGeneration((await getGeneration("gen_receipt_soul"))!);
      expect(polled).toBe(priorPolls);
      expect(submitted).toBe(2);
    });
  } finally { engine.render = originalRender; engine.poll = originalPoll; }
});
