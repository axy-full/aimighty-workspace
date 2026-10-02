import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { pinCreditUsd } from "../helpers/creditRate";

const dir = mkdtempSync(path.join(tmpdir(), "particl-generation-requests-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
pinCreditUsd("0.10");
process.env.ENGINE_MOCK = "1";

function workspace(name: string, paid = true): TenantWorkspace {
  return { id: `ws_${name}`, slug: name, name, legacy: !paid, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: paid, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
const request = (key: string, body: unknown = { prompt: "A studio test" }) => new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });

test("a workbench request from an old account or workspace cannot acquire a paid claim", async () => {
  const { withGenerationRequest, generationRequestsReady } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  const ws = workspace("workbench-stale");
  await runInTenant(ws, async () => {
    await generationRequestsReady();
    for (const scope of [workbenchScopeFor(ws.id, "old-account"), workbenchScopeFor("other-workspace", "u_test")]) {
      const req = request("never-claimed");
      req.headers.set("X-Workbench-Scope", scope);
      const response = await withGenerationRequest(req, "u_test", async () => { throw new Error("Must not execute paid work"); });
      expect(response.status).toBe(409);
    }
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generation_requests")).rows[0].n)).toBe(0);
  });
});

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
    await fundFixtureWorkspace();
    await ready();
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_usd) VALUES('p_cap','Cap',0,1)`);
    await reserveGenerationSpend({ id: "gen_cap_a", projectId: "p_cap", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: .7 });
    await expect(reserveGenerationSpend({ id: "gen_cap_b", projectId: "p_cap", kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: .7 })).rejects.toThrow(/cap/);
    /* A dollar ceiling set before credits is measured in what the workspace now pays: credits billed at
       the price of a credit, at the job's own terms (never the vendor's dollars). One job fits, two do not. */
    const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
    const { creditUsd } = await import("../../lib/creditTerms");
    const perJob = creditsAtTerms(.7, currentBillingTerms("video", "mock")) * creditUsd();
    const token = { id: "token_unit", capUsd: perJob * 1.5 };
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
    await fundFixtureWorkspace();
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
    for (const id of ["gen_held_a", "gen_held_b"]) await db().execute({ sql: `INSERT INTO generations(id,kind,model,prompt,params,status,provider,billed_to,created_at,updated_at) VALUES(?,'video','mock','test',?,'held','byteplus','byteplus',0,0)`, args: [id, JSON.stringify({ held: { estUsd: .75, needs: 11.3, why: "slots", at: 0 } })] });
    const deferred: Array<() => Promise<void>> = [];
    const result = await releaseHeldJobs({ defer: (fn) => { deferred.push(fn); } });
    expect(result.released).toHaveLength(1);
    expect(result.short).toBe(1);
    expect(deferred).toHaveLength(1); // Intentionally never call the provider.
    expect(await creditsUsed(ws.id)).toBe(11.3); // 11.25, rounded up to a tenth
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM generations WHERE status='held'`)).rows[0].n)).toBe(1);
  });
});


test("public job payloads preserve creative parameters without exposing paid-step recovery internals", async () => {
  const { rowToGeneration } = await import("../../lib/jobs");
  const result = rowToGeneration({id:"gen_public",kind:"image",model:"mock",params:JSON.stringify({ratio:"16:9",references:[{uploadId:"ref"}],paidClaim:123,producedOutcome:{cost:1.23,storedUrl:"internal-recovery-path"}})});
  expect(result.params).toEqual({ratio:"16:9",references:[{uploadId:"ref"}]});
});

test("with atomic binding, a request interrupted before its job existed completes its claim instead of pending forever", async () => {
  const { withGenerationRequest, bindGenerationRequestStatement, generationRequestsReady } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(workspace("atomic-claims"), async () => {
    await ready();
    await generationRequestsReady();
    let calls = 0;
    // A database hiccup before any job row was written (getShot, listCast, checkCap…).
    const interrupted = await withGenerationRequest(request("atomic-before-row"), "u_test", async () => { calls++; throw new Error("database briefly unavailable"); }, { atomicBinding: true });
    expect(interrupted.status).toBe(409);
    expect(interrupted.headers.get("Idempotency-Status")).toBe("complete");
    expect((await interrupted.json()).error).toContain("Nothing was charged");
    // The same key replays that answer (complete), so the client clears it and can start a new request.
    const replay = await withGenerationRequest(request("atomic-before-row"), "u_test", async () => { calls++; return Response.json({}); }, { atomicBinding: true });
    expect(replay.status).toBe(409);
    expect(replay.headers.get("Idempotency-Status")).toBe("complete");
    expect((await replay.json()).pending).toBeUndefined();
    expect(calls).toBe(1);

    // Once the row and its binding committed together, the claim is kept for recovery.
    await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES('gen_atomic_bound','video','mock','x','{}','queued',1,1)" });
    const bound = await withGenerationRequest(request("atomic-after-row"), "u_test", async (claim) => {
      await db().execute(bindGenerationRequestStatement(claim, "gen_atomic_bound"));
      throw new Error("lost after the row was written");
    }, { atomicBinding: true });
    expect(bound.status).toBe(503);
    const recovered = await withGenerationRequest(request("atomic-after-row"), "u_test", async () => { throw new Error("must not run again"); }, { atomicBinding: true });
    expect(await recovered.json()).toMatchObject({ id: "gen_atomic_bound", status: "queued" });

    // Routes whose jobs are not bound atomically keep the conservative pending claim.
    const legacy = await withGenerationRequest(request("non-atomic"), "u_test", async () => { throw new Error("interrupted"); });
    expect(legacy.status).toBe(503);
    const pending = await withGenerationRequest(request("non-atomic"), "u_test", async () => Response.json({}));
    expect(pending.status).toBe(409);
    expect((await pending.json()).pending).toBe(true);
  });
});

test("a claim whose request died before its catch, or before claims were bound atomically, completes on retry once that request is gone", async () => {
  const { withGenerationRequest, generationRequestsReady, generationFingerprint, STALE_CLAIM_MS } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(workspace("stale-claims"), async () => {
    await ready();
    await generationRequestsReady();
    // What a killed function leaves behind: the claim, with no job and no answer.
    const orphan = async (key: string, age: number) => {
      const fingerprint = generationFingerprint({ method: "POST", path: "/api/generate", body: { prompt: "A studio test" } });
      await db().execute({ sql: "INSERT INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES('u_test',?,?,?,?)",
        args: [key, fingerprint, Date.now() - age, Date.now() - age] });
    };
    const never = async () => { throw new Error("a replay never runs the request again"); };
    await orphan("stale-atomic", STALE_CLAIM_MS + 60_000);
    const repaired = await withGenerationRequest(request("stale-atomic"), "u_test", never, { atomicBinding: true });
    expect(repaired.status).toBe(409);
    expect(repaired.headers.get("Idempotency-Status")).toBe("complete");
    expect((await repaired.json()).error).toContain("Nothing was charged");
    const replay = await withGenerationRequest(request("stale-atomic"), "u_test", never, { atomicBinding: true });
    expect(replay.headers.get("Idempotency-Status")).toBe("complete");

    // A claim young enough that its request may still be running stays pending.
    await orphan("fresh-atomic", 60_000);
    const fresh = await withGenerationRequest(request("fresh-atomic"), "u_test", never, { atomicBinding: true });
    expect(fresh.status).toBe(409);
    expect((await fresh.json()).pending).toBe(true);

    // A route that does not bind atomically cannot prove there is no job: it stays pending.
    await orphan("stale-legacy", STALE_CLAIM_MS + 60_000);
    const legacy = await withGenerationRequest(request("stale-legacy"), "u_test", never);
    expect((await legacy.json()).pending).toBe(true);
  });
});

/* A browser whose paid reply was lost asks what became of the request before it does anything else (POST /api/generate/check). */
test("a lost request is checked by its key: landed names its job, never arrived is fenced for good, and only the sender's own claim in this workspace is read", async () => {
  const { withGenerationRequest, checkGenerationRequest, generationFingerprint, bindGenerationRequest } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const sent = { prompt: "Wide. Hold still.", maxCredits: 18 };
  const fingerprint = generationFingerprint({ method: "POST", path: "/api/generate", body: sent });
  const check = (key: string, userId = "u_test", print = fingerprint) => checkGenerationRequest({ userId, key, fingerprint: print });
  await runInTenant(workspace("check"), async () => {
    /* Landed: the request admitted under the key names its job, with the job's own status. */
    await withGenerationRequest(request("check-landed", sent), "u_test", async (claim) => {
      await db().execute(`INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('gen_check','mock','test','{}','running',0,0)`);
      await bindGenerationRequest(claim, "gen_check");
      return Response.json({ id: "gen_check", status: "queued" }, { status: 202 });
    });
    expect(await check("check-landed")).toEqual({ state: "landed", id: "gen_check", status: "running" });

    /* A refused charge files a failed job: it still landed, and its status says it failed (unbilled). */
    await withGenerationRequest(request("check-failed", sent), "u_test", async (claim) => {
      await db().execute(`INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('gen_failed','mock','test','{}','failed',0,0)`);
      await bindGenerationRequest(claim, "gen_failed");
      return Response.json({ id: "gen_failed", status: "failed", error: "Not enough credits" }, { status: 402 });
    });
    expect(await check("check-failed")).toEqual({ state: "landed", id: "gen_failed", status: "failed" });

    /* Refused before any job: nothing was made. */
    await withGenerationRequest(request("check-refused", sent), "u_test", async () => Response.json({ error: "Prompt is required" }, { status: 400 }));
    expect(await check("check-refused")).toEqual({ state: "refused", status: 400, error: "Prompt is required" });

    /* Never arrived: absent, and fenced in the same step — the request turning up afterwards is answered, never admitted. */
    expect(await check("check-absent")).toEqual({ state: "absent" });
    let calls = 0;
    const late = await withGenerationRequest(request("check-absent", sent), "u_test", async () => { calls++; return Response.json({ id: "gen_late" }, { status: 202 }); }, { atomicBinding: true });
    expect(late.status).toBe(409);
    expect(late.headers.get("Idempotency-Status")).toBe("complete");
    expect((await late.json()).error).toContain("Nothing was charged");
    expect(calls).toBe(0);
    expect(await check("check-absent")).toEqual({ state: "absent" });
    expect((await db().execute("SELECT COUNT(*) AS n FROM generations WHERE id='gen_late'")).rows[0].n).toBe(0);

    /* A key is only ever checked against the request it named. */
    expect(await check("check-landed", "u_test", generationFingerprint({ method: "POST", path: "/api/generate", body: { ...sent, prompt: "Close on her hands." } }))).toEqual({ state: "mismatch" });

    /* Another person's check of the same key reads, and fences, only their own. */
    expect(await check("check-landed", "u_other")).toEqual({ state: "absent" });
    expect(await check("check-landed")).toEqual({ state: "landed", id: "gen_check", status: "running" });
  });
  /* Another workspace never sees this one's claims. */
  await runInTenant(workspace("check-elsewhere"), async () => {
    expect(await check("check-landed")).toEqual({ state: "absent" });
  });
  await runInTenant(workspace("check"), async () => {
    expect(await check("check-landed")).toEqual({ state: "landed", id: "gen_check", status: "running" });
  });
});

test("a checked claim still being accepted is pending until no request could still be running it, then settled as never admitted", async () => {
  const { withGenerationRequest, checkGenerationRequest, generationRequestsReady, generationFingerprint, STALE_CLAIM_MS } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const body = { prompt: "A studio test" };
  const fingerprint = generationFingerprint({ method: "POST", path: "/api/generate", body });
  await runInTenant(workspace("check-pending"), async () => {
    await generationRequestsReady();
    await db().execute({ sql: "INSERT INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES('u_test','check-inflight',?,?,?)", args: [fingerprint, Date.now(), Date.now()] });
    expect(await checkGenerationRequest({ userId: "u_test", key: "check-inflight", fingerprint })).toEqual({ state: "pending" });
    await db().execute({ sql: "UPDATE generation_requests SET created_at=? WHERE request_key='check-inflight'", args: [Date.now() - STALE_CLAIM_MS - 60_000] });
    const settled = await checkGenerationRequest({ userId: "u_test", key: "check-inflight", fingerprint });
    expect(settled).toMatchObject({ state: "refused", status: 409 });
    expect(settled.state === "refused" && settled.error).toContain("Nothing was charged");
    /* The request itself, arriving now, gets the same final answer. */
    const replay = await withGenerationRequest(request("check-inflight", body), "u_test", async () => { throw new Error("never admitted"); }, { atomicBinding: true });
    expect(replay.status).toBe(409);
    expect(replay.headers.get("Idempotency-Status")).toBe("complete");
  });
});

test("POST /api/generate/check fingerprints the request exactly as POST /api/generate did, for the caller's own claims only", async () => {
  const ts = (await import("typescript")).default;
  const { readFileSync } = await import("node:fs");
  const generationRequests = await import("../../lib/generationRequests");
  const tenant = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  type Handler = (req: Request) => Promise<Response>;
  const dependencies: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: Handler) => handler, requireUser: async () => ({ user: { id: "u_test" } }) },
    "@/lib/tenant": tenant,
    "@/lib/generationRequests": generationRequests,
    "@/lib/transcription": await import("../../lib/transcription"),
    "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/generate/check/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const route = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in dependencies)) throw new Error("Unexpected import " + name);
    return dependencies[name];
  }, route, route.exports);
  const ws = workspace("check-route");
  const scope = workbenchScopeFor(ws.id, "u_test");
  const ask = (input: unknown, headers: Record<string, string> = { "X-Workbench-Scope": scope }) => route.exports.POST(new Request("http://localhost/api/generate/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input),
  }));
  const body = { prompt: "Wide. Hold still.", model: "mock", maxCredits: 18, quoteFingerprint: "a".repeat(64) };
  await tenant.runInTenant(ws, async () => {
    const admitted = request("route-landed-1", body);
    admitted.headers.set("X-Workbench-Scope", scope);
    await generationRequests.withGenerationRequest(admitted, "u_test", async (claim) => {
      await db().execute(`INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('gen_route','mock','test','{}','queued',0,0)`);
      await generationRequests.bindGenerationRequest(claim, "gen_route");
      return Response.json({ id: "gen_route", status: "queued" }, { status: 202 });
    }, { atomicBinding: true });
    /* The body as the browser stored and sent it: a JSON string, read back the way the route read it. */
    const landed = await ask({ key: "route-landed-1", endpoint: "/api/generate", body: JSON.stringify(body) });
    expect(landed.status).toBe(200);
    expect(await landed.json()).toEqual({ state: "landed", id: "gen_route", status: "queued" });
    /* The same key under another route is another request. */
    expect((await ask({ key: "route-landed-1", endpoint: "/api/audio", body: JSON.stringify(body) })).status).toBe(409);
    expect(await (await ask({ key: "route-absent-1", endpoint: "/api/generate", body: JSON.stringify(body) })).json()).toEqual({ state: "absent" });
    /* Only the paid routes that bind their job atomically; a well-formed request only; the tab's own account and workspace only. */
    for (const bad of [
      { key: "route-bad-1", endpoint: "/api/prompt/enhance", body: JSON.stringify(body) },
      { key: "short", endpoint: "/api/generate", body: JSON.stringify(body) },
      { key: "route-bad-1", endpoint: "/api/generate", body: "{not json" },
      { key: "route-bad-1", endpoint: "/api/generate", body: "[1]" },
      { key: "route-bad-1", endpoint: "/api/generate" },
    ]) expect((await ask(bad)).status).toBe(400);
    /* A transcription answers in its reply rather than with a job: its check returns that saved reply. */
    const spoken = { sourceUploadId: "up_route", diarize: true, maxCredits: 1 };
    const transcript = { text: "Hold still.", language: "en", seconds: 1, words: [], srt: "", credits: 1 };
    const said = new Request("http://localhost/api/audio/transcribe", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "route-transcript-1", "X-Workbench-Scope": scope }, body: JSON.stringify(spoken) });
    await generationRequests.withGenerationRequest(said, "u_test", async () => Response.json(transcript));
    expect(await (await ask({ key: "route-transcript-1", endpoint: "/api/audio/transcribe", body: JSON.stringify(spoken) })).json()).toEqual({ state: "answered", reply: transcript });
    expect((await ask({ key: "route-transcript-1", endpoint: "/api/audio/transcribe", body: JSON.stringify({ ...spoken, diarize: false }) })).status).toBe(409);
    expect(await (await ask({ key: "route-transcript-2", endpoint: "/api/audio/transcribe", body: JSON.stringify(spoken) })).json()).toEqual({ state: "absent" });
    expect((await ask({ key: "route-bad-2", endpoint: "/api/generate", body: JSON.stringify(body) }, {})).status).toBe(409);
    expect((await ask({ key: "route-bad-2", endpoint: "/api/generate", body: JSON.stringify(body) }, { "X-Workbench-Scope": workbenchScopeFor(ws.id, "u_other") })).status).toBe(409);
    expect((await db().execute("SELECT COUNT(*) AS n FROM generation_requests WHERE request_key LIKE 'route-bad-%'")).rows[0].n).toBe(0);
  });
});


test("shared engines isolate studio balances and credit token ceilings across concurrent jobs", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { vendorKey } = await import("../../lib/vendorKeys");
  const { creditState } = await import("../../lib/credits");
  const { tokenCreditUsage } = await import("../../lib/tokenUsage");
  const { grantCredits } = await import("../../lib/platform");
  const { billCredits } = await import("../../lib/creditTerms");
  const a = workspace("managed-org-a", false), b = workspace("managed-org-b", false);
  a.keys.openai = "retained-tenant-a"; b.keys.openai = "retained-tenant-b";
  a.keys.higgsfield = "retained-hf-a"; b.keys.higgsfield = "retained-hf-b";
  const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "shared-unit-key";
  const priorHiggsfield = process.env.HF_CREDENTIALS; process.env.HF_CREDENTIALS = "shared-hf-unit:fixture-secret";
  try {
    const price = billCredits(1, "text");
    await grantCredits(a.id, price * 3, "Fixture", null, "manual");
    await grantCredits(b.id, price * 3, "Fixture", null, "manual");
    const token = { id: "same-token-id", capUsd: null, capCredits: price };
    await runInTenant(a, async () => {
      expect(vendorKey("openai")).toBe("shared-unit-key");
      expect(vendorKey("higgsfield")).toBe("shared-hf-unit:fixture-secret");
      const jobs = await Promise.allSettled(["managed-a-first", "managed-a-second"].map(id => reserveGenerationSpend({ id, kind: "text", engine: "openai", model: "fixture", status: "running", engineCostUsd: 1 }, { token })));
      expect(jobs.filter(job => job.status === "fulfilled")).toHaveLength(1);
      expect(jobs.filter(job => job.status === "rejected")).toHaveLength(1);
      expect((await creditState())?.balance).toBe(price * 2);
      expect((await tokenCreditUsage(0)).get(token.id)).toBe(price);
    });
    await runInTenant(b, async () => {
      expect(vendorKey("openai")).toBe("shared-unit-key");
      expect(vendorKey("higgsfield")).toBe("shared-hf-unit:fixture-secret");
      expect((await creditState())?.balance).toBe(price * 3);
      expect((await tokenCreditUsage(0)).get(token.id)).toBeUndefined();
      await reserveGenerationSpend({ id: "managed-b-first", kind: "text", engine: "openai", model: "fixture", status: "running", engineCostUsd: 1 }, { token });
      expect((await tokenCreditUsage(0)).get(token.id)).toBe(price);
    });
    expect(a.keys.openai).toBe("retained-tenant-a"); expect(b.keys.openai).toBe("retained-tenant-b");
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior;
    if (priorHiggsfield === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = priorHiggsfield;
  }
});


test("accepted own-key jobs keep their collection key without changing new work or another studio", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { vendorKey } = await import("../../lib/vendorKeys");
  const { withAcceptedJobCredentials } = await import("../../lib/acceptedJobCredentials");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const previous = process.env.FAL_KEY;
  process.env.FAL_KEY = "shared-fal-unit-key";
  const a = { ...workspace("accepted-a"), keys: { fal: "original-a" } };
  const b = { ...workspace("accepted-b"), keys: { fal: "original-b" } };
  try {
    await platformReady();
    for (const [ws, funded] of [[a, 0], [b, 1]] as const)
      await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,paid_by_platform,created_at,updated_at) VALUES(?,?, 'video','fal','fixture','running',?,?,?)",
        args: [`${ws.id}-collection`, ws.id, funded, Date.now(), Date.now()] });
    await Promise.all([a, b].map((ws) => runInTenant(ws, async () => {
      expect(vendorKey("fal")).toBe("shared-fal-unit-key");
      await withAcceptedJobCredentials(`${ws.id}-collection`, "fal", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(vendorKey("fal")).toBe(ws.id === a.id ? "original-a" : "shared-fal-unit-key");
        await runInTenant(b, async () => expect(vendorKey("fal")).toBe("shared-fal-unit-key"));
      });
      expect(vendorKey("fal")).toBe("shared-fal-unit-key");
    })));
    await runInTenant(a, async () => {
      await withAcceptedJobCredentials("pre-meter-history", "fal", async () => expect(vendorKey("fal")).toBe("original-a"));
      await expect(withAcceptedJobCredentials(`${a.id}-collection`, "fal", async () => { throw new Error("collector failed"); })).rejects.toThrow("collector failed");
      expect(vendorKey("fal")).toBe("shared-fal-unit-key");
    });
    await runInTenant({ ...a, keys: {} }, async () => {
      let called = false;
      await expect(withAcceptedJobCredentials(`${a.id}-collection`, "fal", async () => { called = true; })).rejects.toThrow("original connection is unavailable");
      expect(called).toBe(false);
    });
  } finally {
    if (previous === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previous;
  }
});

test("the house workspace's accepted jobs are collected with the deployment's keys; another keyless workspace's own-key job is not", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { vendorKey } = await import("../../lib/vendorKeys");
  const { withAcceptedJobCredentials } = await import("../../lib/acceptedJobCredentials");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  const previous = process.env.FAL_KEY;
  process.env.FAL_KEY = "shared-fal-unit-key";
  /* The house workspace (lib/houseWorkspace.ts): no keys of its own, never billed in credits. */
  const house = { ...workspace("house-inflight", false), id: HOUSE_WORKSPACE_ID, usesPlatformKeys: true };
  /* The same shape under any other id: the legacy flag does not make a workspace the house. */
  const flagged = { ...workspace("legacy-inflight", false), usesPlatformKeys: true };
  const tag = randomUUID().slice(0, 8);
  try {
    await platformReady();
    /* Metered as not platform-paid, although it ran on the deployment's keys: before the deploy and after it. */
    for (const ws of [house, flagged])
      await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,paid_by_platform,created_at,updated_at) VALUES(?,?, 'video','fal','fixture','running',0,?,?)",
        args: [`${ws.id}-inflight-${tag}`, ws.id, Date.now(), Date.now()] });
    await runInTenant(house, async () => {
      const keys: (string | null)[] = [];
      await withAcceptedJobCredentials(`${house.id}-inflight-${tag}`, "fal", async () => { keys.push(vendorKey("fal")); });
      /* An older job with no meter row reads the same way. */
      await withAcceptedJobCredentials(`${house.id}-pre-meter-${tag}`, "fal", async () => { keys.push(vendorKey("fal")); });
      expect(keys).toEqual(["shared-fal-unit-key", "shared-fal-unit-key"]);
    });
    await runInTenant(flagged, async () => {
      let called = false;
      await expect(withAcceptedJobCredentials(`${flagged.id}-inflight-${tag}`, "fal", async () => { called = true; })).rejects.toThrow("original connection is unavailable");
      expect(called).toBe(false);
    });
  } finally {
    if (previous === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previous;
  }
});
