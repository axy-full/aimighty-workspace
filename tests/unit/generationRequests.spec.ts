import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-generation-requests-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

function workspace(name: string, paid = true): TenantWorkspace {
  return { id: `ws_${name}`, slug: name, name, legacy: !paid, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: paid, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
const request = (key: string, body: unknown = { prompt: "A studio test" }) => new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });

test("concurrent retries admit one paid operation and replay its response", async () => {
  const { withGenerationRequest, generationRequestsReady } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("retry"), async () => {
    await generationRequestsReady();
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = withGenerationRequest(request("retry-key-1"), "u_test", async () => { calls++; entered(); await wait; return Response.json({ id: "gen_mock", status: "running" }); });
    await started;
    const duplicate = await withGenerationRequest(request("retry-key-1"), "u_test", async () => { calls++; return Response.json({}); });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).pending).toBe(true);
    release();
    expect((await (await first).json()).id).toBe("gen_mock");
    const replay = await withGenerationRequest(request("retry-key-1"), "u_test", async () => { calls++; return Response.json({}); });
    expect(await replay.json()).toEqual({ id: "gen_mock", status: "running" });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(calls).toBe(1);
  });
});

test("payload changes are refused; object ordering and workspace/user isolation are respected", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  let calls = 0;
  const work = async () => { calls++; return Response.json({ ok: true }); };
  const ws = workspace("scope");
  await runInTenant(ws, async () => {
    await withGenerationRequest(request("scope-key-1", { a: 1, b: 2 }), "u_a", work);
    expect((await withGenerationRequest(request("scope-key-1", { b: 2, a: 1 }), "u_a", work)).status).toBe(200);
    expect((await withGenerationRequest(request("scope-key-1", { a: 2, b: 2 }), "u_a", work)).status).toBe(409);
    await withGenerationRequest(request("scope-key-1", { a: 1, b: 2 }), "u_b", work);
  });
  await runInTenant(workspace("other"), () => withGenerationRequest(request("scope-key-1", { a: 1, b: 2 }), "u_a", work));
  expect(calls).toBe(3);
});

test("an interrupted accepted request recovers its persisted job instead of resubmitting", async () => {
  const { withGenerationRequest, bindGenerationRequest } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(workspace("recover"), async () => {
    let calls = 0;
    const interrupted = await withGenerationRequest(request("recover-key"), "u_test", async (claim) => {
      calls++;
      await db().execute(`INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('gen_recover','mock','test','{}','queued',0,0)`);
      await bindGenerationRequest(claim, "gen_recover");
      throw new Error("simulated instance interruption");
    });
    expect(interrupted.status).toBe(503);
    const recovered = await withGenerationRequest(request("recover-key"), "u_test", async () => { calls++; return Response.json({}); });
    expect(recovered.status).toBe(202);
    expect(await recovered.json()).toEqual({ id: "gen_recover", status: "queued" });
    expect(calls).toBe(1);
  });
});

test("concurrent reservations cannot spend the same remaining credits", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  const ws = workspace("budget");
  await platformReady();
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: ["grant_budget", ws.id, 15, "Test", 0] });
  await runInTenant(ws, async () => {
    await ready();
    const results = await Promise.allSettled(["gen_budget_a", "gen_budget_b"].map((id) => reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 1 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const total = await platformDb().execute({ sql: `SELECT COUNT(*) AS n,SUM(billed_credits) AS credits FROM meter_events WHERE workspace_id=?`, args: [ws.id] });
    expect(Number(total.rows[0].n)).toBe(1);
    expect(Number(total.rows[0].credits)).toBe(15);
  });
});

test("failed pre-provider work releases its reservation through the existing meter", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { meter, creditsUsed } = await import("../../lib/meter");
  const ws = workspace("release");
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: ["grant_release", ws.id, 15, "Test", 0] });
  await runInTenant(ws, async () => {
    await reserveGenerationSpend({ id: "gen_release_a", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 1 });
    await meter({ id: "gen_release_a", kind: "video", engine: "byteplus", model: "mock", status: "failed", engineCostUsd: 0 });
    await reserveGenerationSpend({ id: "gen_release_b", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 1 });
    expect(await creditsUsed(ws.id)).toBe(15);
  });
});

test("project and token ceilings include in-flight reservations", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(workspace("caps", false), async () => {
    await ready();
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_usd) VALUES('p_cap','Cap',0,1)`);
    await reserveGenerationSpend({ id: "gen_cap_a", projectId: "p_cap", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: .7 });
    await expect(reserveGenerationSpend({ id: "gen_cap_b", projectId: "p_cap", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: .7 })).rejects.toThrow(/cap/);
    const token = { id: "token_unit", capUsd: 1 };
    await reserveGenerationSpend({ id: "gen_token_a", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: .7 }, { token });
    await expect(reserveGenerationSpend({ id: "gen_token_b", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: .7 }, { token })).rejects.toThrow(/token/);
  });
});

test("request and reservation helpers fail closed without a tenant", async () => {
  const { reserveGenerationSpend, withGenerationRequest } = await import("../../lib/generationRequests");
  await expect(reserveGenerationSpend({ id: "gen_absent", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 1 })).rejects.toThrow(/workspace/i);
  await expect(withGenerationRequest(request("absent-key"), "u_test", async () => Response.json({}))).rejects.toThrow(/workspace/i);
});

test("text and media share the atomic concurrency gate", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = { ...workspace("shared-slots", false), concurrency: 1 };
  await runInTenant(ws, async () => {
    await reserveGenerationSpend({ id: "text_slot", kind: "text", engine: "vercel", model: "mock", status: "running", engineCostUsd: 0.01 });
    await expect(reserveGenerationSpend({ id: "video_slot", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 1 })).rejects.toThrow(/slot/);
  });
});

test("late worker delivery races inline fallback without calling the paid engine twice", async () => {
  const { produce, producedOutcome } = await import("../../lib/renderWork");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { engineFor } = await import("../../lib/engines");
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ffffff" } }).png().toBuffer();
  delete process.env.BLOB_READ_WRITE_TOKEN; // Explicit local-only storage for this mocked provider test.
  const engine = engineFor("google"); const original = engine.render;
  let calls = 0;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  engine.render = async () => { calls++; entered(); await wait; return { produced: { bytes, mime: "image/png", costUsd: .1, totalTokens: 100, via: "google" } }; };
  try {
    await runInTenant(workspace("paid-claim", false), async () => {
      await ready();
      await db().execute(`INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES('gen_claim','image','gemini-3-pro-image','test','{}','running',0,0)`);
      const job = { genId: "gen_claim", kind: "image" as const, modelId: "gemini-3-pro-image", prompt: "test", ratio: "1:1", size: "1K", references: [], startedAt: 0 };
      const inline = produce(job); await started;
      expect(await produce(job)).toBeNull();
      release(); const out = await inline;
      expect(out?.kind).toBe("image");
      expect(await producedOutcome(job.genId)).toEqual(out);
      // A lost record step can use the stored output after restart.
      expect(await produce(job)).toEqual(out);
      expect(calls).toBe(1);
    });
  } finally { engine.render = original; }
});

test("an ambiguous synchronous provider failure is never automatically paid for again", async () => {
  const { produce } = await import("../../lib/renderWork");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("google"); const original = engine.render; let calls = 0;
  engine.render = async () => { calls++; throw new Error("Response lost after provider acceptance"); };
  try {
    await runInTenant(workspace("uncertain-claim", false), async () => {
      await ready();
      await db().execute(`INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES('gen_uncertain','image','gemini-3-pro-image','test','{}','running',0,0)`);
      const job = { genId: "gen_uncertain", kind: "image" as const, modelId: "gemini-3-pro-image", prompt: "test", ratio: "1:1", size: "1K", references: [], startedAt: 0 };
      await expect(produce(job)).rejects.toThrow(/Response lost/);
      expect(await produce(job)).toBeNull();
      expect(calls).toBe(1);
      expect((await db().execute(`SELECT status FROM generations WHERE id='gen_uncertain'`)).rows[0].status).toBe("failed");
    });
  } finally { engine.render = original; }
});

test("held slot jobs recheck and reserve credits before release", async () => {
  const { releaseHeldJobs } = await import("../../lib/held");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { creditsUsed } = await import("../../lib/meter");
  const ws = { ...workspace("held-budget"), concurrency: 5 };
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: ["grant_held_budget", ws.id, 15, "Test", 0] });
  await runInTenant(ws, async () => {
    await ready();
    for (const id of ["gen_held_a", "gen_held_b"]) await db().execute({ sql: `INSERT INTO generations(id,kind,model,prompt,params,status,provider,billed_to,created_at,updated_at) VALUES(?,'video','mock','test',?,'held','byteplus','byteplus',0,0)`, args: [id, JSON.stringify({ held: { estUsd: .75, needs: 12, why: "slots", at: 0 } })] });
    const deferred: Array<() => Promise<void>> = [];
    const result = await releaseHeldJobs({ defer: (fn) => { deferred.push(fn); } });
    expect(result.released).toHaveLength(1);
    expect(result.short).toBe(1);
    expect(deferred).toHaveLength(1); // Intentionally never call the provider.
    expect(await creditsUsed(ws.id)).toBe(12);
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM generations WHERE status='held'`)).rows[0].n)).toBe(1);
  });
});


test("public job payloads preserve creative parameters without exposing paid-step recovery internals", async () => {
  const { rowToGeneration } = await import("../../lib/jobs");
  const result = rowToGeneration({id:"gen_public",kind:"image",model:"mock",params:JSON.stringify({ratio:"16:9",references:[{uploadId:"ref"}],paidClaim:123,producedOutcome:{cost:1.23,storedUrl:"internal-recovery-path"}})});
  expect(result.params).toEqual({ratio:"16:9",references:[{uploadId:"ref"}]});
});
