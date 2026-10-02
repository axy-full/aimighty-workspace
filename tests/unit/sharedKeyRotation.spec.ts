import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { RenderHandle, StillRenderRequest } from "../../lib/engines/types";

/**
 * One owned provider key, rotated: every job is pinned to a one-way
 * fingerprint of the key it was sent on, and is collected and settled with
 * exactly that key (the key sending now, a previous key kept for collection,
 * or the current key where the operator says the old one was the same
 * provider organization). With the old key gone the take waits, saying so,
 * the platform's admin is told once, and nothing is failed, refunded or sent
 * again. Every request carries a correlation id, and the one the provider
 * answers with is kept beside its request_id for the platform's desk only.
 * Local databases, the mock engine and a stubbed fetch; nothing is sent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-shared-key-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const ownerBefore = process.env.SUPER_ADMIN_EMAIL;
process.env.SUPER_ADMIN_EMAIL = "platform-owner@example.invalid";
test.afterAll(() => {
  if (ownerBefore == null) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = ownerBefore;
});

/* Workspace ids and slugs of this run only: the platform database may be shared with other files in the worker. */
const RUN = randomBytes(3).toString("hex");
const OLD = "old-key-id:old-key-secret";
const NEW = "new-key-id:new-key-secret";
const fingerprintOf = (value: string) => createHash("sha256").update(value).digest("hex");
const SOUL = "hf-soul-character";
const reference = "067e9e94-0bea-4acd-b82a-071a264d8e26";
const requestId = "117e9e94-0bea-4acd-b82a-071a264d8e26";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const originalFetch = globalThis.fetch;
const KEYS = ["HF_CREDENTIALS", "HF_API_KEY_ID", "HF_API_KEY_SECRET", "HF_CREDENTIALS_PREVIOUS", "HF_CREDENTIAL_ALIASES", "HF_CORRELATION_HEADER",
  "HF_SOUL_CHARACTER_ENABLED", "HF_SOUL_CHARACTER_USD_720P", "HF_SOUL_CHARACTER_USD_1080P", "HF_POOL_SIZE", "RESEND_API_KEY", "MAIL_FROM"] as const;

/* Whatever a test prints, no key or secret is ever in it. */
const printed: string[] = [];
const consoles = { log: console.log, warn: console.warn, error: console.error };
test.beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.ENGINE_MOCK = "1";
  globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); };
  printed.length = 0;
  for (const level of ["log", "warn", "error"] as const)
    console[level] = (...args: unknown[]) => { printed.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" ")); };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(console, consoles);
  for (const secret of ["old-key-secret", "new-key-secret", "old-key-id", "new-key-id", "own-key-secret"])
    expect(printed.join("\n")).not.toContain(secret);
  for (const key of KEYS) delete process.env[key];
});

async function register(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  const id = `ws_${name}_${RUN}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,8,500)",
    args: [id, `sk-${name}-${RUN}`, `Studio ${name}`, `file:${path.join(dir, `${name}.db`)}`],
  });
  await grantCredits(id, 10_000, "Test", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}
const inside = async <T>(ws: TenantWorkspace, fn: () => Promise<T>) => (await import("../../lib/tenant")).runInTenant(ws, fn);
async function metered(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
}
async function alerts() {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute("SELECT id,workspace_id,key_prefix,first_at,last_at,resolved_at FROM provider_key_alerts ORDER BY id")).rows;
}
/**
 * A Soul still sent on the key `pinned`, accepted (paid claim, request handle), its credits reserved at the
 * quoted price exactly as Generate reserves them. Under the mock engine its request is already done.
 */
async function sentStill(ws: TenantWorkspace, id: string, pinned: string, at = Date.now()) {
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  await inside(ws, async () => {
    await ready();
    const params = { soulReferenceId: reference, soulCredentialFingerprint: fingerprintOf(pinned), soulVendorCostUsd: 0.12, ratio: "3:4", resolution: "720p",
      references: [], paidClaim: at, higgsfieldStillHandle: { provider: "higgsfield", model: SOUL, ref: "mock_higgsfield_1", credentialFingerprint: fingerprintOf(pinned) } };
    await db().execute({
      sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,billed_to,task) VALUES(?,'image','higgsfield',?,'Portrait at a diner',?,'running',?,?,'higgsfield','generate')",
      args: [id, SOUL, JSON.stringify(params), at, at],
    });
    await reserveGenerationSpend({ id, kind: "image", engine: "higgsfield", model: SOUL, status: "running", engineCostUsd: 0.12 });
  });
}
async function row(ws: TenantWorkspace, id: string) {
  const { db } = await import("../../lib/db");
  const got = await inside(ws, async () => (await db().execute({ sql: "SELECT status,error,cost_usd,params FROM generations WHERE id=?", args: [id] })).rows[0]);
  return { ...got, params: JSON.parse(String(got.params)) as Record<string, unknown> };
}

/* ── Which key collects ─────────────────────────────────────────────── */

test("collection finds the key a job was sent on by its pinned fingerprint: current, previous or an operator's alias, else none", async () => {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = NEW;
  const { higgsfieldCollectionCredentials, HiggsfieldKeyChangedError, previousHiggsfieldCredentials } = await import("../../lib/higgsfield");
  expect(higgsfieldCollectionCredentials(fingerprintOf(NEW))).toMatchObject({ keyId: "new-key-id", via: "current" });
  // The old key is gone: nothing can collect for it, and nothing is asked.
  expect(() => higgsfieldCollectionCredentials(fingerprintOf(OLD))).toThrow(HiggsfieldKeyChangedError);
  for (const bad of [undefined, "", "abc", "z".repeat(64)]) expect(() => higgsfieldCollectionCredentials(bad)).toThrow(HiggsfieldKeyChangedError);
  // Kept for collection after the rotation: the old key reads what it sent, and only that.
  process.env.HF_CREDENTIALS_PREVIOUS = `${OLD}, other-id:other-secret\nmalformed`;
  expect(previousHiggsfieldCredentials().map((c) => c.keyId)).toEqual(["old-key-id", "other-id"]);
  expect(higgsfieldCollectionCredentials(fingerprintOf(OLD))).toMatchObject({ keyId: "old-key-id", keySecret: "old-key-secret", via: "previous" });
  delete process.env.HF_CREDENTIALS_PREVIOUS;
  // The operator's word that the old key was the same provider organization: the current key reads it.
  process.env.HF_CREDENTIAL_ALIASES = fingerprintOf(OLD).slice(0, 12).toUpperCase();
  expect(higgsfieldCollectionCredentials(fingerprintOf(OLD))).toMatchObject({ keyId: "new-key-id", via: "alias" });
  // An alias too short to name one key names none.
  process.env.HF_CREDENTIAL_ALIASES = fingerprintOf(OLD).slice(0, 11);
  expect(() => higgsfieldCollectionCredentials(fingerprintOf(OLD))).toThrow(HiggsfieldKeyChangedError);
  // A workspace's own key is the one sending now for it; the platform's key is found by its own fingerprint too.
  process.env.HF_CREDENTIAL_ALIASES = "";
  const ws = { ...(await register("own_key")), keys: { higgsfield: "own-key-id:own-key-secret" } };
  await inside(ws, async () => {
    expect(higgsfieldCollectionCredentials(fingerprintOf("own-key-id:own-key-secret"))).toMatchObject({ via: "current" });
    expect(higgsfieldCollectionCredentials(fingerprintOf(NEW))).toMatchObject({ keyId: "new-key-id", via: "platform" });
  });
});

test("fingerprint pinning across a rotation: status and cancel go to the provider with the key the request was accepted under; new work only with today's key", async () => {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = NEW;
  process.env.HF_SOUL_CHARACTER_ENABLED = "1";
  process.env.HF_SOUL_CHARACTER_USD_720P = "0.12"; // Synthetic test configuration, not a published vendor rate.
  process.env.HF_SOUL_CHARACTER_USD_1080P = "0.24";
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const { higgsfieldCorrelationId } = await import("../../lib/higgsfield");
  const { getModel } = await import("../../lib/models");
  const handle: RenderHandle = { provider: "higgsfield", model: SOUL, ref: requestId, endpoint: statusUrl, credentialFingerprint: fingerprintOf(OLD) };
  const calls: { url: string; auth: string | null; correlation: string | null }[] = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get("authorization"), correlation: headers.get("x-correlation-id") });
    return Response.json({ request_id: requestId, status: "in_progress" });
  };
  // Gone: nothing is asked of the provider at all.
  await expect(higgsfield.poll!(handle)).rejects.toThrow(/connection changed/);
  expect(calls).toEqual([]);
  process.env.HF_CREDENTIALS_PREVIOUS = OLD;
  expect((await higgsfield.poll!(handle)).status).toBe("running");
  expect(calls).toEqual([{ url: statusUrl, auth: "Key old-key-id:old-key-secret", correlation: higgsfieldCorrelationId(requestId, "status") }]);
  delete process.env.HF_CREDENTIALS_PREVIOUS;
  process.env.HF_CREDENTIAL_ALIASES = fingerprintOf(OLD);
  calls.length = 0;
  expect((await higgsfield.poll!(handle)).status).toBe("running");
  expect(calls[0]).toMatchObject({ auth: "Key new-key-id:new-key-secret" });
  // A video's cancel is the same kind of read-and-act on an accepted request: the pinned key, found the same way.
  const cinema = { ...handle, model: "higgsfield-cinema-studio-4.0", cancelUrl: `https://api.higgsfield.ai/requests/${requestId}/cancel` };
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get("authorization"), correlation: headers.get("x-correlation-id") });
    return new Response(null, { status: 202 });
  };
  const { isHiggsfieldVideoModel } = await import("../../lib/cinemaStudioTypes");
  expect(isHiggsfieldVideoModel(cinema.model)).toBe(true);
  await higgsfield.cancel!(cinema);
  expect(calls).toEqual([{ url: cinema.cancelUrl, auth: "Key new-key-id:new-key-secret", correlation: higgsfieldCorrelationId(requestId, "cancel") }]);
  // A previous key never sends new work: a take quoted on the old key is refused before any POST.
  process.env.HF_CREDENTIAL_ALIASES = "";
  process.env.HF_CREDENTIALS_PREVIOUS = OLD;
  calls.length = 0;
  const req: StillRenderRequest = { kind: "image", genId: "gen_old_quote", model: getModel(SOUL), prompt: "Portrait at a diner", ratio: "3:4", size: "720p",
    references: [], soulReferenceId: reference, soulCredentialFingerprint: fingerprintOf(OLD) };
  await expect(higgsfield.render(req)).rejects.toThrow(/connection changed/);
  expect(calls).toEqual([]);
});

/* ── The missing old key ────────────────────────────────────────────── */

test("the missing old key: the take waits, says so, the admin is told once; nothing is failed, refunded or sent again; the key back, it settles at the same charge", async () => {
  const { reconcileHiggsfieldImage } = await import("../../lib/renderWork");
  const { getGeneration } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const { engineTrayJob } = await import("../../lib/jobsTray");
  const { projectTakes } = await import("../../lib/workspace/takes");
  const { creditState } = await import("../../lib/credits");
  const { KEY_CHANGED, KEY_CHANGED_REASON } = await import("../../lib/sharedKeyTerms");
  const { sharedKeyDesk } = await import("../../lib/sharedKeyDesk");
  const ws = await register("gone_key");
  const id = `gen_gone_${path.basename(dir)}`;
  const output = path.join(process.cwd(), ".data", "generations", `${id}.png`);
  const engine = engineFor("higgsfield"), render = engine.render;
  let submits = 0;
  engine.render = async () => { submits++; throw new Error("never sent again"); };
  try {
    await sentStill(ws, id, OLD);
    const reserved = await metered(id);
    expect(reserved).toMatchObject({ status: "running" });
    const balance = await inside(ws, async () => (await creditState())!.balance);
    // The platform's owner hears of it by email (a stubbed mail service: nothing leaves the test).
    process.env.RESEND_API_KEY = "re_unit_test";
    process.env.MAIL_FROM = "desk@example.invalid";
    const mails: { to: string[]; subject: string; text: string }[] = [];
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("resend")) throw new Error(`Unexpected external request in test: ${url}`);
      mails.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email_unit" });
    };
    // Rotated with the old key dropped: collection asks nothing and the take waits, visibly.
    await inside(ws, () => reconcileHiggsfieldImage(id));
    let take = await row(ws, id);
    expect(take).toMatchObject({ status: "running", error: KEY_CHANGED, cost_usd: null });
    expect(take.params.providerKeyChanged).toEqual(expect.any(Number));
    expect(take.params).not.toHaveProperty("higgsfieldStillCollection");
    expect(await metered(id)).toEqual(reserved);
    expect(await inside(ws, async () => (await creditState())!.balance)).toBe(balance);
    let open = (await alerts()).filter((a) => a.id === id);
    expect(open).toEqual([{ id, workspace_id: ws.id, key_prefix: fingerprintOf(OLD).slice(0, 12), first_at: expect.any(Number), last_at: expect.any(Number), resolved_at: null }]);
    const first = open[0].first_at;
    // Asked again later: still one alert, from the same moment; nothing else moved.
    await inside(ws, () => reconcileHiggsfieldImage(id));
    open = (await alerts()).filter((a) => a.id === id);
    expect(open).toHaveLength(1);
    expect(open[0].first_at).toBe(first);
    expect(await metered(id)).toEqual(reserved);
    // Told once, with what to do: the key's prefix and the settings by name; never a key.
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: ["platform-owner@example.invalid"], subject: expect.stringContaining("provider key that changed") });
    expect(mails[0].text).toContain(fingerprintOf(OLD).slice(0, 12));
    expect(mails[0].text).toMatch(/HF_CREDENTIALS_PREVIOUS.*HF_CREDENTIAL_ALIASES/);
    expect(JSON.stringify(mails)).not.toMatch(/secret|old-key-id|new-key-id/);
    globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); };
    // What a member sees: the take is checking, in the tray and in Takes, never failed; no key, fingerprint or handle.
    const gen = (await inside(ws, () => getGeneration(id)))!;
    for (const key of ["higgsfieldStillHandle", "soulCredentialFingerprint", "soulVendorCostUsd", "paidClaim"]) expect(gen.params).not.toHaveProperty(key);
    expect(JSON.stringify(gen)).not.toContain(fingerprintOf(OLD).slice(0, 12));
    const tray = engineTrayJob({ id: gen.id, status: gen.status, kind: gen.kind, model: gen.model, prompt: gen.prompt, title: gen.title ?? null, params: gen.params,
      storedUrl: gen.storedUrl, error: gen.error, createdAt: gen.createdAt, settledAt: null, projectName: null }, { unit: "cr", reserved: Number(reserved.billed_credits), charged: null, needs: null });
    expect(tray).toMatchObject({ stage: "confirming", label: "Checking", tone: "amber", reason: KEY_CHANGED_REASON, price: { amount: Number(reserved.billed_credits), unit: "cr" }, action: null });
    expect(projectTakes([{ origin: "generation", value: gen }])[0]).toMatchObject({ status: "rendering", reason: KEY_CHANGED_REASON, credits: null });
    // The platform's desk lists it, by workspace and a key prefix; never a key.
    const desk = await sharedKeyDesk();
    expect(desk.keyChanges.filter((k) => k.take === id)).toEqual([{ take: id, workspace: "Studio gone_key", key: fingerprintOf(OLD).slice(0, 12), since: first, lastAt: expect.any(Number) }]);
    expect(JSON.stringify(desk)).not.toMatch(/secret|old-key-id|new-key-id/);
    // The operator keeps the old key for collection: the take is collected and settles at the price it was quoted.
    process.env.HF_CREDENTIALS_PREVIOUS = OLD;
    await inside(ws, () => reconcileHiggsfieldImage(id));
    take = await row(ws, id);
    expect(take).toMatchObject({ status: "succeeded", cost_usd: 0.12 });
    expect(take.params).not.toHaveProperty("providerKeyChanged");
    expect(await metered(id)).toMatchObject({ status: "succeeded", engine_cost_usd: 0.12, billed_credits: reserved.billed_credits });
    expect(await inside(ws, async () => (await creditState())!.balance)).toBe(balance);
    expect((await alerts()).find((a) => a.id === id)?.resolved_at).toEqual(expect.any(Number));
    expect((await sharedKeyDesk()).keyChanges.filter((k) => k.take === id)).toEqual([]);
    expect(submits).toBe(0);
  } finally {
    engine.render = render;
    await unlink(output).catch(() => {});
  }
});

test("a still whose key never comes back ends only once the provider no longer keeps it, its charge kept, and is never sent again", async () => {
  const { reconcileHiggsfieldImage } = await import("../../lib/renderWork");
  const { syncPending } = await import("../../lib/jobs");
  const { KEY_GONE_END, KEY_GONE_MS } = await import("../../lib/higgsfieldKeyAlerts");
  const { db } = await import("../../lib/db");
  const { engineFor } = await import("../../lib/engines");
  const ws = await register("never_back");
  const engine = engineFor("higgsfield"), render = engine.render;
  let submits = 0;
  engine.render = async () => { submits++; throw new Error("never sent again"); };
  try {
    await sentStill(ws, "gen_never_back", OLD);
    const reserved = await metered("gen_never_back");
    await inside(ws, () => reconcileHiggsfieldImage("gen_never_back"));
    // A day later it is still waiting: a failing-collection clock does not apply to a key that is gone.
    await inside(ws, () => db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.providerKeyChanged',?) WHERE id='gen_never_back'", args: [Date.now() - 2 * 86_400_000] }));
    await inside(ws, () => syncPending());
    expect(await row(ws, "gen_never_back")).toMatchObject({ status: "running" });
    // Past the time the provider keeps what it made: ended, the accepted request's charge kept, exactly as quoted.
    await inside(ws, () => db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.providerKeyChanged',?) WHERE id='gen_never_back'", args: [Date.now() - KEY_GONE_MS - 60_000] }));
    await inside(ws, () => syncPending());
    const ended = await row(ws, "gen_never_back");
    expect(ended).toMatchObject({ status: "failed", error: KEY_GONE_END, cost_usd: 0.12 });
    expect(await metered("gen_never_back")).toMatchObject({ status: "failed", engine_cost_usd: 0.12, billed_credits: reserved.billed_credits });
    expect((await alerts()).find((a) => a.id === "gen_never_back")?.resolved_at).toEqual(expect.any(Number));
    expect(submits).toBe(0);
  } finally { engine.render = render; }
});

test("a video sent on a key that is gone waits the same way; the operator's alias lets today's key read it again", async () => {
  const { reconcileGenjutsuVideo } = await import("../../lib/genjutsuVideo");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { db, ready } = await import("../../lib/db");
  const { KEY_CHANGED } = await import("../../lib/sharedKeyTerms");
  const { CINEMA_STUDIO_MODEL_ID } = await import("../../lib/cinemaStudioTypes");
  const ws = await register("gone_video");
  const id = "gen_gone_video";
  const at = Date.now();
  await inside(ws, async () => {
    await ready();
    const handle = { provider: "higgsfield", model: CINEMA_STUDIO_MODEL_ID, ref: `mock_higgsfield_${at + 3_600_000}`, credentialFingerprint: fingerprintOf(OLD) };
    await db().execute({
      sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,billed_to,task) VALUES(?,'video','higgsfield',?,'A harbour at dawn',?,'running',?,?,'higgsfield','generate')",
      args: [id, CINEMA_STUDIO_MODEL_ID, JSON.stringify({ duration: 5, ratio: "16:9", resolution: "720p", paidClaim: at, higgsfieldVideoHandle: handle,
        higgsfieldCredentialFingerprint: fingerprintOf(OLD), higgsfieldVendorCostUsd: 0.5 }), at, at],
    });
    await reserveGenerationSpend({ id, kind: "video", engine: "higgsfield", model: CINEMA_STUDIO_MODEL_ID, status: "running", engineCostUsd: 0.5 });
  });
  const reserved = await metered(id);
  await inside(ws, () => reconcileGenjutsuVideo(id));
  let take = await row(ws, id);
  expect(take).toMatchObject({ status: "running", error: KEY_CHANGED });
  expect(take.params.providerKeyChanged).toEqual(expect.any(Number));
  expect(await metered(id)).toEqual(reserved);
  expect((await alerts()).filter((a) => a.id === id && a.resolved_at == null)).toHaveLength(1);
  // Same provider organization, says the operator: today's key reads it, and the wait is over.
  process.env.HF_CREDENTIAL_ALIASES = fingerprintOf(OLD).slice(0, 16);
  await inside(ws, () => reconcileGenjutsuVideo(id));
  take = await row(ws, id);
  expect(take).toMatchObject({ status: "queued", error: null });
  expect(take.params).not.toHaveProperty("providerKeyChanged");
  expect((await alerts()).find((a) => a.id === id)?.resolved_at).toEqual(expect.any(Number));
  expect(await metered(id)).toEqual(reserved);
});

/* ── Correlation ids ────────────────────────────────────────────────── */

test("X-Correlation-ID: sent beside the key, the provider's own kept beside request_id (ours when it sends none), and the switch stops ours", async () => {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = NEW;
  process.env.HF_SOUL_CHARACTER_ENABLED = "1";
  process.env.HF_SOUL_CHARACTER_USD_720P = "0.12";
  process.env.HF_SOUL_CHARACTER_USD_1080P = "0.24";
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const { higgsfieldCorrelationId, higgsfieldKeyHeaders, higgsfieldCredentials } = await import("../../lib/higgsfield");
  const { getModel } = await import("../../lib/models");
  const req: StillRenderRequest = { kind: "image", genId: "gen_correlated", model: getModel(SOUL), prompt: "Portrait at a diner", ratio: "3:4", size: "720p",
    references: [], soulReferenceId: reference, soulCredentialFingerprint: fingerprintOf(NEW) };
  const ours = higgsfieldCorrelationId("gen_correlated", "submit");
  // Fixed per job and purpose, so a request whose answer was lost can still be traced; never a key or a fingerprint.
  expect(ours).toBe(higgsfieldCorrelationId("gen_correlated", "submit"));
  expect(ours).not.toBe(higgsfieldCorrelationId("gen_correlated", "status"));
  expect(ours).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ours).not.toContain(fingerprintOf(NEW).slice(0, 8));
  const sent: (string | null)[] = [];
  let answer: string | null = "corr-7f3a9c2e-provider";
  globalThis.fetch = async (_url, init) => {
    sent.push(new Headers(init?.headers).get("x-correlation-id"));
    return Response.json({ request_id: requestId, status: "queued", status_url: statusUrl }, { headers: answer ? { "X-Correlation-ID": answer } : {} });
  };
  let out = await higgsfield.render(req);
  expect(sent).toEqual([ours]);
  expect("handle" in out && out.handle).toMatchObject({ ref: requestId, correlationId: "corr-7f3a9c2e-provider" });
  // No id of its own in the answer: ours is kept, the one the provider was sent.
  answer = null;
  out = await higgsfield.render(req);
  expect("handle" in out && out.handle.correlationId).toBe(ours);
  // An unusable header is never stored.
  answer = "x".repeat(200);
  out = await higgsfield.render(req);
  expect("handle" in out && out.handle.correlationId).toBe(ours);
  // Switched off: ours stops going out; the provider's own is still kept.
  process.env.HF_CORRELATION_HEADER = "off";
  sent.length = 0;
  answer = "corr-provider-only";
  out = await higgsfield.render(req);
  expect(sent).toEqual([null]);
  expect("handle" in out && out.handle.correlationId).toBe("corr-provider-only");
  answer = null;
  out = await higgsfield.render(req);
  expect("handle" in out && out.handle).not.toHaveProperty("correlationId");
  delete process.env.HF_CORRELATION_HEADER;
  // The headers carry the key and the id; no other custom header.
  expect(higgsfieldKeyHeaders(higgsfieldCredentials(), { correlationId: ours, json: false })).toEqual({ Authorization: "Key new-key-id:new-key-secret", "X-Correlation-ID": ours });
});

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) =>
    name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts")) : nodeRequire(name), target, target.exports);
  return target.exports as T;
}

test("the correlation id is stored beside request_id and shown to the platform's owner only: never in a member's take, tray or export", async () => {
  const { produce, loadJob } = await import("../../lib/renderWork");
  const { getGeneration } = await import("../../lib/jobs");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  const { higgsfieldCorrelationId } = await import("../../lib/higgsfield");
  const { MARKETING_IMAGE_MODEL_ID } = await import("../../lib/models");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await register("correlated");
  const id = "gen_marketing_correlated";
  // A Marketing Studio still sent through the ordinary render path (the mock engine answers it).
  await inside(ws, async () => {
    const { ready, now } = await import("../../lib/db");
    await ready();
    const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
    await db().execute({
      sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,billed_to,task) VALUES(?,'image','higgsfield',?,'A bottle on a plinth',?,'running',?,?,'higgsfield','generate')",
      args: [id, MARKETING_IMAGE_MODEL_ID, JSON.stringify({ ratio: "3:4", resolution: "2k", references: [], marketing: { quality: "high", enhancePrompt: false },
        higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: 0.25 }), now(), now()],
    });
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    await reserveGenerationSpend({ id, kind: "image", engine: "higgsfield", model: MARKETING_IMAGE_MODEL_ID, status: "running", engineCostUsd: 0.25 });
    await produce((await loadJob(id))!);
  });
  const ours = higgsfieldCorrelationId(id, "submit");
  const stored = await row(ws, id);
  // In the take's own record and in the platform's receipt: the request id and, beside it, its correlation id.
  expect(stored.params.higgsfieldStillHandle).toMatchObject({ ref: expect.stringMatching(/^mock_higgsfield_/), correlationId: ours });
  const receipt = (await platformDb().execute({ sql: "SELECT handle_json FROM higgsfield_generation_receipts WHERE id=?", args: [id] })).rows[0];
  const handle = JSON.parse(String(receipt.handle_json)) as RenderHandle;
  expect(handle).toMatchObject({ provider: "higgsfield", ref: expect.stringMatching(/^mock_higgsfield_/), correlationId: ours });
  // A member's view of the take carries neither the request handle nor its correlation id.
  const gen = (await inside(ws, () => getGeneration(id)))!;
  expect(JSON.stringify(gen)).not.toContain(ours);
  expect(JSON.stringify(gen)).not.toContain(handle.ref);
  // The workspace's export strips them too.
  const { workspaceExport } = await import("../../lib/workspaceExport");
  const dump = JSON.stringify(await inside(ws, () => workspaceExport("owner", "owner@example.invalid")));
  expect(dump).toContain(id);
  expect(dump).not.toContain(ours);
  expect(dump).not.toContain(handle.ref);
  // The platform's desk: the owner reads request_id and correlation id; a workspace admin, an API token, nobody else.
  const route = load<{ GET(): Promise<Response> }>("app/api/admin/shared-key/route.ts");
  const person = (email: string) => ({ id: email, email, name: email, role: "admin" as const, owner: true, disabled: false, createdAt: 0, lastSeen: null });
  const asOwner = await runInTenant(ws, () => route.GET(), { user: person("platform-owner@example.invalid") });
  expect(asOwner.status).toBe(200);
  expect(asOwner.headers.get("cache-control")).toBe("private, no-store");
  const desk = await asOwner.json();
  expect(desk.requests).toContainEqual(expect.objectContaining({ take: id, workspace: "Studio correlated", requestId: handle.ref, correlationId: ours, key: "platform", settled: false }));
  expect(desk.correlationSent).toBe(true);
  expect(JSON.stringify(desk)).not.toMatch(/particl-mock|Key |secret|usd|Usd|cost/i);
  const asAdmin = await runInTenant(ws, () => route.GET(), { user: person("studio-admin@example.invalid") });
  expect(asAdmin.status).toBe(403);
  expect(JSON.stringify(await asAdmin.json())).not.toContain(ours);
  const asToken = await runInTenant(ws, () => route.GET(), { user: person("platform-owner@example.invalid"), token: { id: "tok", capUsd: null } } as never);
  expect(asToken.status).toBe(403);
});
